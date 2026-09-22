import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDb } from "./support/fake-db.mjs";

describe("Auto Sync Settings & Tagging Logic", () => {
  let inventoryTags;

  beforeEach(async () => {
    resetDb();
    inventoryTags = await import("../app/services/inventory-tags.server.js");
  });

  describe("getSettings and setSettings", () => {
    it("returns defaults when no settings exist", async () => {
      const settings = await inventoryTags.getSettings("test-shop.myshopify.com");
      assert.equal(settings.tagName, "out-of-stock-hidden");
      assert.equal(settings.autoSyncEnabled, false);
    });

    it("can toggle autoSyncEnabled on and off", async () => {
      const shop = "test-shop.myshopify.com";

      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });
      let settings = await inventoryTags.getSettings(shop);
      assert.equal(settings.autoSyncEnabled, true);
      assert.equal(settings.tagName, "out-of-stock-hidden");

      await inventoryTags.setSettings(shop, { autoSyncEnabled: false });
      settings = await inventoryTags.getSettings(shop);
      assert.equal(settings.autoSyncEnabled, false);
    });

    it("can update tagName without affecting autoSyncEnabled", async () => {
      const shop = "test-shop.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true });

      await inventoryTags.setSettings(shop, { tagName: "sold-out" });
      const settings = await inventoryTags.getSettings(shop);
      assert.equal(settings.autoSyncEnabled, true);
      assert.equal(settings.tagName, "sold-out");
    });

    it("getTagName and setTagName maintain backward compatibility", async () => {
      const shop = "test-shop.myshopify.com";
      assert.equal(await inventoryTags.getTagName(shop), "out-of-stock-hidden");

      await inventoryTags.setTagName(shop, "backorder-only");
      assert.equal(await inventoryTags.getTagName(shop), "backorder-only");
    });
  });

  describe("resolveTagAction rules", () => {
    const TAG = "out-of-stock-hidden";

    it("adds tag when quantity < 1 and product does not have tag", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: [],
        quantity: 0,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(action, "add");
    });

    it("adds tag when quantity is negative and product does not have tag", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: ["featured"],
        quantity: -3,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(action, "add");
    });

    it("returns null when quantity < 1 and tag is already present", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: [TAG],
        quantity: 0,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(action, null);
    });

    it("removes tag when quantity > 0 and tag is present", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: [TAG, "shoes"],
        quantity: 5,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(action, "remove");
    });

    it("returns null when quantity > 0 and tag is not present", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: ["shoes"],
        quantity: 5,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(action, null);
    });

    it("never modifies inactive products (status !== ACTIVE)", () => {
      const draftWithZero = inventoryTags.resolveTagAction({
        status: "DRAFT",
        tags: [],
        quantity: 0,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(draftWithZero, null);

      const archivedWithTag = inventoryTags.resolveTagAction({
        status: "ARCHIVED",
        tags: [TAG],
        quantity: 10,
        tracked: true,
        tagName: TAG,
      });
      assert.equal(archivedWithTag, null);
    });

    it("removes tag from untracked products if present", () => {
      const action = inventoryTags.resolveTagAction({
        status: "ACTIVE",
        tags: [TAG],
        quantity: 0,
        tracked: false,
        tagName: TAG,
      });
      assert.equal(action, "remove");
    });
  });

  describe("webhooks.inventory_levels.update handler", () => {
    let webhookRoute;
    let fakeShopifyServer;

    beforeEach(async () => {
      webhookRoute = await import("../app/routes/webhooks.inventory_levels.update.jsx");
      fakeShopifyServer = await import("./support/fake-shopify-server.mjs");
    });

    it("skips inventory update when autoSyncEnabled is false", async () => {
      const shop = "webhook-disabled.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: false });

      let graphqlCalled = false;
      const fakeAdmin = {
        graphql: async () => {
          graphqlCalled = true;
          return { ok: true, json: async () => ({}) };
        },
      };

      fakeShopifyServer.setWebhookResult({
        shop,
        topic: "inventory_levels/update",
        payload: { inventory_item_id: 12345 },
        admin: fakeAdmin,
      });

      const response = await webhookRoute.action({ request: new Request("http://localhost/webhooks") });
      assert.equal(response.status, 200);
      assert.equal(graphqlCalled, false, "admin.graphql should NOT be called when auto sync is disabled");
    });

    it("processes inventory update when autoSyncEnabled is true", async () => {
      const shop = "webhook-enabled.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true, tagName: "out-of-stock-hidden" });

      const graphqlCalls = [];
      const fakeAdmin = {
        graphql: async (query, { variables }) => {
          graphqlCalls.push({ query, variables });
          if (query.includes("query getProductForInventoryItem")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  inventoryItem: {
                    variant: {
                      product: {
                        id: "gid://shopify/Product/999",
                        status: "ACTIVE",
                        tags: [],
                        totalInventory: 0,
                        tracksInventory: true,
                      },
                    },
                  },
                },
              }),
            };
          }
          if (query.includes("mutation addOutOfStockTag")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  tagsAdd: { userErrors: [] },
                },
              }),
            };
          }
          return { ok: true, json: async () => ({}) };
        },
      };

      fakeShopifyServer.setWebhookResult({
        shop,
        topic: "inventory_levels/update",
        payload: { inventory_item_id: 12345 },
        admin: fakeAdmin,
      });

      const response = await webhookRoute.action({ request: new Request("http://localhost/webhooks") });
      assert.equal(response.status, 200);
      assert.equal(graphqlCalls.length, 2, "Should query product and add tag mutation");
      assert.equal(graphqlCalls[1].variables.id, "gid://shopify/Product/999");
      assert.deepEqual(graphqlCalls[1].variables.tags, ["out-of-stock-hidden"]);
    });
  });

  describe("webhooks.products.create handler (Product Import)", () => {
    let productCreateRoute;
    let fakeShopifyServer;

    beforeEach(async () => {
      productCreateRoute = await import("../app/routes/webhooks.products.create.jsx");
      fakeShopifyServer = await import("./support/fake-shopify-server.mjs");
    });

    it("automatically tags newly imported product if inventory is 0 and auto-sync is on", async () => {
      const shop = "import-zero-inv.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true, tagName: "out-of-stock-hidden" });

      const graphqlCalls = [];
      const fakeAdmin = {
        graphql: async (query, { variables }) => {
          graphqlCalls.push({ query, variables });
          if (query.includes("query getProductForImport")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  product: {
                    id: "gid://shopify/Product/8888",
                    status: "ACTIVE",
                    tags: [],
                    totalInventory: 0,
                    tracksInventory: true,
                  },
                },
              }),
            };
          }
          if (query.includes("mutation addOutOfStockTag")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  tagsAdd: { userErrors: [] },
                },
              }),
            };
          }
          return { ok: true, json: async () => ({}) };
        },
      };

      fakeShopifyServer.setWebhookResult({
        shop,
        topic: "products/create",
        payload: { id: 8888 },
        admin: fakeAdmin,
      });

      const response = await productCreateRoute.action({ request: new Request("http://localhost/webhooks") });
      assert.equal(response.status, 200);
      assert.equal(graphqlCalls.length, 2, "Should query imported product and add tag mutation");
      assert.equal(graphqlCalls[1].variables.id, "gid://shopify/Product/8888");
      assert.deepEqual(graphqlCalls[1].variables.tags, ["out-of-stock-hidden"]);
    });

    it("does not tag imported product if inventory > 0", async () => {
      const shop = "import-in-stock.myshopify.com";
      await inventoryTags.setSettings(shop, { autoSyncEnabled: true, tagName: "out-of-stock-hidden" });

      const graphqlCalls = [];
      const fakeAdmin = {
        graphql: async (query, { variables }) => {
          graphqlCalls.push({ query, variables });
          return {
            ok: true,
            json: async () => ({
              data: {
                product: {
                  id: "gid://shopify/Product/7777",
                  status: "ACTIVE",
                  tags: [],
                  totalInventory: 15,
                  tracksInventory: true,
                },
              },
            }),
          };
        },
      };

      fakeShopifyServer.setWebhookResult({
        shop,
        topic: "products/create",
        payload: { id: 7777 },
        admin: fakeAdmin,
      });

      const response = await productCreateRoute.action({ request: new Request("http://localhost/webhooks") });
      assert.equal(response.status, 200);
      assert.equal(graphqlCalls.length, 1, "Should only query product and NOT call mutation");
    });
  });
});


