// Regression tests for the Auto Sync failure modes that silently left a
// product's tag contradicting its real inventory.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./support/fake-db.mjs";

// The retry backoff unrefs its timer so a pending retry can never hold a real
// server open on shutdown. In tests that timer is the only pending work, so the
// loop would drain mid-retry; a ref'd heartbeat keeps the process alive.
let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 50);
});
after(() => {
  clearInterval(keepAlive);
});

const QUERY_MARKER = "getProductForInventoryItem";
const ADD_MARKER = "addOutOfStockTag";
const REMOVE_MARKER = "removeOutOfStockTag";

// Shopify answers a throttle with HTTP 200 and a top-level `errors` array and no
// `data` — not a 429. That is what made it so easy to mistake for success.
const throttled = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 1000 } } },
  }),
});

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

const productPayload = ({ tags = [], totalInventory = 0 }) => ({
  inventoryItem: {
    variant: {
      product: {
        id: "gid://shopify/Product/999",
        status: "ACTIVE",
        tags,
        totalInventory,
        tracksInventory: true,
      },
    },
  },
});

describe("Auto Sync resilience", () => {
  let inventoryTags;
  let webhookRoute;
  let fakeShopifyServer;

  beforeEach(async () => {
    resetDb();
    inventoryTags = await import("../app/services/inventory-tags.server.js");
    webhookRoute = await import("../app/routes/webhooks.inventory_levels.update.jsx");
    fakeShopifyServer = await import("./support/fake-shopify-server.mjs");
  });

  async function runWebhook(shop, graphql) {
    fakeShopifyServer.setWebhookResult({
      shop,
      topic: "inventory_levels/update",
      payload: { inventory_item_id: 12345 },
      admin: { graphql },
    });
    return webhookRoute.action({ request: new Request("http://localhost/webhooks") });
  }

  describe("throttling must not silently drop an inventory change", () => {
    it("retries a throttled product lookup instead of giving up on the first try", async () => {
      const shop = "throttle-query.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      let queryAttempts = 0;
      const response = await runWebhook(shop, async (query) => {
        if (query.includes(QUERY_MARKER)) {
          queryAttempts += 1;
          // Throttled once, then succeeds — exactly the transient case.
          return queryAttempts === 1 ? throttled() : ok(productPayload({ totalInventory: 0 }));
        }
        return ok({ tagsAdd: { userErrors: [] } });
      });

      assert.equal(queryAttempts, 2, "a throttled lookup must be retried");
      assert.equal(response.status, 200);
    });

    it("returns a retryable status so Shopify redelivers when throttling never clears", async () => {
      const shop = "throttle-persistent.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      const response = await runWebhook(shop, async () => throttled());

      // A 200 here is the original bug: Shopify considers the webhook handled,
      // never redelivers, and the product keeps a tag that contradicts stock.
      assert.equal(response.status, 500, "must ask Shopify to redeliver");
    });

    it("does not report a throttled tag mutation as a successful tag write", async () => {
      const shop = "throttle-mutation.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      const response = await runWebhook(shop, async (query) => {
        if (query.includes(QUERY_MARKER)) return ok(productPayload({ totalInventory: 0 }));
        return throttled(); // the tagsAdd never lands
      });

      assert.equal(response.status, 500, "a dropped tag write must be redelivered");
    });
  });

  describe("permanent errors must not trigger a redelivery storm", () => {
    it("accepts the webhook when the failure is not retryable", async () => {
      const shop = "fatal-error.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      const response = await runWebhook(shop, async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          errors: [{ message: "Access denied for inventoryItem field" }],
        }),
      }));

      // Shopify retries a non-2xx 19 times over 48h and can drop the
      // subscription; a bad query or revoked scope must not go down that path.
      assert.equal(response.status, 200);
    });
  });

  describe("concurrent webhooks for one product", () => {
    it("serializes overlapping handlers so the freshest read wins", async () => {
      const shop = "concurrent.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      // Simulated store state. The restock lands first, the sale second; the
      // tag must end up reflecting the sale (0 units => tagged).
      let inventory = 5;
      let tags = ["out-of-stock-hidden"];
      const mutations = [];

      const makeGraphql = (quantityAfterThisWebhook) => async (query) => {
        if (query.includes(QUERY_MARKER)) {
          // Reading the live state is the whole point: a handler that queued
          // behind another must observe that one's tag write.
          inventory = quantityAfterThisWebhook;
          return ok(productPayload({ tags: [...tags], totalInventory: inventory }));
        }
        if (query.includes(ADD_MARKER)) {
          mutations.push("add");
          if (!tags.includes("out-of-stock-hidden")) tags.push("out-of-stock-hidden");
          return ok({ tagsAdd: { userErrors: [] } });
        }
        if (query.includes(REMOVE_MARKER)) {
          mutations.push("remove");
          tags = tags.filter((t) => t !== "out-of-stock-hidden");
          return ok({ tagsRemove: { userErrors: [] } });
        }
        return ok({});
      };

      // Fire both webhooks without awaiting the first: this is what Shopify does
      // for a multi-variant product.
      const restock = runWebhook(shop, makeGraphql(5));
      const sale = runWebhook(shop, makeGraphql(0));
      await Promise.all([restock, sale]);

      assert.deepEqual(mutations, ["remove", "add"], "both decisions applied in order");
      assert.deepEqual(tags, ["out-of-stock-hidden"], "final tag matches final stock of 0");
    });
  });

  describe("resolveTagAction guards", () => {
    const TAG = "out-of-stock-hidden";

    it("does not tag a tracked product whose quantity is missing", () => {
      // `null < 1` is true in JS, so a null quantity used to tag an in-stock
      // product as out of stock.
      for (const quantity of [null, undefined, NaN, "abc"]) {
        assert.equal(
          inventoryTags.resolveTagAction({
            status: "ACTIVE",
            tags: [],
            quantity,
            tracked: true,
            tagName: TAG,
          }),
          null,
          `quantity ${String(quantity)} must not produce a tag action`,
        );
      }
    });

    it("tolerates a missing tags array", () => {
      assert.equal(
        inventoryTags.resolveTagAction({
          status: "ACTIVE",
          tags: undefined,
          quantity: 0,
          tracked: true,
          tagName: TAG,
        }),
        "add",
      );
    });
  });
});
