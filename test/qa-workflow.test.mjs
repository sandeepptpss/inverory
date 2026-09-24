// End-to-end QA pass over the inventory sync workflow:
//   * Automatic Sync ON/OFF gating, for both webhook topics
//   * tag settings (custom names, validation, propagation)
//   * both automation rules across the full product matrix
//   * Manual Full Catalog Sync: progress, status, counts, duration
//   * the product states a merchant actually has: 0 / >0 stock, draft,
//     archived, untracked
//
// The Admin API doubles hold real product rows, so assertions are about the
// tag state a merchant would see rather than about which calls were made.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Read at module load by the sync service.
process.env.BULK_SYNC_POLL_MS = "5";
process.env.BULK_SYNC_PROGRESS_BATCH = "100";
process.env.BULK_SYNC_LEASE_MS = "30000";

import { ShopifySimulator } from "./support/shopify-simulator.mjs";
import { resetDb } from "./support/fake-db.mjs";
import { FakeAdmin } from "./support/fake-admin.mjs";
import { setAdmin, setWebhookResult } from "./support/fake-shopify-server.mjs";

const TAG = "out-of-stock-hidden";

let shopCounter = 0;
const nextShop = (name) => `qa-${name}-${++shopCounter}.myshopify.com`;

let tags;
let bulkSync;
let status;
let inventoryWebhook;
let productCreateWebhook;

// Retry backoffs use unref'd timers so a pending sleep never holds a shutdown
// open. In production the HTTP server keeps the loop alive; here nothing does,
// so a test that waits on a backoff would exit mid-await.
let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1_000);
});
after(() => clearInterval(keepAlive));

before(async () => {
  tags = await import("../app/services/inventory-tags.server.js");
  bulkSync = await import("../app/services/bulk-sync.server.js");
  status = await import("../app/lib/bulk-sync-status.js");
  inventoryWebhook = await import("../app/routes/webhooks.inventory_levels.update.jsx");
  productCreateWebhook = await import("../app/routes/webhooks.products.create.jsx");
});

const request = () => new Request("http://localhost/webhooks");

/** Delivers an inventory_levels/update webhook for one inventory item. */
async function deliverInventoryWebhook(shop, admin, inventoryItemId) {
  setWebhookResult({
    shop,
    topic: "inventory_levels/update",
    payload: { inventory_item_id: inventoryItemId },
    admin,
  });
  return inventoryWebhook.action({ request: request() });
}

async function deliverProductCreateWebhook(shop, admin, productId) {
  setWebhookResult({
    shop,
    topic: "products/create",
    payload: { id: productId },
    admin,
  });
  return productCreateWebhook.action({ request: request() });
}

function product(overrides) {
  return {
    id: "gid://shopify/Product/1",
    status: "ACTIVE",
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    inventoryItemIds: [100],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Automation rules — the decision table
// ---------------------------------------------------------------------------

describe("automation rules: the decision table", () => {
  const cases = [
    // [name, product state, expected action]
    ["Rule 1 — active, tracked, 0 stock, untagged → add", { quantity: 0, tags: [] }, "add"],
    ["Rule 1 — oversold (negative stock) → add", { quantity: -4, tags: [] }, "add"],
    ["Rule 1 — already tagged → no-op", { quantity: 0, tags: [TAG] }, null],
    ["Rule 2 — active, tracked, in stock, tagged → remove", { quantity: 9, tags: [TAG] }, "remove"],
    ["Rule 2 — exactly 1 in stock is in stock", { quantity: 1, tags: [TAG] }, "remove"],
    ["Rule 2 — in stock and untagged → no-op", { quantity: 9, tags: ["sale"] }, null],
    ["draft, 0 stock → never touched", { status: "DRAFT", quantity: 0, tags: [] }, null],
    ["draft, tagged, in stock → never touched", { status: "DRAFT", quantity: 5, tags: [TAG] }, null],
    ["archived, 0 stock → never touched", { status: "ARCHIVED", quantity: 0, tags: [] }, null],
    ["archived, tagged, in stock → never touched", { status: "ARCHIVED", quantity: 5, tags: [TAG] }, null],
    ["untracked, 0 stock, untagged → never tagged", { tracked: false, quantity: 0, tags: [] }, null],
    ["untracked but carrying the tag → tag removed", { tracked: false, quantity: 0, tags: [TAG] }, "remove"],
  ];

  for (const [name, state, expected] of cases) {
    it(name, () => {
      assert.equal(
        tags.resolveTagAction({
          status: state.status ?? "ACTIVE",
          tags: state.tags,
          quantity: state.quantity,
          tracked: state.tracked ?? true,
          tagName: TAG,
        }),
        expected,
      );
    });
  }

  it("ignores a quantity Shopify could not report", () => {
    for (const quantity of [null, undefined, NaN, "", "  ", [], {}, true]) {
      assert.equal(
        tags.resolveTagAction({
          status: "ACTIVE",
          tags: [],
          quantity,
          tracked: true,
          tagName: TAG,
        }),
        null,
        `quantity ${JSON.stringify(quantity)} must not drive a tag decision`,
      );
    }
  });

  it("accepts a numeric quantity delivered as a string", () => {
    assert.equal(
      tags.resolveTagAction({ status: "ACTIVE", tags: [], quantity: "0", tracked: true, tagName: TAG }),
      "add",
    );
    assert.equal(
      tags.resolveTagAction({ status: "ACTIVE", tags: [TAG], quantity: "7", tracked: true, tagName: TAG }),
      "remove",
    );
  });

  it("tolerates a missing tags array", () => {
    assert.equal(
      tags.resolveTagAction({ status: "ACTIVE", tags: undefined, quantity: 0, tracked: true, tagName: TAG }),
      "add",
    );
  });

  // Shopify compares tags case-insensitively: a product tagged "Out-Of-Stock"
  // already carries "out-of-stock" as far as the store is concerned.
  describe("tag matching follows Shopify's case-insensitive semantics", () => {
    it("does not re-add a tag that differs only by case", () => {
      assert.equal(
        tags.resolveTagAction({
          status: "ACTIVE",
          tags: ["Out-Of-Stock-Hidden"],
          quantity: 0,
          tracked: true,
          tagName: TAG,
        }),
        null,
      );
    });

    it("removes a differently-cased tag when the product is restocked", () => {
      assert.equal(
        tags.resolveTagAction({
          status: "ACTIVE",
          tags: ["OUT-OF-STOCK-HIDDEN", "sale"],
          quantity: 12,
          tracked: true,
          tagName: TAG,
        }),
        "remove",
      );
    });

    it("ignores stray whitespace around a stored tag", () => {
      assert.equal(
        tags.resolveTagAction({
          status: "ACTIVE",
          tags: [" out-of-stock-hidden "],
          quantity: 12,
          tracked: true,
          tagName: TAG,
        }),
        "remove",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Tag settings
// ---------------------------------------------------------------------------

describe("tag settings", () => {
  it("defaults to out-of-stock-hidden with auto sync off", async () => {
    resetDb();
    const settings = await tags.getSettings(nextShop("defaults"));
    assert.equal(settings.tagName, TAG);
    assert.equal(settings.autoSyncEnabled, false);
  });

  it("keeps the tag name when only the toggle changes, and vice versa", async () => {
    resetDb();
    const shop = nextShop("settings");
    await tags.setSettings(shop, { tagName: "sold-out", autoSyncEnabled: true });

    await tags.setSettings(shop, { autoSyncEnabled: false });
    assert.deepEqual(await tags.getSettings(shop), {
      tagName: "sold-out",
      autoSyncEnabled: false,
      collectionId: null,
      collectionTitle: null,
    });

    await tags.setSettings(shop, { tagName: "backorder" });
    assert.deepEqual(await tags.getSettings(shop), {
      tagName: "backorder",
      autoSyncEnabled: false,
      collectionId: null,
      collectionTitle: null,
    });
  });

  it("keeps each shop's settings separate", async () => {
    resetDb();
    const a = nextShop("tenant-a");
    const b = nextShop("tenant-b");
    await tags.setSettings(a, { tagName: "a-tag", autoSyncEnabled: true });
    await tags.setSettings(b, { tagName: "b-tag", autoSyncEnabled: false });

    assert.deepEqual(await tags.getSettings(a), {
      tagName: "a-tag",
      autoSyncEnabled: true,
      collectionId: null,
      collectionTitle: null,
    });
    assert.deepEqual(await tags.getSettings(b), {
      tagName: "b-tag",
      autoSyncEnabled: false,
      collectionId: null,
      collectionTitle: null,
    });
  });

  describe("validation", () => {
    it("accepts an ordinary tag and trims it", () => {
      assert.deepEqual(tags.normalizeTagName("  sold-out  "), { ok: true, tagName: "sold-out" });
    });

    it("rejects an empty or whitespace-only tag", () => {
      for (const value of ["", "   ", null, undefined]) {
        assert.equal(tags.normalizeTagName(value).ok, false, `${JSON.stringify(value)} must be rejected`);
      }
    });

    // A comma is Shopify's tag separator: "a,b" becomes two tags, so the
    // configured name could never match and every sync would re-tag the
    // whole catalog.
    it("rejects a tag containing a comma", () => {
      const result = tags.normalizeTagName("out of stock, hidden");
      assert.equal(result.ok, false);
      assert.match(result.error, /comma/i);
    });

    it("rejects a tag longer than Shopify allows", () => {
      const result = tags.normalizeTagName("x".repeat(256));
      assert.equal(result.ok, false);
      assert.match(result.error, /255/);
    });

    it("accepts a tag of exactly the maximum length", () => {
      assert.equal(tags.normalizeTagName("x".repeat(255)).ok, true);
    });

    it("collapses internal newlines and tabs rather than storing them", () => {
      assert.deepEqual(tags.normalizeTagName("sold\tout\nnow"), { ok: true, tagName: "sold out now" });
    });

    it("refuses to persist an invalid tag even if a caller skips the check", async () => {
      resetDb();
      const shop = nextShop("bad-tag");
      await assert.rejects(
        () => tags.setSettings(shop, { tagName: "a,b" }),
        /comma/i,
      );
      assert.equal((await tags.getSettings(shop)).tagName, "out-of-stock-hidden");
    });

    it("stores the cleaned-up form of an accepted tag", async () => {
      resetDb();
      const shop = nextShop("clean-tag");
      await tags.setSettings(shop, { tagName: "  sold   out  " });
      assert.equal((await tags.getSettings(shop)).tagName, "sold out");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Automatic Sync: ON/OFF and the real webhook path
// ---------------------------------------------------------------------------

describe("Automatic Sync — ON/OFF toggle", () => {
  it("does nothing at all while the toggle is OFF", async () => {
    resetDb();
    const shop = nextShop("auto-off");
    await tags.setSettings(shop, { autoSyncEnabled: false, tagName: TAG });

    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    const inventory = await deliverInventoryWebhook(shop, admin, 100);
    const created = await deliverProductCreateWebhook(shop, admin, "gid://shopify/Product/1");

    assert.equal(inventory.status, 200);
    assert.equal(created.status, 200);
    assert.equal(admin.calls.length, 0, "no Admin API call may be made while auto sync is off");
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);
  });

  it("starts acting as soon as the toggle is flipped ON", async () => {
    resetDb();
    const shop = nextShop("auto-flip");
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    await tags.setSettings(shop, { autoSyncEnabled: false, tagName: TAG });
    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);

    await tags.setSettings(shop, { autoSyncEnabled: true });
    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);

    // …and stops again the moment it is flipped back OFF.
    await tags.setSettings(shop, { autoSyncEnabled: false });
    admin.products.get("gid://shopify/Product/1").totalInventory = 25;
    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(
      admin.tagsOf("gid://shopify/Product/1"),
      [TAG],
      "a restock must be ignored while auto sync is off",
    );
  });
});

describe("Automatic Sync — inventory_levels/update", () => {
  const shopFor = async (name, products) => {
    resetDb();
    const shop = nextShop(name);
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    return { shop, admin: new FakeAdmin(products) };
  };

  it("Rule 1: tags a product that has just sold out", async () => {
    const { shop, admin } = await shopFor("sold-out", [
      product({ totalInventory: 0, tags: ["sale"] }),
    ]);
    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), ["sale", TAG]);
  });

  it("Rule 2: untags a product that has just been restocked", async () => {
    const { shop, admin } = await shopFor("restock", [
      product({ totalInventory: 6, tags: ["sale", TAG] }),
    ]);
    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), ["sale"]);
  });

  it("leaves draft and archived products alone", async () => {
    const { shop, admin } = await shopFor("inactive", [
      product({ id: "gid://shopify/Product/10", status: "DRAFT", totalInventory: 0, tags: [], inventoryItemIds: [110] }),
      product({ id: "gid://shopify/Product/11", status: "ARCHIVED", totalInventory: 0, tags: [], inventoryItemIds: [111] }),
    ]);

    await deliverInventoryWebhook(shop, admin, 110);
    await deliverInventoryWebhook(shop, admin, 111);

    assert.deepEqual(admin.tagsOf("gid://shopify/Product/10"), []);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/11"), []);
    assert.equal(admin.countCalls("addOutOfStockTag"), 0);
  });

  it("never tags an untracked product, and clears the tag if it has one", async () => {
    const { shop, admin } = await shopFor("untracked", [
      product({ id: "gid://shopify/Product/20", tracksInventory: false, totalInventory: 0, tags: [], inventoryItemIds: [120] }),
      product({ id: "gid://shopify/Product/21", tracksInventory: false, totalInventory: 0, tags: [TAG], inventoryItemIds: [121] }),
    ]);

    await deliverInventoryWebhook(shop, admin, 120);
    await deliverInventoryWebhook(shop, admin, 121);

    assert.deepEqual(admin.tagsOf("gid://shopify/Product/20"), []);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/21"), []);
  });

  it("uses the merchant's custom tag name", async () => {
    resetDb();
    const shop = nextShop("custom-tag");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: "sold-out" });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), ["sold-out"]);
  });

  it("does not re-tag a product whose tag differs only by case", async () => {
    resetDb();
    const shop = nextShop("case");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: ["Out-Of-Stock-Hidden"] })]);

    await deliverInventoryWebhook(shop, admin, 100);

    assert.equal(admin.countCalls("addOutOfStockTag"), 0, "tag is already there in a different case");
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), ["Out-Of-Stock-Hidden"]);
  });

  it("clears a differently-cased tag once the product is back in stock", async () => {
    resetDb();
    const shop = nextShop("case-restock");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 14, tags: ["Out-Of-Stock-Hidden"] })]);

    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(
      admin.tagsOf("gid://shopify/Product/1"),
      [],
      "a product left tagged after restocking stays hidden from shoppers",
    );
  });

  it("serialises concurrent webhooks for one product so the last read wins", async () => {
    resetDb();
    const shop = nextShop("concurrent-webhooks");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });

    // One order across three variants of the same product delivers three
    // webhooks at once; the final state must match the final quantity.
    const admin = new FakeAdmin([
      product({ totalInventory: 3, tags: [], inventoryItemIds: [100, 101, 102] }),
    ]);
    const row = admin.products.get("gid://shopify/Product/1");

    const deliveries = [100, 101, 102].map((item, index) =>
      (async () => {
        await delay(index);
        row.totalInventory = 2 - index; // 2, 1, then 0
        return deliverInventoryWebhook(shop, admin, item);
      })(),
    );
    await Promise.all(deliveries);

    assert.equal(row.totalInventory, 0);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
  });

  it("asks Shopify to redeliver when the Admin API is unreachable", async () => {
    resetDb();
    const shop = nextShop("redeliver");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({})]);
    admin.failNext = 10; // exhausts the webhook retry budget

    const response = await deliverInventoryWebhook(shop, admin, 100);
    assert.equal(response.status, 500, "a transient upstream failure must be retried by Shopify");
  });

  it("accepts the delivery when the inventory item is unknown", async () => {
    resetDb();
    const shop = nextShop("unknown-item");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([]);

    const response = await deliverInventoryWebhook(shop, admin, 999);
    assert.equal(response.status, 200);
  });
});

describe("Automatic Sync — products/create", () => {
  it("tags an imported product that arrives with no stock", async () => {
    resetDb();
    const shop = nextShop("import");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    await deliverProductCreateWebhook(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
  });

  it("leaves an imported in-stock product untouched", async () => {
    resetDb();
    const shop = nextShop("import-stocked");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 4, tags: [] })]);

    await deliverProductCreateWebhook(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);
    assert.equal(admin.countCalls("addOutOfStockTag"), 0);
  });

  it("leaves an imported draft product untouched", async () => {
    resetDb();
    const shop = nextShop("import-draft");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ status: "DRAFT", totalInventory: 0, tags: [] })]);

    await deliverProductCreateWebhook(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);
  });

  it("accepts a numeric id and a gid alike", async () => {
    resetDb();
    const shop = nextShop("import-gid");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    await deliverProductCreateWebhook(shop, admin, "gid://shopify/Product/1");
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
  });
});

describe("Automatic Sync — products/update", () => {
  let productUpdateWebhook;

  before(async () => {
    productUpdateWebhook = await import("../app/routes/webhooks.products.update.jsx");
  });

  const deliver = async (shop, admin, productId) => {
    setWebhookResult({ shop, topic: "products/update", payload: { id: productId }, admin });
    return productUpdateWebhook.action({ request: request() });
  };

  // Publishing a sold-out draft is a status change, not an inventory change, so
  // inventory_levels/update never fires for it.
  it("tags a sold-out product the moment it is published", async () => {
    resetDb();
    const shop = nextShop("publish");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ status: "DRAFT", totalInventory: 0, tags: [] })]);

    await deliver(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [], "still a draft");

    admin.products.get("gid://shopify/Product/1").status = "ACTIVE";
    await deliver(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
  });

  it("clears the tag when inventory tracking is switched off", async () => {
    resetDb();
    const shop = nextShop("untrack");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [TAG] })]);

    admin.products.get("gid://shopify/Product/1").tracksInventory = false;
    await deliver(shop, admin, 1);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);
  });

  it("settles after one pass, so our own tag edit cannot loop", async () => {
    resetDb();
    const shop = nextShop("no-loop");
    await tags.setSettings(shop, { autoSyncEnabled: true, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    await deliver(shop, admin, 1);
    const afterFirst = admin.calls.length;

    // Shopify echoes our tagsAdd back as another products/update.
    await deliver(shop, admin, 1);
    assert.equal(admin.countCalls("addOutOfStockTag"), 1, "second pass must be a no-op");
    assert.equal(admin.calls.length, afterFirst + 1, "second pass costs a single read");
  });

  it("stays silent while Automatic Sync is OFF", async () => {
    resetDb();
    const shop = nextShop("update-off");
    await tags.setSettings(shop, { autoSyncEnabled: false, tagName: TAG });
    const admin = new FakeAdmin([product({ totalInventory: 0, tags: [] })]);

    const response = await deliver(shop, admin, 1);
    assert.equal(response.status, 200);
    assert.equal(admin.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Manual Full Catalog Sync
// ---------------------------------------------------------------------------

/** Drives a sync the way the dashboard does and records every UI snapshot. */
async function runSync(simulator, shop, { timeoutMs = 60_000 } = {}) {
  setAdmin(simulator.admin);
  const snapshots = [];
  const startedAt = Date.now();
  let maxPollMs = 0;

  await bulkSync.startBulkSync(simulator.admin, shop, TAG);

  for (;;) {
    const pollStart = Date.now();
    const job = await bulkSync.tickBulkSync(shop);
    maxPollMs = Math.max(maxPollMs, Date.now() - pollStart);

    snapshots.push({
      status: job.status,
      processed: job.processed,
      exported: job.exported,
      total: job.total,
      percent: status.bulkSyncProgressPercent(job),
      label: status.bulkSyncStatusLabel(job),
      elapsed: status.bulkSyncElapsedLabel(job),
    });

    if (status.isBulkSyncFinished(job)) {
      return { job, snapshots, maxPollMs, wallMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`sync stuck in ${job.status} after ${timeoutMs}ms`);
    }
    await delay(10);
  }
}

describe("Manual Full Catalog Sync — the product matrix", () => {
  // 600 products cycling through every state a merchant can have. Only the
  // ACTIVE + tracked rows may ever be touched.
  const STATES = [
    { key: "zero-untagged", status: "ACTIVE", tags: [], totalInventory: 0, tracksInventory: true, expect: "add" },
    { key: "zero-tagged", status: "ACTIVE", tags: [TAG], totalInventory: 0, tracksInventory: true, expect: null },
    { key: "stocked-tagged", status: "ACTIVE", tags: [TAG, "sale"], totalInventory: 11, tracksInventory: true, expect: "remove" },
    { key: "stocked-untagged", status: "ACTIVE", tags: ["sale"], totalInventory: 11, tracksInventory: true, expect: null },
    { key: "oversold", status: "ACTIVE", tags: [], totalInventory: -2, tracksInventory: true, expect: "add" },
    { key: "untracked", status: "ACTIVE", tags: [], totalInventory: 0, tracksInventory: false, expect: null },
    { key: "untracked-tagged", status: "ACTIVE", tags: [TAG], totalInventory: 0, tracksInventory: false, expect: "remove" },
    { key: "draft", status: "DRAFT", tags: [], totalInventory: 0, tracksInventory: true, expect: null },
    { key: "archived", status: "ARCHIVED", tags: [TAG], totalInventory: 5, tracksInventory: true, expect: null },
    { key: "cased-tag-stocked", status: "ACTIVE", tags: ["OUT-OF-STOCK-HIDDEN"], totalInventory: 3, tracksInventory: true, expect: "remove" },
    { key: "cased-tag-zero", status: "ACTIVE", tags: ["Out-Of-Stock-Hidden"], totalInventory: 0, tracksInventory: true, expect: null },
    { key: "null-quantity", status: "ACTIVE", tags: [], totalInventory: null, tracksInventory: true, expect: null },
  ];

  const PRODUCT_COUNT = STATES.length * 50;
  const catalog = (index) => {
    const state = STATES[index % STATES.length];
    return {
      id: `gid://shopify/Product/${1_000_000 + index}`,
      status: state.status,
      tags: [...state.tags],
      totalInventory: state.totalInventory,
      tracksInventory: state.tracksInventory,
    };
  };

  const expected = STATES.reduce(
    (acc, state) => {
      if (state.expect === "add") acc.toTag += 50;
      if (state.expect === "remove") acc.toUntag += 50;
      return acc;
    },
    { toTag: 0, toUntag: 0 },
  );

  let simulator;
  let result;

  before(async () => {
    resetDb();
    simulator = await new ShopifySimulator({
      productCount: PRODUCT_COUNT,
      queryPolls: 2,
      mutationPolls: 1,
      catalog,
    }).start();
    result = await runSync(simulator, nextShop("matrix"));
  });

  after(async () => {
    await simulator?.stop();
  });

  it("completes", () => {
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.errorMessage, null);
  });

  it("scans every exported product exactly once", () => {
    assert.equal(result.job.processed, PRODUCT_COUNT);
    assert.equal(result.job.total, PRODUCT_COUNT);
  });

  it("selects exactly the products the rules call for", () => {
    assert.equal(result.job.toTag, expected.toTag, "products queued for tagging");
    assert.equal(result.job.toUntag, expected.toUntag, "products queued for untagging");
  });

  it("reports the counts it actually applied", () => {
    assert.equal(result.job.tagged, expected.toTag);
    assert.equal(result.job.untagged, expected.toUntag);
    assert.equal(result.job.failed, 0);
  });

  it("leaves draft, archived and untracked-untagged products out of both phases", () => {
    const untouched = STATES.filter((s) => s.expect === null).length * 50;
    assert.equal(PRODUCT_COUNT - (result.job.toTag + result.job.toUntag), untouched);
  });

  it("runs both mutation phases, once each", () => {
    assert.equal(simulator.countCalls("startBulkProductQuery"), 1);
    assert.equal(simulator.countCalls("runBulkMutation"), 2);
  });
});

describe("Manual Full Catalog Sync — progress, status and duration", () => {
  let simulator;
  let result;

  before(async () => {
    resetDb();
    simulator = await new ShopifySimulator({
      productCount: 4_000,
      queryPolls: 3,
      mutationPolls: 2,
    }).start();
    result = await runSync(simulator, nextShop("progress"));
  });

  after(async () => {
    await simulator?.stop();
  });

  it("walks the phases in order and never goes backwards", () => {
    const order = ["querying", "downloading", "tagging", "untagging", "completed"];
    const seen = [];
    for (const snapshot of result.snapshots) {
      if (seen.at(-1) !== snapshot.status) seen.push(snapshot.status);
    }
    assert.deepEqual(seen, order.filter((phase) => seen.includes(phase)));
    assert.ok(seen.includes("downloading"), `phases seen: ${seen.join(" → ")}`);
    assert.equal(seen.at(-1), "completed");
  });

  it("shows a human-readable message at every step", () => {
    for (const snapshot of result.snapshots) {
      assert.ok(snapshot.label && snapshot.label.length > 0, `no label for ${snapshot.status}`);
    }
  });

  it("reports a climbing product count while exporting and scanning", () => {
    const scanning = result.snapshots.filter((s) => s.status === "downloading").map((s) => s.processed);
    assert.ok(scanning.length >= 2, "expected several scanning snapshots");
    assert.ok(Math.max(...scanning) > Math.min(...scanning), "the scanned count never moved");
  });

  it("never reports a percentage outside 0–100 and never regresses within a phase", () => {
    const byPhase = new Map();
    for (const snapshot of result.snapshots) {
      if (snapshot.percent === null) continue;
      assert.ok(snapshot.percent >= 0 && snapshot.percent <= 100, `percent ${snapshot.percent}`);
      const previous = byPhase.get(snapshot.status) ?? 0;
      assert.ok(snapshot.percent >= previous, `${snapshot.status} went ${previous}% → ${snapshot.percent}%`);
      byPhase.set(snapshot.status, snapshot.percent);
    }
  });

  it("never lets the progress count exceed its own denominator", () => {
    for (const snapshot of result.snapshots) {
      if (snapshot.status === "downloading" && snapshot.total > 0) {
        assert.ok(snapshot.processed <= snapshot.total, `${snapshot.processed} of ${snapshot.total}`);
      }
    }
  });

  it("keeps every status poll fast enough for a 2s UI interval", () => {
    assert.ok(result.maxPollMs < 500, `slowest poll took ${result.maxPollMs}ms`);
  });

  it("stamps finishedAt and stops the duration clock", async () => {
    assert.ok(result.job.finishedAt, "finishedAt must be recorded");
    const first = status.bulkSyncElapsedLabel(result.job);
    await delay(1_100);
    assert.equal(status.bulkSyncElapsedLabel(result.job), first, "the duration kept counting after the sync ended");
  });

  it("reports a duration consistent with the wall clock", () => {
    const seconds = Number(status.bulkSyncElapsedLabel(result.job).replace(/[^0-9]/g, ""));
    assert.ok(seconds <= Math.ceil(result.wallMs / 1000) + 1, `reported ${seconds}s for a ${result.wallMs}ms run`);
  });

  it("ends on a summary that matches the stored counters", () => {
    const label = status.bulkSyncStatusLabel(result.job);
    assert.match(label, new RegExp(`scanned ${result.job.processed.toLocaleString()} products`));
    assert.match(label, new RegExp(`tagged ${result.job.tagged.toLocaleString()}`));
    assert.match(label, new RegExp(`untagged ${result.job.untagged.toLocaleString()}`));
  });
});

describe("Manual Full Catalog Sync — edge cases", () => {
  it("handles a store with no active products", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({ productCount: 0, queryPolls: 1 }).start();
    try {
      const run = await runSync(simulator, nextShop("empty"));
      assert.equal(run.job.status, "completed");
      assert.equal(run.job.processed, 0);
      assert.equal(run.job.tagged, 0);
      assert.equal(run.job.untagged, 0);
      assert.equal(simulator.countCalls("runBulkMutation"), 0, "no mutation for an empty catalog");
      assert.match(status.bulkSyncStatusLabel(run.job), /^Sync complete/);
    } finally {
      await simulator.stop();
    }
  });

  it("handles a catalog that needs no changes at all", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 500,
      queryPolls: 1,
      catalog: (index) => ({
        id: `gid://shopify/Product/${index}`,
        status: "ACTIVE",
        tags: ["sale"],
        totalInventory: 5,
        tracksInventory: true,
      }),
    }).start();
    try {
      const run = await runSync(simulator, nextShop("no-op"));
      assert.equal(run.job.status, "completed");
      assert.equal(run.job.processed, 500);
      assert.equal(run.job.toTag, 0);
      assert.equal(run.job.toUntag, 0);
      assert.equal(simulator.countCalls("runBulkMutation"), 0);
    } finally {
      await simulator.stop();
    }
  });

  it("runs the untag phase on its own when nothing needs tagging", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 300,
      queryPolls: 1,
      mutationPolls: 1,
      catalog: (index) => ({
        id: `gid://shopify/Product/${index}`,
        status: "ACTIVE",
        tags: [TAG],
        totalInventory: 8,
        tracksInventory: true,
      }),
    }).start();
    try {
      const run = await runSync(simulator, nextShop("untag-only"));
      assert.equal(run.job.status, "completed");
      assert.equal(run.job.toTag, 0);
      assert.equal(run.job.toUntag, 300);
      assert.equal(run.job.untagged, 300);
      assert.equal(run.job.tagged, 0);
      assert.equal(simulator.countCalls("runBulkMutation"), 1);
    } finally {
      await simulator.stop();
    }
  });

  it("uses the merchant's custom tag for the whole catalog", async () => {
    resetDb();
    const shop = nextShop("custom-bulk");
    await tags.setSettings(shop, { tagName: "sold-out", autoSyncEnabled: false });
    const simulator = await new ShopifySimulator({
      productCount: 200,
      queryPolls: 1,
      mutationPolls: 1,
      catalog: (index) => ({
        id: `gid://shopify/Product/${index}`,
        status: "ACTIVE",
        tags: index % 2 ? ["sold-out"] : [],
        totalInventory: index % 2 ? 4 : 0,
        tracksInventory: true,
      }),
    }).start();
    try {
      setAdmin(simulator.admin);
      const settings = await tags.getSettings(shop);
      await bulkSync.startBulkSync(simulator.admin, shop, settings.tagName);

      let job;
      for (;;) {
        job = await bulkSync.tickBulkSync(shop);
        if (status.isBulkSyncFinished(job)) break;
        await delay(10);
      }

      assert.equal(job.status, "completed");
      assert.equal(job.tagName, "sold-out");
      assert.equal(job.toTag, 100);
      assert.equal(job.toUntag, 100);
    } finally {
      await simulator.stop();
    }
  });

  it("can be cancelled mid-run and reports it as cancelled", async () => {
    resetDb();
    const shop = nextShop("cancel");
    const simulator = await new ShopifySimulator({
      productCount: 50_000,
      queryPolls: 1,
      mutationPolls: 4,
    }).start();
    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG);

      // Let it get past the export before pulling the plug.
      for (let i = 0; i < 400; i += 1) {
        const job = await bulkSync.tickBulkSync(shop);
        if (job.status !== "querying") break;
        await delay(5);
      }

      const cancelled = await bulkSync.cancelBulkSync(simulator.admin, shop);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.finishedAt, "a cancelled run still needs a finish time");
      assert.equal(status.bulkSyncStatusLabel(cancelled), "Sync cancelled.");

      // It must stay cancelled — no in-flight step may resurrect it.
      await delay(200);
      assert.equal((await bulkSync.getBulkSyncJob(shop)).status, "cancelled");
    } finally {
      await simulator.stop();
    }
  });

  it("can start a fresh run after a cancelled one", async () => {
    resetDb();
    const shop = nextShop("restart");
    const simulator = await new ShopifySimulator({ productCount: 400, queryPolls: 1, mutationPolls: 1 }).start();
    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG);
      await bulkSync.cancelBulkSync(simulator.admin, shop);

      await bulkSync.startBulkSync(simulator.admin, shop, TAG);
      let job;
      for (let i = 0; i < 2_000; i += 1) {
        job = await bulkSync.tickBulkSync(shop);
        if (status.isBulkSyncFinished(job)) break;
        await delay(5);
      }

      assert.equal(job.status, "completed");
      assert.equal(job.processed, 400);
      assert.equal(job.errorMessage, null, "the previous cancellation must not leak into the new run");
    } finally {
      await simulator.stop();
    }
  });

  it("resets every counter when a new run starts", async () => {
    resetDb();
    const shop = nextShop("counters");
    const simulator = await new ShopifySimulator({ productCount: 300, queryPolls: 1, mutationPolls: 1 }).start();
    try {
      setAdmin(simulator.admin);
      const first = await runSync(simulator, shop);
      assert.ok(first.job.tagged > 0);

      await bulkSync.startBulkSync(simulator.admin, shop, TAG);
      const fresh = await bulkSync.getBulkSyncJob(shop);
      for (const field of ["processed", "tagged", "untagged", "failed", "toTag", "toUntag", "mutationProcessed"]) {
        assert.equal(fresh[field], 0, `${field} was carried over from the previous run`);
      }
      assert.equal(fresh.finishedAt, null);
      assert.equal(fresh.errorMessage, null);
    } finally {
      await simulator.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Dashboard presentation
// ---------------------------------------------------------------------------

describe("dashboard presentation", () => {
  const completed = {
    status: "completed",
    processed: 152_431,
    total: 152_500,
    exported: 152_500,
    tagged: 12_004,
    untagged: 3_500,
    failed: 7,
    startedAt: new Date("2026-09-22T10:00:00Z"),
    finishedAt: new Date("2026-09-22T10:04:30Z"),
  };

  it("reports the scanned count the same way in the banner and the stats", () => {
    const view = status.bulkSyncView({ job: completed });
    assert.equal(view.stats.find((s) => s.label === "Scanned").value, completed.processed.toLocaleString());
    assert.match(status.bulkSyncStatusLabel(completed), new RegExp(`scanned ${completed.processed.toLocaleString()}`));
  });

  it("groups large numbers so 152431 does not read as a phone number", () => {
    const view = status.bulkSyncView({ job: completed });
    for (const stat of view.stats) {
      assert.ok(!/^\d{5,}$/.test(stat.value), `${stat.label} rendered as ${stat.value}`);
    }
  });

  it("surfaces failures in the stats, not only in the prose", () => {
    const view = status.bulkSyncView({ job: completed });
    assert.equal(view.stats.find((s) => s.label === "Failed")?.value, "7");
  });

  it("hides the failed stat when nothing failed", () => {
    const view = status.bulkSyncView({ job: { ...completed, failed: 0 } });
    assert.equal(view.stats.find((s) => s.label === "Failed"), undefined);
  });

  it("shows progress, not a stale result, while the next sync is starting", () => {
    const view = status.bulkSyncView({ job: completed, isStarting: true });
    assert.equal(view.mode, "running", "a new run must not reuse the previous run's banner");
    assert.equal(view.stats.length, 0, "the previous run's counts must not linger");
    assert.match(view.statusText, /start/i);
  });

  it("does not claim success while a failed run is being retried", () => {
    const failed = { ...completed, status: "failed", errorMessage: "Shopify export failed" };
    const view = status.bulkSyncView({ job: failed, isStarting: true });
    assert.notEqual(view.tone, "critical");
    assert.equal(view.mode, "running");
  });

  it("describes an active run without an outcome banner", () => {
    const view = status.bulkSyncView({
      job: { status: "downloading", processed: 500, total: 4_000, startedAt: new Date() },
    });
    assert.equal(view.mode, "running");
    assert.equal(view.percent, 13);
    assert.match(view.statusText, /^Scanning 500 of 4,000 products/);
  });

  it("reports a start failure as an error, not as a completed sync", () => {
    const view = status.bulkSyncView({ job: completed, startError: "Access token expired" });
    assert.equal(view.mode, "finished");
    assert.equal(view.tone, "critical");
    assert.match(view.statusText, /Access token expired/);
    assert.equal(view.stats.length, 0);
  });

  it("renders nothing before the first sync has ever run", () => {
    const view = status.bulkSyncView({ job: null });
    assert.equal(view.mode, "idle");
    assert.equal(view.statusText, null);
  });

  it("marks a cancelled run as informational rather than as a failure", () => {
    const view = status.bulkSyncView({ job: { ...completed, status: "cancelled" } });
    assert.equal(view.tone, "info");
    assert.equal(view.heading, "Sync cancelled");
    assert.equal(view.stats.length, 0, "a cancelled run has no meaningful totals");
  });

  it("relaxes the poll cadence as a run drags on", () => {
    const at = (minutes) =>
      status.bulkSyncPollDelayMs({ startedAt: new Date(0) }, minutes * 60_000);

    assert.equal(at(0), status.POLL_FAST_MS, "a fresh run must feel live");
    assert.equal(at(1), status.POLL_FAST_MS);
    assert.equal(at(5), status.POLL_MEDIUM_MS);
    assert.equal(at(30), status.POLL_SLOW_MS);
    assert.equal(status.bulkSyncPollDelayMs(null), status.POLL_FAST_MS);
    assert.equal(status.bulkSyncPollDelayMs({ startedAt: "not a date" }), status.POLL_FAST_MS);
  });

  it("cuts a six-hour run's polling load by more than half", () => {
    let elapsed = 0;
    let polls = 0;
    while (elapsed < 6 * 60 * 60_000) {
      elapsed += status.bulkSyncPollDelayMs({ startedAt: new Date(0) }, elapsed);
      polls += 1;
    }
    assert.ok(polls < 5_000, `${polls} polls for a six-hour run`);
  });

  it("formats durations in units a merchant can read", () => {
    const at = (ms) =>
      status.bulkSyncElapsedLabel({
        status: "completed",
        startedAt: new Date(0),
        finishedAt: new Date(ms),
      });
    assert.equal(at(4_000), "4s");
    assert.equal(at(95_000), "1m 35s");
    assert.equal(at(3_725_000), "1h 2m");
  });
});
