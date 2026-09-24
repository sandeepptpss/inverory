// QA pass over collection-scoped syncing, for both entry points and for both
// of the states the feature has:
//
//   * no collection selected  -> the pre-existing whole-catalog behaviour,
//                                unchanged down to the query Shopify is sent
//   * a collection selected   -> only products in that collection are tagged
//                                or untagged; everything else is left alone
//
// The doubles hold real product rows, so the assertions are about the tag state
// a merchant would see rather than about which calls were made.

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
const COLLECTION = "gid://shopify/Collection/555";
const OTHER_COLLECTION = "gid://shopify/Collection/999";

let shopCounter = 0;
const nextShop = (name) => `scope-${name}-${++shopCounter}.myshopify.com`;

let tags;
let bulkSync;
let status;
let inventoryWebhook;
let productCreateWebhook;
let productUpdateWebhook;

// Retry backoffs use unref'd timers, so nothing else keeps the loop alive while
// a test waits on one.
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
  productUpdateWebhook = await import("../app/routes/webhooks.products.update.jsx");
});

const request = () => new Request("http://localhost/webhooks");

async function deliverInventoryWebhook(shop, admin, inventoryItemId) {
  setWebhookResult({
    shop,
    topic: "inventory_levels/update",
    payload: { inventory_item_id: inventoryItemId },
    admin,
  });
  return inventoryWebhook.action({ request: request() });
}

async function deliverProductWebhook(shop, admin, productId, topic = "products/create") {
  setWebhookResult({ shop, topic, payload: { id: productId }, admin });
  const route =
    topic === "products/update" ? productUpdateWebhook : productCreateWebhook;
  return route.action({ request: request() });
}

function product(overrides) {
  return {
    id: "gid://shopify/Product/1",
    status: "ACTIVE",
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
    inventoryItemIds: [100],
    collectionIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The scope setting itself
// ---------------------------------------------------------------------------

describe("collection scope setting", () => {
  it("defaults to no collection, i.e. the whole catalog", async () => {
    resetDb();
    const settings = await tags.getSettings(nextShop("default"));
    assert.equal(settings.collectionId, null);
    assert.equal(settings.collectionTitle, null);
  });

  it("stores a selected collection with its title", async () => {
    resetDb();
    const shop = nextShop("select");
    await tags.setSettings(shop, {
      collectionId: COLLECTION,
      collectionTitle: "Summer Sale",
    });

    const settings = await tags.getSettings(shop);
    assert.equal(settings.collectionId, COLLECTION);
    assert.equal(settings.collectionTitle, "Summer Sale");
  });

  it("clears the scope back to the whole catalog", async () => {
    resetDb();
    const shop = nextShop("clear");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });

    await tags.setSettings(shop, { collectionId: "" });
    const settings = await tags.getSettings(shop);
    assert.equal(settings.collectionId, null);
    // The stale title must go with it, or the UI would keep advertising a
    // scope that is no longer in force.
    assert.equal(settings.collectionTitle, null);
  });

  it("leaves the scope alone when a save does not mention it", async () => {
    resetDb();
    const shop = nextShop("untouched");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });

    await tags.setSettings(shop, { autoSyncEnabled: true });
    await tags.setSettings(shop, { tagName: "sold-out" });

    const settings = await tags.getSettings(shop);
    assert.equal(settings.collectionId, COLLECTION);
    assert.equal(settings.collectionTitle, "Summer Sale");
    assert.equal(settings.tagName, "sold-out");
    assert.equal(settings.autoSyncEnabled, true);
  });

  it("keeps each shop's scope separate", async () => {
    resetDb();
    const a = nextShop("tenant-a");
    const b = nextShop("tenant-b");
    await tags.setSettings(a, { collectionId: COLLECTION, collectionTitle: "A" });
    await tags.setSettings(b, { collectionId: null });

    assert.equal((await tags.getSettings(a)).collectionId, COLLECTION);
    assert.equal((await tags.getSettings(b)).collectionId, null);
  });

  describe("normalizeCollectionId", () => {
    it("treats empty input as the whole catalog", () => {
      for (const value of ["", "   ", null, undefined, "all"]) {
        assert.deepEqual(tags.normalizeCollectionId(value), {
          ok: true,
          collectionId: null,
        });
      }
    });

    it("accepts a GID and a bare numeric id alike", () => {
      assert.deepEqual(tags.normalizeCollectionId(COLLECTION), {
        ok: true,
        collectionId: COLLECTION,
      });
      assert.deepEqual(tags.normalizeCollectionId("555"), {
        ok: true,
        collectionId: COLLECTION,
      });
      assert.deepEqual(tags.normalizeCollectionId("  555  "), {
        ok: true,
        collectionId: COLLECTION,
      });
    });

    // A malformed id that fell through as null would silently widen the sync
    // back to the whole catalog — the one failure a merchant would not notice
    // until products outside their collection had been retagged.
    it("rejects anything that is not a collection id", () => {
      for (const value of [
        "gid://shopify/Product/555",
        "gid://shopify/Collection/abc",
        "summer-sale",
        "555; DROP TABLE",
      ]) {
        assert.equal(
          tags.normalizeCollectionId(value).ok,
          false,
          `${value} must be rejected`,
        );
      }
    });

    it("refuses to save a malformed id rather than widening the scope", async () => {
      resetDb();
      const shop = nextShop("reject");
      await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });

      await assert.rejects(() =>
        tags.setSettings(shop, { collectionId: "not-a-collection" }),
      );
      assert.equal((await tags.getSettings(shop)).collectionId, COLLECTION);
    });
  });

  it("extracts the numeric id Shopify's search filter wants", () => {
    assert.equal(tags.collectionLegacyId(COLLECTION), "555");
    assert.equal(tags.collectionLegacyId("555"), "555");
    assert.equal(tags.collectionLegacyId(null), null);
    assert.equal(tags.collectionLegacyId(""), null);
    assert.equal(tags.collectionLegacyId("gid://shopify/Product/555"), null);
  });
});

// ---------------------------------------------------------------------------
// 2. The decision table, with a scope applied
// ---------------------------------------------------------------------------

describe("automation rules under a collection scope", () => {
  const base = { status: "ACTIVE", tracked: true, tagName: TAG };

  it("is unchanged when no collection is selected", () => {
    // Every unscoped caller omits the new fields entirely; the defaults must
    // reproduce the old behaviour exactly.
    assert.equal(
      tags.resolveTagAction({ ...base, tags: [], quantity: 0 }),
      "add",
    );
    assert.equal(
      tags.resolveTagAction({ ...base, tags: [TAG], quantity: 5 }),
      "remove",
    );
  });

  it("applies both rules to a product inside the collection", () => {
    assert.equal(
      tags.resolveTagAction({
        ...base,
        tags: [],
        quantity: 0,
        collectionScoped: true,
        inCollection: true,
      }),
      "add",
    );
    assert.equal(
      tags.resolveTagAction({
        ...base,
        tags: [TAG],
        quantity: 5,
        collectionScoped: true,
        inCollection: true,
      }),
      "remove",
    );
  });

  it("touches nothing outside the collection, in either direction", () => {
    assert.equal(
      tags.resolveTagAction({
        ...base,
        tags: [],
        quantity: 0,
        collectionScoped: true,
        inCollection: false,
      }),
      null,
    );
    // Including a product that already carries the tag: stripping it would make
    // changing the scope a destructive act on products nobody asked about.
    assert.equal(
      tags.resolveTagAction({
        ...base,
        tags: [TAG],
        quantity: 5,
        collectionScoped: true,
        inCollection: false,
      }),
      null,
    );
  });

  it("treats an unreadable membership answer as 'outside'", () => {
    for (const inCollection of [undefined, null, "true", 1]) {
      assert.equal(
        tags.resolveTagAction({
          ...base,
          tags: [],
          quantity: 0,
          collectionScoped: true,
          inCollection,
        }),
        null,
        `inCollection ${JSON.stringify(inCollection)} must not be read as membership`,
      );
    }
  });

  it("still never touches a draft or archived product inside the collection", () => {
    for (const productStatus of ["DRAFT", "ARCHIVED"]) {
      assert.equal(
        tags.resolveTagAction({
          ...base,
          status: productStatus,
          tags: [],
          quantity: 0,
          collectionScoped: true,
          inCollection: true,
        }),
        null,
      );
    }
  });

  it("still removes the tag from an untracked product inside the collection", () => {
    assert.equal(
      tags.resolveTagAction({
        ...base,
        tracked: false,
        tags: [TAG],
        quantity: 0,
        collectionScoped: true,
        inCollection: true,
      }),
      "remove",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Automatic Inventory Sync (webhooks)
// ---------------------------------------------------------------------------

describe("Automatic Inventory Sync with a collection selected", () => {
  async function arrange(name, { collectionId = COLLECTION } = {}) {
    resetDb();
    const shop = nextShop(name);
    await tags.setSettings(shop, {
      autoSyncEnabled: true,
      ...(collectionId
        ? { collectionId, collectionTitle: "Summer Sale" }
        : { collectionId: null }),
    });
    return shop;
  }

  it("adds the tag to an out-of-stock product in the collection", async () => {
    const shop = await arrange("auto-add");
    const admin = new FakeAdmin([
      product({
        id: "gid://shopify/Product/1",
        totalInventory: 0,
        inventoryItemIds: [100],
        collectionIds: [COLLECTION],
      }),
    ]);

    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
  });

  it("removes the tag from a restocked product in the collection", async () => {
    const shop = await arrange("auto-remove");
    const admin = new FakeAdmin([
      product({
        id: "gid://shopify/Product/1",
        tags: ["sale", TAG],
        totalInventory: 12,
        inventoryItemIds: [100],
        collectionIds: [COLLECTION],
      }),
    ]);

    await deliverInventoryWebhook(shop, admin, 100);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), ["sale"]);
  });

  it("leaves an out-of-stock product outside the collection untagged", async () => {
    const shop = await arrange("auto-skip-add");
    const admin = new FakeAdmin([
      product({
        id: "gid://shopify/Product/2",
        totalInventory: 0,
        inventoryItemIds: [200],
        collectionIds: [OTHER_COLLECTION],
      }),
    ]);

    await deliverInventoryWebhook(shop, admin, 200);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/2"), []);
    assert.equal(admin.countCalls("addOutOfStockTag"), 0);
  });

  it("leaves a tag already on a product outside the collection alone", async () => {
    const shop = await arrange("auto-skip-remove");
    const admin = new FakeAdmin([
      product({
        id: "gid://shopify/Product/3",
        tags: [TAG],
        totalInventory: 9,
        inventoryItemIds: [300],
        collectionIds: [],
      }),
    ]);

    await deliverInventoryWebhook(shop, admin, 300);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/3"), [TAG]);
    assert.equal(admin.countCalls("removeOutOfStockTag"), 0);
  });

  it("scopes the products/create and products/update webhooks too", async () => {
    const shop = await arrange("auto-product-topics");
    const admin = new FakeAdmin([
      product({ id: "gid://shopify/Product/10", collectionIds: [COLLECTION] }),
      product({ id: "gid://shopify/Product/11", collectionIds: [OTHER_COLLECTION] }),
    ]);

    await deliverProductWebhook(shop, admin, "gid://shopify/Product/10", "products/create");
    await deliverProductWebhook(shop, admin, "gid://shopify/Product/11", "products/create");
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/10"), [TAG]);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/11"), []);

    await deliverProductWebhook(shop, admin, "gid://shopify/Product/11", "products/update");
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/11"), []);
  });

  it("asks Shopify for membership only when a collection is selected", async () => {
    const scoped = await arrange("auto-query-scoped");
    const scopedAdmin = new FakeAdmin([
      product({ id: "gid://shopify/Product/1", collectionIds: [COLLECTION] }),
    ]);
    await deliverInventoryWebhook(scoped, scopedAdmin, 100);
    assert.equal(scopedAdmin.countCalls("getProductForInventoryItemInCollection"), 1);
    assert.equal(scopedAdmin.countCalls("getProductForInventoryItem"), 0);

    const unscoped = await arrange("auto-query-unscoped", { collectionId: null });
    const unscopedAdmin = new FakeAdmin([product({ id: "gid://shopify/Product/1" })]);
    await deliverInventoryWebhook(unscoped, unscopedAdmin, 100);
    // The unscoped path must send the query it always sent, and cost what it
    // always cost.
    assert.equal(unscopedAdmin.countCalls("getProductForInventoryItem"), 1);
    assert.equal(unscopedAdmin.countCalls("getProductForInventoryItemInCollection"), 0);
  });

  it("still does nothing at all while Auto Sync is off", async () => {
    resetDb();
    const shop = nextShop("auto-off");
    await tags.setSettings(shop, {
      autoSyncEnabled: false,
      collectionId: COLLECTION,
      collectionTitle: "Summer Sale",
    });

    const admin = new FakeAdmin([
      product({ id: "gid://shopify/Product/1", collectionIds: [COLLECTION] }),
    ]);
    await deliverInventoryWebhook(shop, admin, 100);

    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), []);
    assert.equal(admin.calls.length, 0);
  });

  it("keeps the unscoped flow byte-for-byte unchanged", async () => {
    const shop = await arrange("auto-unscoped", { collectionId: null });
    const admin = new FakeAdmin([
      product({ id: "gid://shopify/Product/1", totalInventory: 0, inventoryItemIds: [100] }),
      product({
        id: "gid://shopify/Product/2",
        tags: [TAG],
        totalInventory: 4,
        inventoryItemIds: [200],
      }),
    ]);

    await deliverInventoryWebhook(shop, admin, 100);
    await deliverInventoryWebhook(shop, admin, 200);

    // Neither product belongs to any collection, and both are still processed.
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/1"), [TAG]);
    assert.deepEqual(admin.tagsOf("gid://shopify/Product/2"), []);
  });
});

// ---------------------------------------------------------------------------
// 4. Manual Full Catalog Sync
// ---------------------------------------------------------------------------

/** Drives a manual sync the way the dashboard does and returns the final job. */
async function runManualSync(simulator, shop, scope = {}) {
  setAdmin(simulator.admin);
  const settings = await tags.getSettings(shop);

  await bulkSync.startBulkSync(simulator.admin, shop, settings.tagName, {
    collectionId: settings.collectionId,
    collectionTitle: settings.collectionTitle,
    ...scope,
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    const job = await bulkSync.tickBulkSync(shop);
    if (status.isBulkSyncFinished(job)) return job;
    if (Date.now() > deadline) throw new Error(`sync did not finish: ${job.status}`);
    await delay(5);
  }
}

describe("Manual Full Catalog Sync scoping", () => {
  it("asks Shopify for the whole active catalog when no collection is selected", async () => {
    resetDb();
    const shop = nextShop("manual-unscoped");
    const simulator = await new ShopifySimulator({ productCount: 60 }).start();

    try {
      const job = await runManualSync(simulator, shop);

      assert.deepEqual(simulator.bulkQueries, ["status:active"]);
      assert.equal(job.status, "completed");
      assert.equal(job.collectionId, null);
      assert.equal(job.processed, 60);
      // 0,3,6… need the tag; 5,10,20… (not multiples of 3) need it removed.
      assert.equal(job.tagged, 20);
      assert.equal(job.untagged, 8);
    } finally {
      await simulator.stop();
    }
  });

  it("filters the export to the selected collection", async () => {
    resetDb();
    const shop = nextShop("manual-scoped");
    await tags.setSettings(shop, {
      collectionId: COLLECTION,
      collectionTitle: "Summer Sale",
    });

    const simulator = await new ShopifySimulator({
      productCount: 500,
      // The collection holds 12 products, every one of them out of stock and
      // untagged, so the run must tag exactly those 12 and nothing else.
      collectionProductCount: 12,
      collectionCatalog: (i) => ({
        id: `gid://shopify/Product/${2_000_000 + i}`,
        status: "ACTIVE",
        tags: [],
        totalInventory: 0,
        tracksInventory: true,
      }),
    }).start();

    try {
      const job = await runManualSync(simulator, shop);

      assert.deepEqual(simulator.bulkQueries, [
        "status:active AND collection_id:555",
      ]);
      assert.equal(job.status, "completed");
      assert.equal(job.collectionId, COLLECTION);
      assert.equal(job.collectionTitle, "Summer Sale");
      assert.equal(job.processed, 12, "only the collection's products are scanned");
      assert.equal(job.tagged, 12);
      assert.equal(job.untagged, 0);
      assert.equal(job.failed, 0);
    } finally {
      await simulator.stop();
    }
  });

  it("applies both rules within the collection", async () => {
    resetDb();
    const shop = nextShop("manual-both-rules");
    await tags.setSettings(shop, { collectionId: "555", collectionTitle: "Summer Sale" });

    const simulator = await new ShopifySimulator({
      productCount: 500,
      collectionProductCount: 10,
      // Half out of stock and untagged (add), half in stock and tagged (remove).
      collectionCatalog: (i) =>
        i % 2 === 0
          ? {
              id: `gid://shopify/Product/${3_000_000 + i}`,
              status: "ACTIVE",
              tags: [],
              totalInventory: 0,
              tracksInventory: true,
            }
          : {
              id: `gid://shopify/Product/${3_000_000 + i}`,
              status: "ACTIVE",
              tags: [TAG, "seasonal"],
              totalInventory: 7,
              tracksInventory: true,
            },
    }).start();

    try {
      const job = await runManualSync(simulator, shop);

      assert.equal(job.status, "completed");
      assert.equal(job.processed, 10);
      assert.equal(job.tagged, 5);
      assert.equal(job.untagged, 5);
    } finally {
      await simulator.stop();
    }
  });

  it("completes cleanly when the selected collection is empty", async () => {
    resetDb();
    const shop = nextShop("manual-empty");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Empty" });

    const simulator = await new ShopifySimulator({
      productCount: 500,
      collectionProductCount: 0,
      collectionCatalog: () => ({}),
    }).start();

    try {
      const job = await runManualSync(simulator, shop);
      assert.equal(job.status, "completed");
      assert.equal(job.processed, 0);
      assert.equal(job.tagged, 0);
      assert.equal(job.untagged, 0);
    } finally {
      await simulator.stop();
    }
  });

  it("pins the scope onto the job, so changing it mid-run cannot retarget it", async () => {
    resetDb();
    const shop = nextShop("manual-pinned");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });

    const simulator = await new ShopifySimulator({
      productCount: 500,
      collectionProductCount: 6,
      collectionCatalog: (i) => ({
        id: `gid://shopify/Product/${4_000_000 + i}`,
        status: "ACTIVE",
        tags: [],
        totalInventory: 0,
        tracksInventory: true,
      }),
    }).start();

    try {
      setAdmin(simulator.admin);
      const settings = await tags.getSettings(shop);
      await bulkSync.startBulkSync(simulator.admin, shop, settings.tagName, {
        collectionId: settings.collectionId,
        collectionTitle: settings.collectionTitle,
      });

      // The merchant changes their mind while the export is running.
      await tags.setSettings(shop, { collectionId: null });

      const deadline = Date.now() + 60_000;
      let job;
      for (;;) {
        job = await bulkSync.tickBulkSync(shop);
        if (status.isBulkSyncFinished(job)) break;
        if (Date.now() > deadline) throw new Error(`sync did not finish: ${job.status}`);
        await delay(5);
      }

      assert.deepEqual(simulator.bulkQueries, ["status:active AND collection_id:555"]);
      assert.equal(job.collectionId, COLLECTION);
      assert.equal(job.processed, 6);
    } finally {
      await simulator.stop();
    }
  });

  it("builds the export query from the scope, and only from the scope", () => {
    assert.match(bulkSync.productsBulkQuery(null), /products\(query: "status:active"\)/);
    assert.match(bulkSync.productsBulkQuery(undefined), /products\(query: "status:active"\)/);
    assert.match(
      bulkSync.productsBulkQuery(COLLECTION),
      /products\(query: "status:active AND collection_id:555"\)/,
    );
    assert.match(
      bulkSync.productsBulkQuery("555"),
      /products\(query: "status:active AND collection_id:555"\)/,
    );
    // A scope that cannot be read as a collection id must not become part of
    // the query string; it falls back to the safe, documented filter.
    assert.match(
      bulkSync.productsBulkQuery("gid://shopify/Product/555"),
      /products\(query: "status:active"\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. What the dashboard says about the scope
// ---------------------------------------------------------------------------

describe("scope in the dashboard copy", () => {
  const finished = (extra) => ({
    status: "completed",
    processed: 1200,
    tagged: 14,
    untagged: 3,
    failed: 0,
    startedAt: new Date("2026-09-22T10:00:00Z"),
    finishedAt: new Date("2026-09-22T10:00:12Z"),
    updatedAt: new Date("2026-09-22T10:00:12Z"),
    ...extra,
  });

  it("leaves an unscoped run's wording exactly as it was", () => {
    const label = status.bulkSyncStatusLabel(finished({ collectionId: null }));
    assert.equal(
      label,
      "Sync complete — scanned 1,200 products, tagged 14, untagged 3.",
    );
    assert.equal(
      status.bulkSyncView({ job: finished({ collectionId: null }) }).stats.find(
        (s) => s.label === "Scope",
      ),
      undefined,
    );
  });

  it("names the collection on a scoped run", () => {
    const job = finished({ collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    assert.match(status.bulkSyncStatusLabel(job), /scanned 1,200 products in “Summer Sale”/);
    assert.equal(
      status.bulkSyncView({ job }).stats.find((s) => s.label === "Scope").value,
      "Summer Sale",
    );
  });

  it("falls back gracefully when the collection title is unknown", () => {
    const job = finished({ collectionId: COLLECTION, collectionTitle: null });
    assert.match(status.bulkSyncStatusLabel(job), /in the selected collection/);
  });

  it("labels the scope for the settings card", () => {
    assert.equal(status.syncScopeLabel({}), "Entire product catalog");
    assert.equal(
      status.syncScopeLabel({ collectionId: COLLECTION, collectionTitle: "Summer Sale" }),
      "Collection: Summer Sale",
    );
    assert.equal(
      status.syncScopeLabel({ collectionId: COLLECTION }),
      "Selected collection",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. The collection picker's data source
// ---------------------------------------------------------------------------

describe("collection list for the picker", () => {
  it("returns id and title pairs", async () => {
    const admin = new FakeAdmin([]);
    admin.collections = [
      { id: COLLECTION, title: "Summer Sale" },
      { id: OTHER_COLLECTION, title: "Clearance" },
    ];

    assert.deepEqual(await tags.fetchCollections(admin), [
      { id: COLLECTION, title: "Summer Sale" },
      { id: OTHER_COLLECTION, title: "Clearance" },
    ]);
  });

  it("skips rows Shopify could not give an id for", async () => {
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: null, title: "Broken" }, { id: COLLECTION, title: "Summer Sale" }];

    assert.deepEqual(await tags.fetchCollections(admin), [
      { id: COLLECTION, title: "Summer Sale" },
    ]);
  });
});
