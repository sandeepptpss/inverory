// The opt-in "Automatic Status Rules": out of stock -> UNLISTED, restocked ->
// ACTIVE, for products in the selected collection only.
//
// Covers both sync paths (Auto Sync webhooks and the Manual Full Catalog Sync)
// in both states of the checkbox, plus the promise that matters most to a
// merchant: ticking the box, loading the dashboard or saving settings never
// changes a product — only an actual sync does.

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
import {
  setAdmin,
  setAdminSession,
  setWebhookResult,
} from "./support/fake-shopify-server.mjs";

const TAG = "out-of-stock-hidden";
const COLLECTION = "gid://shopify/Collection/555";
const OTHER_COLLECTION = "gid://shopify/Collection/999";

let shopCounter = 0;
const nextShop = (name) => `status-${name}-${++shopCounter}.myshopify.com`;

let tags;
let bulkSync;
let status;
let dashboard;
let inventoryWebhook;
let productUpdateWebhook;

let keepAlive;
before(() => {
  keepAlive = setInterval(() => {}, 1_000);
});
after(() => clearInterval(keepAlive));

before(async () => {
  tags = await import("../app/services/inventory-tags.server.js");
  bulkSync = await import("../app/services/bulk-sync.server.js");
  status = await import("../app/lib/bulk-sync-status.js");
  dashboard = await import("../app/routes/app.inventory-tags.jsx");
  inventoryWebhook = await import("../app/routes/webhooks.inventory_levels.update.jsx");
  productUpdateWebhook = await import("../app/routes/webhooks.products.update.jsx");
});

const webhookRequest = () => new Request("http://localhost/webhooks");

async function deliverInventoryWebhook(shop, admin, inventoryItemId) {
  setWebhookResult({
    shop,
    topic: "inventory_levels/update",
    payload: { inventory_item_id: inventoryItemId },
    admin,
  });
  return inventoryWebhook.action({ request: webhookRequest() });
}

async function deliverProductUpdate(shop, admin, payload) {
  setWebhookResult({ shop, topic: "products/update", payload, admin });
  return productUpdateWebhook.action({ request: webhookRequest() });
}

function dashboardRequest(fields) {
  if (!fields) return new Request("http://localhost/app/inventory-tags");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request("http://localhost/app/inventory-tags", { method: "POST", body });
}

let productCounter = 0;
function product(overrides = {}) {
  productCounter += 1;
  return {
    id: `gid://shopify/Product/${productCounter}`,
    status: "ACTIVE",
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    inventoryItemIds: [10_000 + productCounter],
    collectionIds: [COLLECTION],
    ...overrides,
  };
}

/** A shop with Auto Sync on, the collection selected and the rules as given. */
async function configure(shop, { statusRulesEnabled = true, collectionId = COLLECTION } = {}) {
  await tags.setSettings(shop, {
    autoSyncEnabled: true,
    collectionId,
    collectionTitle: collectionId ? "Out of Stock - Count" : null,
    statusRulesEnabled,
  });
}

async function waitForFinish(shop) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = await bulkSync.tickBulkSync(shop);
    if (status.isBulkSyncFinished(job)) return job;
    if (Date.now() > deadline) throw new Error(`sync did not finish: ${job?.status}`);
    await delay(5);
  }
}

// ---------------------------------------------------------------------------
// 1. The decision table
// ---------------------------------------------------------------------------

describe("status rules: the decision table", () => {
  const decide = (overrides) =>
    tags.resolveStatusAction({
      status: "ACTIVE",
      quantity: 0,
      tracked: true,
      enabled: true,
      inCollection: true,
      ...overrides,
    });

  it("unlists an active product that is out of stock", () => {
    assert.equal(decide({ quantity: 0 }), "UNLISTED");
    assert.equal(decide({ quantity: "0" }), "UNLISTED");
  });

  it("treats oversold (negative) stock as out of stock", () => {
    assert.equal(decide({ quantity: -3 }), "UNLISTED");
  });

  it("sets an unlisted product back to Active once it is in stock", () => {
    assert.equal(decide({ status: "UNLISTED", quantity: 1 }), "ACTIVE");
    assert.equal(decide({ status: "UNLISTED", quantity: 250 }), "ACTIVE");
  });

  it("does nothing when the product already has the right status", () => {
    assert.equal(decide({ status: "UNLISTED", quantity: 0 }), null);
    assert.equal(decide({ status: "ACTIVE", quantity: 5 }), null);
  });

  it("never touches draft or archived products", () => {
    for (const productStatus of ["DRAFT", "ARCHIVED"]) {
      assert.equal(decide({ status: productStatus, quantity: 0 }), null);
      assert.equal(decide({ status: productStatus, quantity: 9 }), null);
    }
  });

  it("skips products that do not track inventory", () => {
    assert.equal(decide({ tracked: false, quantity: 0 }), null);
    assert.equal(decide({ status: "UNLISTED", tracked: false, quantity: 7 }), null);
  });

  it("skips products outside the selected collection", () => {
    assert.equal(decide({ inCollection: false }), null);
    // Only a real `true` counts: a missing field must not read as membership.
    assert.equal(decide({ inCollection: undefined }), null);
  });

  it("does nothing at all while the rules are off", () => {
    assert.equal(decide({ enabled: false, quantity: 0 }), null);
    assert.equal(decide({ enabled: false, status: "UNLISTED", quantity: 4 }), null);
  });

  it("does nothing when Shopify did not report a number", () => {
    for (const quantity of [null, undefined, "", [], "abc", NaN]) {
      assert.equal(decide({ quantity }), null, `quantity ${JSON.stringify(quantity)}`);
    }
  });

  it("is only in force with the checkbox on AND a collection selected", () => {
    assert.equal(tags.statusRulesActive({ statusRulesEnabled: true, collectionId: COLLECTION }), true);
    assert.equal(tags.statusRulesActive({ statusRulesEnabled: true, collectionId: null }), false);
    assert.equal(tags.statusRulesActive({ statusRulesEnabled: false, collectionId: COLLECTION }), false);
    assert.equal(tags.statusRulesActive({}), false);
  });
});

describe("tag rules with the status rules in force", () => {
  const base = { tags: [], tracked: true, tagName: TAG };

  it("ignore unlisted products exactly as before while the status rules are off", () => {
    assert.equal(tags.resolveTagAction({ ...base, status: "UNLISTED", quantity: 0 }), null);
    assert.equal(
      tags.resolveTagAction({ ...base, status: "UNLISTED", tags: [TAG], quantity: 5 }),
      null,
    );
  });

  it("look after unlisted products while the status rules are on", () => {
    assert.equal(
      tags.resolveTagAction({ ...base, status: "UNLISTED", quantity: 0, manageUnlisted: true }),
      "add",
    );
    // The restock case: without this the product would go back to Active and
    // keep the out-of-stock tag forever.
    assert.equal(
      tags.resolveTagAction({
        ...base,
        status: "UNLISTED",
        tags: [TAG],
        quantity: 5,
        manageUnlisted: true,
      }),
      "remove",
    );
  });

  it("still never touch draft or archived products", () => {
    for (const productStatus of ["DRAFT", "ARCHIVED"]) {
      assert.equal(
        tags.resolveTagAction({ ...base, status: productStatus, quantity: 0, manageUnlisted: true }),
        null,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The setting
// ---------------------------------------------------------------------------

describe("status rules setting", () => {
  it("defaults to off", async () => {
    resetDb();
    assert.equal((await tags.getSettings(nextShop("default"))).statusRulesEnabled, false);
  });

  it("changes nothing else when toggled, and survives the other saves", async () => {
    resetDb();
    const shop = nextShop("isolated");
    await tags.setSettings(shop, {
      tagName: "sold-out",
      autoSyncEnabled: true,
      collectionId: COLLECTION,
      collectionTitle: "Out of Stock - Count",
    });

    await tags.setSettings(shop, { statusRulesEnabled: true });
    assert.deepEqual(await tags.getSettings(shop), {
      tagName: "sold-out",
      autoSyncEnabled: true,
      collectionId: COLLECTION,
      collectionTitle: "Out of Stock - Count",
      statusRulesEnabled: true,
    });

    // The settings form and the Auto Sync switch never send the checkbox, so
    // neither may reset it.
    await tags.setSettings(shop, { tagName: "gone", collectionId: COLLECTION, collectionTitle: "X" });
    await tags.setSettings(shop, { autoSyncEnabled: false });
    assert.equal((await tags.getSettings(shop)).statusRulesEnabled, true);

    await tags.setSettings(shop, { statusRulesEnabled: false });
    assert.equal((await tags.getSettings(shop)).statusRulesEnabled, false);
  });

  it("can be enabled before any other setting exists", async () => {
    resetDb();
    const shop = nextShop("first-save");
    await tags.setSettings(shop, { statusRulesEnabled: true });
    const settings = await tags.getSettings(shop);
    assert.equal(settings.statusRulesEnabled, true);
    assert.equal(settings.tagName, TAG);
    assert.equal(settings.autoSyncEnabled, false);
  });
});

// ---------------------------------------------------------------------------
// 3. Automatic Inventory Sync (webhooks)
// ---------------------------------------------------------------------------

describe("Auto Sync with the status rules on", () => {
  it("tags and unlists a product in the collection that has just sold out", async () => {
    resetDb();
    const shop = nextShop("sold-out");
    await configure(shop);
    const p = product({ totalInventory: 0 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    assert.deepEqual(admin.tagsOf(p.id), [TAG]);
    assert.equal(admin.statusOf(p.id), "UNLISTED");
  });

  it("untags and reactivates a product the rules unlisted once it is restocked", async () => {
    resetDb();
    const shop = nextShop("restocked");
    await configure(shop);
    const p = product({ status: "UNLISTED", tags: [TAG, "keep"], totalInventory: 3 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    assert.deepEqual(admin.tagsOf(p.id), ["keep"]);
    assert.equal(admin.statusOf(p.id), "ACTIVE");
  });

  it("unlists an oversold product", async () => {
    resetDb();
    const shop = nextShop("oversold");
    await configure(shop);
    const p = product({ totalInventory: -2 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);
    assert.equal(admin.statusOf(p.id), "UNLISTED");
  });

  it("tags an unlisted product that sold out without re-sending its status", async () => {
    resetDb();
    const shop = nextShop("already-unlisted");
    await configure(shop);
    const p = product({ status: "UNLISTED", totalInventory: 0 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    assert.deepEqual(admin.tagsOf(p.id), [TAG]);
    assert.equal(admin.statusOf(p.id), "UNLISTED");
    assert.equal(admin.countCalls("setProductStatus"), 0);
  });

  it("leaves products outside the collection exactly as they are", async () => {
    resetDb();
    const shop = nextShop("outside");
    await configure(shop);
    const soldOut = product({ totalInventory: 0, collectionIds: [OTHER_COLLECTION] });
    const restocked = product({
      status: "UNLISTED",
      tags: [TAG],
      totalInventory: 8,
      collectionIds: [],
    });
    const admin = new FakeAdmin([soldOut, restocked]);

    await deliverInventoryWebhook(shop, admin, soldOut.inventoryItemIds[0]);
    await deliverInventoryWebhook(shop, admin, restocked.inventoryItemIds[0]);

    assert.equal(admin.statusOf(soldOut.id), "ACTIVE");
    assert.deepEqual(admin.tagsOf(soldOut.id), []);
    assert.equal(admin.statusOf(restocked.id), "UNLISTED");
    assert.deepEqual(admin.tagsOf(restocked.id), [TAG]);
    assert.equal(admin.countCalls("setProductStatus"), 0);
  });

  it("never modifies draft or archived products", async () => {
    resetDb();
    const shop = nextShop("draft-archived");
    await configure(shop);
    const draft = product({ status: "DRAFT", totalInventory: 0 });
    const archived = product({ status: "ARCHIVED", totalInventory: 12, tags: [TAG] });
    const admin = new FakeAdmin([draft, archived]);

    await deliverInventoryWebhook(shop, admin, draft.inventoryItemIds[0]);
    await deliverInventoryWebhook(shop, admin, archived.inventoryItemIds[0]);

    assert.equal(admin.statusOf(draft.id), "DRAFT");
    assert.deepEqual(admin.tagsOf(draft.id), []);
    assert.equal(admin.statusOf(archived.id), "ARCHIVED");
    assert.deepEqual(admin.tagsOf(archived.id), [TAG]);
    assert.equal(admin.countCalls("setProductStatus"), 0);
  });

  it("skips products that do not track inventory", async () => {
    resetDb();
    const shop = nextShop("untracked");
    await configure(shop);
    const active = product({ tracksInventory: false, totalInventory: 0 });
    const unlisted = product({ status: "UNLISTED", tracksInventory: false, totalInventory: 0 });
    const admin = new FakeAdmin([active, unlisted]);

    await deliverInventoryWebhook(shop, admin, active.inventoryItemIds[0]);
    await deliverInventoryWebhook(shop, admin, unlisted.inventoryItemIds[0]);

    assert.equal(admin.statusOf(active.id), "ACTIVE");
    assert.equal(admin.statusOf(unlisted.id), "UNLISTED");
    assert.equal(admin.countCalls("setProductStatus"), 0);
  });

  it("does nothing while Auto Sync itself is off", async () => {
    resetDb();
    const shop = nextShop("auto-off");
    await configure(shop);
    await tags.setSettings(shop, { autoSyncEnabled: false });
    const p = product({ totalInventory: 0 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    assert.equal(admin.statusOf(p.id), "ACTIVE");
    assert.deepEqual(admin.calls, []);
  });
});

describe("Auto Sync with the status rules off", () => {
  it("never changes a status, and tags exactly as before", async () => {
    resetDb();
    const shop = nextShop("rules-off");
    await configure(shop, { statusRulesEnabled: false });
    const soldOut = product({ totalInventory: 0 });
    const admin = new FakeAdmin([soldOut]);

    await deliverInventoryWebhook(shop, admin, soldOut.inventoryItemIds[0]);

    assert.deepEqual(admin.tagsOf(soldOut.id), [TAG]);
    assert.equal(admin.statusOf(soldOut.id), "ACTIVE");
    assert.equal(admin.countCalls("setProductStatus"), 0);
  });

  it("leaves unlisted products alone, as it always did", async () => {
    resetDb();
    const shop = nextShop("rules-off-unlisted");
    await configure(shop, { statusRulesEnabled: false });
    const p = product({ status: "UNLISTED", tags: [TAG], totalInventory: 9 });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    assert.equal(admin.statusOf(p.id), "UNLISTED");
    assert.deepEqual(admin.tagsOf(p.id), [TAG]);
  });

  it("stays off with the checkbox ticked but no collection selected", async () => {
    resetDb();
    const shop = nextShop("no-collection");
    await configure(shop, { statusRulesEnabled: true, collectionId: null });
    const p = product({ totalInventory: 0, collectionIds: [] });
    const admin = new FakeAdmin([p]);

    await deliverInventoryWebhook(shop, admin, p.inventoryItemIds[0]);

    // The tag rule runs across the whole catalog as before; statuses do not.
    assert.deepEqual(admin.tagsOf(p.id), [TAG]);
    assert.equal(admin.statusOf(p.id), "ACTIVE");
    assert.equal(admin.countCalls("setProductStatus"), 0);
    // And the lookup is still the unscoped one it always was.
    assert.equal(admin.countCalls("getProductForInventoryItem"), 1);
  });
});

describe("products/update with the status rules", () => {
  it("skips an unlisted product without any API call while the rules are off", async () => {
    resetDb();
    const shop = nextShop("pu-off");
    await configure(shop, { statusRulesEnabled: false });
    const p = product({ status: "UNLISTED", tags: [TAG], totalInventory: 4 });
    const admin = new FakeAdmin([p]);

    await deliverProductUpdate(shop, admin, { id: p.id, status: "unlisted" });

    assert.deepEqual(admin.calls, []);
  });

  it("reactivates a restocked unlisted product while the rules are on", async () => {
    resetDb();
    const shop = nextShop("pu-on");
    await configure(shop);
    const p = product({ status: "UNLISTED", tags: [TAG], totalInventory: 4 });
    const admin = new FakeAdmin([p]);

    await deliverProductUpdate(shop, admin, { id: p.id, status: "unlisted" });

    assert.equal(admin.statusOf(p.id), "ACTIVE");
    assert.deepEqual(admin.tagsOf(p.id), []);
  });

  it("still skips draft and archived payloads without any API call", async () => {
    resetDb();
    const shop = nextShop("pu-draft");
    await configure(shop);
    const p = product({ status: "DRAFT", totalInventory: 0 });
    const admin = new FakeAdmin([p]);

    await deliverProductUpdate(shop, admin, { id: p.id, status: "draft" });
    await deliverProductUpdate(shop, admin, { id: p.id, status: "archived" });

    assert.deepEqual(admin.calls, []);
  });

  it("settles on the echo of its own status change instead of looping", async () => {
    resetDb();
    const shop = nextShop("pu-echo");
    await configure(shop);
    const p = product({ totalInventory: 0 });
    const admin = new FakeAdmin([p]);

    await deliverProductUpdate(shop, admin, { id: p.id, status: "active" });
    assert.equal(admin.statusOf(p.id), "UNLISTED");

    // Shopify now sends products/update for the change we just made.
    const before = admin.calls.length;
    await deliverProductUpdate(shop, admin, { id: p.id, status: "unlisted" });
    assert.deepEqual(admin.calls.slice(before), ["getProductForTagSyncInCollection"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Manual Full Catalog Sync
// ---------------------------------------------------------------------------

/**
 * The collection's products, six kinds repeating:
 *   0: active, sold out, untagged        -> tag + unlist
 *   1: unlisted, restocked, tagged       -> untag + activate
 *   2: unlisted, sold out, tagged        -> nothing
 *   3: active, in stock, untagged        -> nothing
 *   4: active, sold out, untracked       -> nothing
 *   5: active, oversold, already tagged  -> unlist only
 */
function collectionProduct(i) {
  const id = `gid://shopify/Product/${3_000_000 + i}`;
  switch (i % 6) {
    case 0:
      return { id, status: "ACTIVE", tags: [], totalInventory: 0, tracksInventory: true };
    case 1:
      return { id, status: "UNLISTED", tags: [TAG], totalInventory: 6, tracksInventory: true };
    case 2:
      return { id, status: "UNLISTED", tags: [TAG], totalInventory: 0, tracksInventory: true };
    case 3:
      return { id, status: "ACTIVE", tags: [], totalInventory: 4, tracksInventory: true };
    case 4:
      return { id, status: "ACTIVE", tags: [], totalInventory: 0, tracksInventory: false };
    default:
      return { id, status: "ACTIVE", tags: [TAG], totalInventory: -2, tracksInventory: true };
  }
}

function statusSimulator(options = {}) {
  return new ShopifySimulator({
    productCount: 40,
    collectionProductCount: 12,
    collectionCatalog: collectionProduct,
    collections: [{ id: COLLECTION, title: "Out of Stock - Count" }],
    ...options,
  }).start();
}

/** The `{ id, status }` rows a productUpdate upload carried. */
function statusRows(simulator, mutation) {
  const body = simulator.uploadBodies.get(mutation.stagedUploadPath) ?? "";
  return [...body.matchAll(/\{"product":\{"id":"([^"]+)","status":"(\w+)"\}\}/g)].map(
    ([, id, productStatus]) => ({ id, status: productStatus }),
  );
}

const idsOfKind = (kind) =>
  Array.from({ length: 12 }, (_, i) => i)
    .filter((i) => i % 6 === kind)
    .map((i) => `gid://shopify/Product/${3_000_000 + i}`);

describe("Manual Full Catalog Sync with the status rules on", () => {
  it("exports active and unlisted products in the collection and applies all four rules", async () => {
    resetDb();
    const shop = nextShop("manual-on");
    await configure(shop);
    const simulator = await statusSimulator();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: COLLECTION,
        collectionTitle: "Out of Stock - Count",
        statusRulesEnabled: true,
      });
      const job = await waitForFinish(shop);

      assert.deepEqual(simulator.bulkQueries, ["status:active,unlisted AND collection_id:555"]);
      assert.equal(job.status, "completed");
      assert.equal(job.statusRulesEnabled, true);
      assert.equal(job.processed, 12);

      assert.equal(job.toTag, 2);
      assert.equal(job.toUntag, 2);
      assert.equal(job.toUnlist, 4);
      assert.equal(job.toActivate, 2);
      assert.equal(job.tagged, 2);
      assert.equal(job.untagged, 2);
      assert.equal(job.unlisted, 4);
      assert.equal(job.activated, 2);
      assert.equal(job.failed, 0);

      // Tags first, then statuses; one bulk mutation at a time.
      assert.deepEqual(
        simulator.bulkMutations.map((m) => [m.field, m.rows]),
        [
          ["tagsAdd", 2],
          ["tagsRemove", 2],
          ["productUpdate", 4],
          ["productUpdate", 2],
        ],
      );

      const [, , unlist, activate] = simulator.bulkMutations;
      assert.deepEqual(
        statusRows(simulator, unlist),
        [...idsOfKind(0), ...idsOfKind(5)]
          .sort()
          .map((id) => ({ id, status: "UNLISTED" })),
      );
      assert.deepEqual(
        statusRows(simulator, activate),
        idsOfKind(1).map((id) => ({ id, status: "ACTIVE" })),
      );

      // Every temp file is gone once the run is over.
      assert.equal(job.unlistJsonlPath, null);
      assert.equal(job.activateJsonlPath, null);
    } finally {
      await simulator.stop();
    }
  });

  it("counts status updates Shopify rejects as failures", async () => {
    resetDb();
    const shop = nextShop("manual-failures");
    await configure(shop);
    // Every row of every mutation is rejected.
    const simulator = await statusSimulator({ mutationFailureRate: 1 });

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: COLLECTION,
        statusRulesEnabled: true,
      });
      const job = await waitForFinish(shop);

      assert.equal(job.status, "completed");
      assert.equal(job.unlisted, 0);
      assert.equal(job.activated, 0);
      assert.equal(job.failed, 2 + 2 + 4 + 2);
      assert.equal(status.bulkSyncView({ job }).heading, "Sync finished with errors");
    } finally {
      await simulator.stop();
    }
  });

  it("can be cancelled during a status phase, and says so", async () => {
    resetDb();
    const shop = nextShop("manual-cancel");
    await configure(shop);
    // The tag phases complete; the first status mutation never does.
    const simulator = await statusSimulator({ hangMutationField: "productUpdate" });

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: COLLECTION,
        statusRulesEnabled: true,
      });

      const deadline = Date.now() + 30_000;
      let job;
      for (;;) {
        job = await bulkSync.tickBulkSync(shop);
        if (job.status === status.SYNC_STATUS.unlisting && job.unlistMutationBulkOperationId) {
          break;
        }
        if (Date.now() > deadline) throw new Error(`never reached unlisting: ${job.status}`);
        await delay(5);
      }
      assert.equal(job.tagged, 2, "the tag phases finished first");
      assert.equal(job.untagged, 2);

      const cancelled = await bulkSync.cancelBulkSync(simulator.admin, shop);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(
        simulator.operations.get(job.unlistMutationBulkOperationId).status,
        "CANCELED",
        "the running status mutation is cancelled at Shopify too",
      );
      assert.match(status.bulkSyncView({ job: cancelled }).notes[0], /product statuses/);
      await Promise.all(bulkSync.activeRunners());
    } finally {
      await simulator.stop();
    }
  });
});

describe("Manual Full Catalog Sync with the status rules off", () => {
  it("sends the same export filter as before and never updates a status", async () => {
    resetDb();
    const shop = nextShop("manual-off");
    await configure(shop, { statusRulesEnabled: false });
    const simulator = await statusSimulator();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: COLLECTION,
        statusRulesEnabled: false,
      });
      const job = await waitForFinish(shop);

      assert.deepEqual(simulator.bulkQueries, ["status:active AND collection_id:555"]);
      assert.equal(job.statusRulesEnabled, false);
      assert.equal(simulator.bulkMutations.some((m) => m.field === "productUpdate"), false);
      assert.equal(job.toUnlist, 0);
      assert.equal(job.toActivate, 0);
      // Unlisted rows are ignored exactly as before, so only kind 0 is tagged.
      assert.equal(job.tagged, 2);
      assert.equal(job.untagged, 0);
    } finally {
      await simulator.stop();
    }
  });

  it("stays off with the checkbox ticked but no collection selected", async () => {
    resetDb();
    const shop = nextShop("manual-no-collection");
    const simulator = await statusSimulator();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: null,
        statusRulesEnabled: true,
      });
      const job = await waitForFinish(shop);

      assert.deepEqual(simulator.bulkQueries, ["status:active"]);
      assert.equal(job.statusRulesEnabled, false);
      assert.equal(simulator.bulkMutations.some((m) => m.field === "productUpdate"), false);
    } finally {
      await simulator.stop();
    }
  });

  it("keeps the export query byte-identical for every combination the rules cannot use", () => {
    assert.match(bulkSync.productsBulkQuery(null), /products\(query: "status:active"\)/);
    assert.match(
      bulkSync.productsBulkQuery(null, { includeUnlisted: true }),
      /products\(query: "status:active"\)/,
    );
    assert.match(
      bulkSync.productsBulkQuery(COLLECTION),
      /products\(query: "status:active AND collection_id:555"\)/,
    );
    assert.match(
      bulkSync.productsBulkQuery(COLLECTION, { includeUnlisted: true }),
      /products\(query: "status:active,unlisted AND collection_id:555"\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Dashboard: the checkbox only saves; syncs apply
// ---------------------------------------------------------------------------

describe("dashboard and the status rules checkbox", () => {
  it("loads the saved checkbox state", async () => {
    resetDb();
    const shop = nextShop("loader");
    await configure(shop);
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: COLLECTION, title: "Out of Stock - Count" }];
    setAdminSession({ shop, admin });

    const data = await dashboard.loader({ request: dashboardRequest() });
    assert.equal(data.statusRulesEnabled, true);
    // Loading the page never writes anything to Shopify.
    assert.equal(admin.calls.some((call) => /^set|^add|^remove/.test(call)), false);
  });

  it("saves the checkbox without touching a single product", async () => {
    resetDb();
    const shop = nextShop("toggle");
    await configure(shop, { statusRulesEnabled: false });
    const soldOut = product({ totalInventory: 0 });
    const restocked = product({ status: "UNLISTED", tags: [TAG], totalInventory: 5 });
    const admin = new FakeAdmin([soldOut, restocked]);
    setAdminSession({ shop, admin });

    const on = await dashboard.action({
      request: dashboardRequest({ intent: "toggle-status-rules", statusRulesEnabled: "true" }),
    });
    assert.deepEqual(on, { intent: "toggle-status-rules", statusRulesEnabled: true });
    assert.equal((await tags.getSettings(shop)).statusRulesEnabled, true);

    const off = await dashboard.action({
      request: dashboardRequest({ intent: "toggle-status-rules", statusRulesEnabled: "false" }),
    });
    assert.deepEqual(off, { intent: "toggle-status-rules", statusRulesEnabled: false });
    assert.equal((await tags.getSettings(shop)).statusRulesEnabled, false);

    assert.deepEqual(admin.calls, [], "toggling makes no Shopify call at all");
    assert.equal(admin.statusOf(soldOut.id), "ACTIVE");
    assert.equal(admin.statusOf(restocked.id), "UNLISTED");
    assert.equal(await bulkSync.getBulkSyncJob(shop), null, "and starts no sync");
  });

  it("does not re-run the loader after a toggle", () => {
    assert.equal(
      dashboard.shouldRevalidate({
        actionResult: { intent: "toggle-status-rules", statusRulesEnabled: true },
        defaultShouldRevalidate: true,
      }),
      false,
    );
  });

  it("runs the manual sync with the saved checkbox state", async () => {
    resetDb();
    const shop = nextShop("run-sync");
    await configure(shop);
    const simulator = await statusSimulator();

    try {
      setAdmin(simulator.admin);
      setAdminSession({ shop, admin: simulator.admin });

      const result = await dashboard.action({ request: dashboardRequest({ intent: "run-sync" }) });
      assert.equal(result.error, undefined);
      const job = await waitForFinish(shop);

      assert.equal(job.statusRulesEnabled, true);
      assert.deepEqual(simulator.bulkQueries, ["status:active,unlisted AND collection_id:555"]);
      assert.equal(job.unlisted, 4);
      assert.equal(job.activated, 2);
    } finally {
      await simulator.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. What the dashboard shows
// ---------------------------------------------------------------------------

describe("sync panel with the status rules", () => {
  const finished = (extra = {}) => ({
    status: "completed",
    tagName: TAG,
    collectionId: COLLECTION,
    collectionTitle: "Out of Stock - Count",
    processed: 12,
    toTag: 2,
    toUntag: 2,
    tagged: 2,
    untagged: 2,
    failed: 0,
    startedAt: new Date("2026-09-24T10:00:00Z"),
    finishedAt: new Date("2026-09-24T10:00:12Z"),
    updatedAt: new Date("2026-09-24T10:00:12Z"),
    ...extra,
  });

  it("reports status changes only for a run that had the rules in force", () => {
    const withRules = finished({
      statusRulesEnabled: true,
      toUnlist: 4,
      toActivate: 2,
      unlisted: 4,
      activated: 2,
    });
    assert.equal(
      status.bulkSyncStatusLabel(withRules),
      "Sync complete — scanned 12 products in “Out of Stock - Count”, tagged 2, untagged 2, set 4 unlisted, set 2 active.",
    );
    const labels = status.bulkSyncView({ job: withRules }).stats.map((s) => s.label);
    assert.ok(labels.includes("Set Unlisted"));
    assert.ok(labels.includes("Set Active"));

    // A tag-only run reads exactly as it always did.
    const tagOnly = finished();
    assert.equal(
      status.bulkSyncStatusLabel(tagOnly),
      "Sync complete — scanned 12 products in “Out of Stock - Count”, tagged 2, untagged 2.",
    );
    assert.deepEqual(
      status.bulkSyncView({ job: tagOnly }).stats.map((s) => s.label),
      ["Scope", "Scanned", "Tags Added", "Tags Removed", "Duration"],
    );
  });

  it("does not call a run that only changed statuses 'already up to date'", () => {
    const job = finished({
      statusRulesEnabled: true,
      toTag: 0,
      toUntag: 0,
      tagged: 0,
      untagged: 0,
      toUnlist: 3,
      unlisted: 3,
    });
    assert.equal(
      status.bulkSyncView({ job }).notes.some((n) => /already up to date/.test(n)),
      false,
    );
  });

  it("mentions unlisted products when a rules run scans nothing", () => {
    const job = finished({ statusRulesEnabled: true, processed: 0, tagged: 0, untagged: 0 });
    assert.ok(
      status
        .bulkSyncView({ job })
        .notes.some((n) => /No active or unlisted products were found in “Out of Stock - Count”/.test(n)),
    );
  });

  it("shows live progress for both status phases", () => {
    const unlisting = {
      status: "unlisting",
      toUnlist: 400,
      mutationProcessed: 100,
      startedAt: new Date(),
    };
    assert.equal(status.isBulkSyncActive(unlisting), true);
    assert.equal(status.bulkSyncProgressPercent(unlisting), 25);
    assert.equal(
      status.bulkSyncStatusLabel(unlisting),
      "Setting products to Unlisted — 100 of 400 products…",
    );

    const activating = { status: "activating", toActivate: 1, mutationProcessed: 0 };
    assert.equal(status.isBulkSyncActive(activating), true);
    assert.equal(
      status.bulkSyncStatusLabel(activating),
      "Setting products to Active — 0 of 1 product…",
    );
  });

  it("flags a finished run once the status rules have been switched since", () => {
    const tagOnly = finished({ statusRulesEnabled: false });
    const settings = { tagName: TAG, collectionId: COLLECTION };

    assert.equal(status.bulkSyncSettingsDrift(tagOnly, settings), null);
    assert.equal(
      status.bulkSyncSettingsDrift(tagOnly, { ...settings, statusRulesEnabled: false }),
      null,
    );
    assert.match(
      status.bulkSyncSettingsDrift(tagOnly, { ...settings, statusRulesEnabled: true }),
      /it ran without the status rules/,
    );
    // Ticked with no collection is not in force, so it is not drift either.
    assert.equal(
      status.bulkSyncSettingsDrift(finished({ collectionId: null, collectionTitle: null }), {
        tagName: TAG,
        collectionId: null,
        statusRulesEnabled: true,
      }),
      null,
    );
    assert.match(
      status.bulkSyncSettingsDrift(finished({ statusRulesEnabled: true }), {
        ...settings,
        statusRulesEnabled: false,
      }),
      /it applied the status rules/,
    );
  });
});
