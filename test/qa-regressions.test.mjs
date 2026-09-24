// Regression tests for the defects found in the end-to-end QA pass of the
// dashboard, the Manual Full Catalog Sync and the collection scope. Each block
// names the defect it pins down; the assertions describe what a merchant sees
// or what ends up stored, not which functions were called.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Read at module load by the sync service.
process.env.BULK_SYNC_POLL_MS = "5";
process.env.BULK_SYNC_PROGRESS_BATCH = "100";
process.env.BULK_SYNC_LEASE_MS = "30000";

import { ShopifySimulator } from "./support/shopify-simulator.mjs";
import { resetDb, seed } from "./support/fake-db.mjs";
import { FakeAdmin } from "./support/fake-admin.mjs";
import { setAdmin, setAdminSession } from "./support/fake-shopify-server.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const COLLECTION = "gid://shopify/Collection/555";
const TAG = "out-of-stock-hidden";

let shopCounter = 0;
const nextShop = (name) => `regress-${name}-${++shopCounter}.myshopify.com`;

let tags;
let bulkSync;
let status;
let dashboard;

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
});

const finishedJob = (extra = {}) => ({
  status: "completed",
  tagName: TAG,
  collectionId: null,
  collectionTitle: null,
  processed: 7,
  total: 7,
  toTag: 2,
  toUntag: 0,
  tagged: 2,
  untagged: 0,
  failed: 0,
  addMutationBulkOperationId: null,
  removeMutationBulkOperationId: null,
  startedAt: new Date("2026-09-24T10:00:00Z"),
  finishedAt: new Date("2026-09-24T10:00:12Z"),
  updatedAt: new Date("2026-09-24T10:00:12Z"),
  ...extra,
});

function dashboardRequest(fields) {
  if (!fields) return new Request("http://localhost/app/inventory-tags");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request("http://localhost/app/inventory-tags", { method: "POST", body });
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
// Dashboard: a second run in the same page session was never shown.
// ---------------------------------------------------------------------------

describe("merging job snapshots from the start, poll and cancel fetchers", () => {
  const previousRun = finishedJob();
  const newRun = {
    ...finishedJob(),
    status: "querying",
    tagged: 0,
    finishedAt: null,
    startedAt: new Date("2026-09-24T10:05:00Z"),
    updatedAt: new Date("2026-09-24T10:05:00Z"),
  };

  it("keeps a newly started run over the previous run's last poll", () => {
    // The previous run's final poll answer sits on its fetcher indefinitely;
    // re-applying it hid the new run and stopped polling.
    assert.equal(status.newerJob(newRun, previousRun), newRun);
    assert.equal(status.newerJob(previousRun, newRun), newRun);
  });

  it("keeps a cancellation over a poll of the same run answered before it", () => {
    const running = { ...newRun, status: "downloading", updatedAt: new Date("2026-09-24T10:05:04Z") };
    const cancelled = { ...newRun, status: "cancelled", updatedAt: new Date("2026-09-24T10:05:05Z") };
    assert.equal(status.newerJob(cancelled, running), cancelled);
    assert.equal(status.newerJob(running, cancelled), cancelled);
  });

  it("accepts the incoming snapshot when timestamps are unusable", () => {
    const a = { status: "querying" };
    const b = { status: "downloading" };
    assert.equal(status.newerJob(a, b), b);
    assert.equal(status.newerJob(null, b), b);
    assert.equal(status.newerJob(a, null), a);
    assert.equal(status.newerJob(null, undefined), null);
  });

  it("accepts dates serialised as strings", () => {
    const stale = { ...previousRun, startedAt: previousRun.startedAt.toISOString() };
    assert.equal(status.newerJob(newRun, stale), newRun);
  });
});

// ---------------------------------------------------------------------------
// Outcome banner: failures dressed up as success, and copy defects.
// ---------------------------------------------------------------------------

describe("outcome banner", () => {
  it("does not present a run with rejected updates as a clean success", () => {
    const view = status.bulkSyncView({
      job: finishedJob({ tagged: 0, failed: 2, addMutationBulkOperationId: "op" }),
    });
    assert.equal(view.tone, "warning");
    assert.equal(view.heading, "Sync finished with errors");
    assert.match(view.statusText, /^Sync finished with errors — /);
    assert.match(view.statusText, /2 failed\.$/);
  });

  it("never says 'already up to date' when every update failed", () => {
    // tagged = untagged = 0 here too, which is what the old check looked at.
    const view = status.bulkSyncView({
      job: finishedJob({ toTag: 2, tagged: 0, failed: 2 }),
    });
    assert.ok(!view.notes.some((n) => /up to date/.test(n)), view.notes.join(" | "));
    assert.ok(view.notes.some((n) => /2 products could not be updated/.test(n)));
  });

  it("says 'already up to date' only when the scan found nothing to change", () => {
    const view = status.bulkSyncView({ job: finishedJob({ toTag: 0, tagged: 0 }) });
    assert.equal(view.tone, "success");
    assert.ok(view.notes.some((n) => /already up to date/.test(n)));

    const changed = status.bulkSyncView({ job: finishedJob() });
    assert.ok(!changed.notes.some((n) => /up to date/.test(n)));
  });

  it("explains an empty scan rather than implying the catalog is fine", () => {
    const scoped = status.bulkSyncView({
      job: finishedJob({
        processed: 0, total: 0, toTag: 0, tagged: 0,
        collectionId: COLLECTION, collectionTitle: "Summer Sale",
      }),
    });
    assert.ok(scoped.notes.some((n) => /No active products were found in “Summer Sale”/.test(n)));

    const unscoped = status.bulkSyncView({
      job: finishedJob({ processed: 0, total: 0, toTag: 0, tagged: 0 }),
    });
    assert.ok(unscoped.notes.some((n) => /No active products were found in your store/.test(n)));
  });

  it("agrees the noun with the number: 1 product, 2 products", () => {
    assert.match(
      status.bulkSyncStatusLabel(finishedJob({ processed: 1, total: 1, tagged: 1, toTag: 1 })),
      /scanned 1 product,/,
    );
    assert.match(status.bulkSyncStatusLabel(finishedJob()), /scanned 7 products,/);
    assert.equal(
      status.bulkSyncStatusLabel({ status: "downloading", processed: 0, total: 1 }),
      "Scanning 0 of 1 product…",
    );
    assert.equal(
      status.bulkSyncStatusLabel({ status: "tagging", mutationProcessed: 0, toTag: 1 }),
      "Applying the tag — 0 of 1 product…",
    );
    assert.equal(status.formatProductCount(1), "1 product");
    assert.equal(status.formatProductCount(0), "0 products");
    assert.equal(status.formatProductCount(12_000), `${(12_000).toLocaleString()} products`);
  });

  it("names the collection while exporting, as it already did while scanning", () => {
    assert.match(
      status.bulkSyncStatusLabel({
        status: "querying", exported: 3, collectionId: COLLECTION, collectionTitle: "Summer Sale",
      }),
      /^Exporting products in “Summer Sale” from Shopify — 3 found so far…$/,
    );
    // Unscoped wording is unchanged.
    assert.equal(
      status.bulkSyncStatusLabel({ status: "querying", exported: 0 }),
      "Exporting products from Shopify — waiting for the export to start…",
    );
  });

  it("states the duration once: a tile for a completed run, a note otherwise", () => {
    const completed = status.bulkSyncView({ job: finishedJob() });
    assert.ok(completed.stats.some((s) => s.label === "Duration"));
    assert.ok(!completed.notes.some((n) => /Ran for/.test(n)));

    const failed = status.bulkSyncView({
      job: finishedJob({ status: "failed", errorMessage: "Shopify export failed" }),
    });
    assert.equal(failed.stats.length, 0);
    assert.ok(failed.notes.includes("Ran for 12s before stopping."));
  });

  it("tells the merchant whether a cancelled run had already changed products", () => {
    const early = status.bulkSyncView({ job: finishedJob({ status: "cancelled" }) });
    assert.ok(early.notes.some((n) => /before any product was changed/.test(n)));

    const midway = status.bulkSyncView({
      job: finishedJob({ status: "cancelled", addMutationBulkOperationId: "op" }),
    });
    assert.ok(midway.notes.some((n) => /some products may already have changed/.test(n)));
  });

  it("keeps a start failure free of job-derived context", () => {
    const view = status.bulkSyncView({ job: finishedJob(), startError: "nope" });
    assert.equal(view.startFailed, true);
    assert.deepEqual(view.notes, []);
  });
});

describe("result age and settings drift", () => {
  it("reports how long ago a result was produced", () => {
    const job = finishedJob();
    const at = (ms) => status.bulkSyncFinishedAgoLabel(job, job.finishedAt.getTime() + ms);
    assert.equal(at(5_000), "just now");
    assert.equal(at(-5_000), "just now", "a slightly fast server clock must not go negative");
    assert.equal(at(60_000), "1 minute ago");
    assert.equal(at(5 * 60_000), "5 minutes ago");
    assert.equal(at(3 * 3_600_000), "3 hours ago");
    assert.equal(at(4 * 86_400_000), "4 days ago");
    assert.equal(status.bulkSyncFinishedAgoLabel({ status: "querying" }), null);
  });

  it("flags a result produced under a different scope", () => {
    const job = finishedJob({ collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    assert.match(
      status.bulkSyncSettingsDrift(job, { tagName: TAG, collectionId: null }),
      /it scanned “Summer Sale”/,
    );
    assert.match(
      status.bulkSyncSettingsDrift(finishedJob(), { tagName: TAG, collectionId: COLLECTION }),
      /it scanned the entire catalog/,
    );
  });

  it("flags a result produced under a different tag, but not a case-only change", () => {
    assert.match(
      status.bulkSyncSettingsDrift(finishedJob(), { tagName: "sold-out", collectionId: null }),
      /it used the tag “out-of-stock-hidden”/,
    );
    // One tag to Shopify, so nothing to re-run.
    assert.equal(
      status.bulkSyncSettingsDrift(finishedJob(), { tagName: " OUT-of-stock-Hidden ", collectionId: null }),
      null,
    );
  });

  it("stays quiet when the settings match, or when the run did not complete", () => {
    assert.equal(status.bulkSyncSettingsDrift(finishedJob(), { tagName: TAG, collectionId: null }), null);
    assert.equal(
      status.bulkSyncSettingsDrift(finishedJob({ status: "failed" }), { tagName: "x", collectionId: null }),
      null,
    );
  });

  it("compares tag names the way Shopify does", () => {
    assert.ok(status.isSameTag("Out-Of-Stock", "out-of-stock"));
    assert.ok(status.isSameTag("  sold   out ", "sold out"));
    assert.ok(!status.isSameTag("sold-out", "out-of-stock"));
  });
});

// ---------------------------------------------------------------------------
// Failure messages shown to merchants.
// ---------------------------------------------------------------------------

describe("merchant-facing error messages", () => {
  it("turns an exhausted retry budget into a try-again-later message", () => {
    const error = new Error("bulkOperationRunQuery: giving up after 6 attempts (bulkOperationRunQuery: throttled)");
    error.exhausted = true;
    assert.match(bulkSync.friendlyError(error), /^Shopify is busy or temporarily unavailable/);
  });

  it("hides raw GraphQL payloads", () => {
    const message = bulkSync.friendlyError(
      new Error('bulkOperationStatus: [{"message":"Internal error. Looks like something went wrong on our end."}]'),
    );
    assert.equal(message, "Shopify returned an unexpected error. Please try again.");
    assert.ok(!/[[{]/.test(message));
  });

  it("names a permissions problem as one", () => {
    assert.match(
      bulkSync.friendlyError(new Error("bulkOperationRunQuery: HTTP 403 Forbidden")),
      /denied the app access/,
    );
    assert.match(
      bulkSync.friendlyError(new Error('tagsAdd: [{"extensions":{"code":"ACCESS_DENIED"}}]')),
      /denied the app access/,
    );
  });

  it("passes the app's own, already-readable messages through", () => {
    const own = "Shopify export result is no longer available. Run the sync again.";
    assert.equal(bulkSync.friendlyError(new Error(own)), own);
    assert.match(bulkSync.friendlyError(new Error("Malformed JSONL at line 4: x")), /could not read/);
  });

  it("stores the readable message when a start is throttled out", async () => {
    resetDb();
    const shop = nextShop("throttled-start");
    const simulator = await new ShopifySimulator({ productCount: 10, throttleCount: 10_000 }).start();
    try {
      setAdmin(simulator.admin);
      setAdminSession({ shop, admin: simulator.admin });

      const result = await dashboard.action({ request: dashboardRequest({ intent: "run-sync" }) });

      assert.match(result.error, /^Shopify is busy or temporarily unavailable/);
      const job = await bulkSync.getBulkSyncJob(shop);
      assert.equal(job.status, "failed");
      assert.equal(job.errorMessage, result.error);
      assert.match(status.bulkSyncStatusLabel(job), /^Sync failed: Shopify is busy/);
    } finally {
      await simulator.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Data: values the form accepts must fit the columns they are stored in.
// ---------------------------------------------------------------------------

describe("stored field widths", () => {
  const schema = fs.readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const widthOf = (model, field) => {
    const block = schema.match(new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`))[1];
    const line = block.split("\n").find((l) => l.trim().startsWith(`${field} `));
    const width = line?.match(/@db\.VarChar\((\d+)\)/);
    // Prisma's MySQL default for a bare String is VARCHAR(191).
    return width ? Number(width[1]) : 191;
  };

  it("fits every tag name the validator accepts, in both tables", () => {
    for (const model of ["TagAutomationSetting", "BulkSyncJob"]) {
      assert.ok(
        widthOf(model, "tagName") >= tags.MAX_TAG_LENGTH,
        `${model}.tagName is narrower than the ${tags.MAX_TAG_LENGTH}-character tags the form accepts`,
      );
    }
  });

  it("fits every collection title Shopify allows, in both tables", () => {
    for (const model of ["TagAutomationSetting", "BulkSyncJob"]) {
      assert.ok(widthOf(model, "collectionTitle") >= tags.MAX_COLLECTION_TITLE_LENGTH);
    }
  });

  it("ships a migration that widens the columns already deployed at 191", () => {
    const dir = path.join(ROOT, "prisma/migrations");
    const sql = fs
      .readdirSync(dir)
      .filter((name) => fs.existsSync(path.join(dir, name, "migration.sql")))
      .map((name) => fs.readFileSync(path.join(dir, name, "migration.sql"), "utf8"))
      .join("\n");
    for (const table of ["TagAutomationSetting", "BulkSyncJob"]) {
      const statement = sql.match(new RegExp(`ALTER TABLE \`${table}\` MODIFY[^;]*;`))?.[0] ?? "";
      assert.match(statement, /`tagName` VARCHAR\(255\)/, `${table}.tagName`);
      assert.match(statement, /`collectionTitle` VARCHAR\(255\)/, `${table}.collectionTitle`);
    }
  });

  it("shortens an over-long collection title instead of failing the save", async () => {
    resetDb();
    const shop = nextShop("long-title");
    const long = "🌞".repeat(300);
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: long });

    const stored = (await tags.getSettings(shop)).collectionTitle;
    assert.equal(Array.from(stored).length, tags.MAX_COLLECTION_TITLE_LENGTH);
    // Cut on code points: no half of a surrogate pair left dangling.
    assert.ok(!/[\uD800-\uDBFF]$/.test(stored));
  });

  it("clips the title pinned onto a run the same way", async () => {
    resetDb();
    const shop = nextShop("long-title-job");
    const simulator = await new ShopifySimulator({ productCount: 0, queryPolls: 1 }).start();
    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, {
        collectionId: COLLECTION,
        collectionTitle: "x".repeat(400),
      });
      const job = await waitForFinish(shop);
      assert.equal(job.collectionTitle.length, tags.MAX_COLLECTION_TITLE_LENGTH);
    } finally {
      await simulator.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Collection scope: deleted and renamed collections.
// ---------------------------------------------------------------------------

describe("looking up the saved collection", () => {
  it("returns the live id and title", async () => {
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: COLLECTION, title: "Summer Sale" }];
    assert.deepEqual(await tags.fetchCollection(admin, COLLECTION), {
      id: COLLECTION,
      title: "Summer Sale",
    });
  });

  it("returns null for a collection that no longer exists", async () => {
    const admin = new FakeAdmin([]);
    admin.collections = [];
    assert.equal(await tags.fetchCollection(admin, COLLECTION), null);
  });

  it("throws, rather than answering 'deleted', when Shopify cannot be asked", async () => {
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: COLLECTION, title: "Summer Sale" }];
    admin.failNext = 10;
    await assert.rejects(() => tags.fetchCollection(admin, COLLECTION));
  });
});

describe("dashboard loader", () => {
  async function load(shop, admin) {
    setAdminSession({ shop, admin });
    return dashboard.loader({ request: dashboardRequest() });
  }

  it("warns when the saved collection was deleted in Shopify", async () => {
    resetDb();
    const shop = nextShop("loader-deleted");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: "gid://shopify/Collection/999", title: "Clearance" }];

    const data = await load(shop, admin);
    assert.equal(data.collectionMissing, true);
    // The saved selection itself is kept, so the merchant sees what was lost.
    assert.equal(data.collectionId, COLLECTION);
    assert.equal(data.collectionTitle, "Summer Sale");
  });

  it("shows a renamed collection under its current name", async () => {
    resetDb();
    const shop = nextShop("loader-renamed");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: COLLECTION, title: "Summer Sale 2026" }];

    const data = await load(shop, admin);
    assert.equal(data.collectionMissing, false);
    assert.equal(data.collectionTitle, "Summer Sale 2026");
  });

  it("does not call an outage a deleted collection", async () => {
    resetDb();
    const shop = nextShop("loader-outage");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    const admin = new FakeAdmin([]);
    admin.collections = [{ id: COLLECTION, title: "Summer Sale" }];
    admin.failNext = 100;

    const data = await load(shop, admin);
    assert.equal(data.collectionMissing, false);
    assert.equal(data.collectionsUnavailable, true);
    assert.equal(data.collectionTitle, "Summer Sale");
  });

  it("makes no lookup at all without a scope", async () => {
    resetDb();
    const shop = nextShop("loader-unscoped");
    const admin = new FakeAdmin([]);
    admin.collections = [];

    const data = await load(shop, admin);
    assert.equal(data.collectionMissing, false);
    assert.equal(admin.countCalls("dashboardCollection"), 0);
  });
});

describe("Run sync now with a collection scope", () => {
  it("refuses to run against a deleted collection instead of reporting a false success", async () => {
    resetDb();
    const shop = nextShop("run-deleted");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    const simulator = await new ShopifySimulator({ productCount: 50, collections: [] }).start();
    try {
      setAdmin(simulator.admin);
      setAdminSession({ shop, admin: simulator.admin });

      const result = await dashboard.action({ request: dashboardRequest({ intent: "run-sync" }) });

      assert.match(result.error, /“Summer Sale” no longer exists in Shopify/);
      assert.equal(simulator.countCalls("startBulkProductQuery"), 0, "no export may be started");
      assert.equal(await bulkSync.getBulkSyncJob(shop), null);
      // The refusal must reload the page data, which is what surfaces the warning.
      assert.equal(
        dashboard.shouldRevalidate({ actionResult: result, defaultShouldRevalidate: true }),
        true,
      );
    } finally {
      await simulator.stop();
    }
  });

  it("runs a renamed collection under its current name and refreshes the stored one", async () => {
    resetDb();
    const shop = nextShop("run-renamed");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    const simulator = await new ShopifySimulator({
      productCount: 50,
      queryPolls: 1,
      mutationPolls: 1,
      collections: [{ id: COLLECTION, title: "Summer Sale 2026" }],
      collectionProductCount: 3,
      collectionCatalog: (i) => ({
        id: `gid://shopify/Product/${5_000_000 + i}`,
        status: "ACTIVE",
        tags: [],
        totalInventory: 0,
        tracksInventory: true,
      }),
    }).start();
    try {
      setAdmin(simulator.admin);
      setAdminSession({ shop, admin: simulator.admin });

      const result = await dashboard.action({ request: dashboardRequest({ intent: "run-sync" }) });
      assert.equal(result.error, undefined);
      assert.equal(result.job.collectionTitle, "Summer Sale 2026");
      assert.equal((await tags.getSettings(shop)).collectionTitle, "Summer Sale 2026");

      const job = await waitForFinish(shop);
      assert.equal(job.status, "completed");
      assert.equal(job.tagged, 3);
      assert.match(status.bulkSyncStatusLabel(job), /scanned 3 products in “Summer Sale 2026”/);
      assert.deepEqual(simulator.bulkQueries, ["status:active AND collection_id:555"]);
    } finally {
      await simulator.stop();
    }
  });

  it("still starts when the collection cannot be checked", async () => {
    resetDb();
    const shop = nextShop("run-unknown");
    await tags.setSettings(shop, { collectionId: COLLECTION, collectionTitle: "Summer Sale" });
    // The lookup (2 attempts) is throttled away; the export itself goes through.
    const simulator = await new ShopifySimulator({
      productCount: 50,
      queryPolls: 1,
      mutationPolls: 1,
      throttleCount: 2,
      collectionProductCount: 0,
      collectionCatalog: () => ({}),
    }).start();
    try {
      setAdmin(simulator.admin);
      setAdminSession({ shop, admin: simulator.admin });

      const result = await dashboard.action({ request: dashboardRequest({ intent: "run-sync" }) });
      assert.equal(result.error, undefined);
      assert.equal(result.job.collectionTitle, "Summer Sale");
      await waitForFinish(shop);
    } finally {
      await simulator.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Page reloads after actions.
// ---------------------------------------------------------------------------

describe("which actions reload the dashboard data", () => {
  const reloads = (actionResult) =>
    dashboard.shouldRevalidate({ actionResult, defaultShouldRevalidate: true });

  it("skips the reload for actions whose result the page applies itself", () => {
    // Each reload refetches up to 1,250 collections from Shopify.
    assert.equal(reloads({ intent: "check-sync", job: {} }), false);
    assert.equal(reloads({ intent: "cancel-sync", job: {} }), false);
    assert.equal(reloads({ intent: "toggle-auto-sync", autoSyncEnabled: true }), false);
    assert.equal(reloads({ intent: "run-sync", job: {} }), false);
  });

  it("reloads after saving settings and after a refused start", () => {
    assert.equal(reloads({ intent: "save-settings", tagName: TAG }), true);
    assert.equal(reloads({ intent: "run-sync", error: "nope" }), true);
    assert.equal(reloads(undefined), true);
  });
});

// ---------------------------------------------------------------------------
// Long runs: a few hundred thousand products take hours, not minutes.
// ---------------------------------------------------------------------------

/**
 * Offline access tokens expire after an hour, and the library refreshes one
 * only when a client is created and the token is close to expiry. Modelled in
 * API calls rather than wall-clock time so the test is deterministic: each token
 * is good for `lifetime` calls and is replaced once `refreshWithin` or fewer
 * remain — the same rule as ensureOfflineTokenIsNotExpired.
 */
function expiringTokenAdmins(simulator, { lifetime = 6, refreshWithin = 4 } = {}) {
  let token = { remaining: lifetime };
  let issued = 1;
  let rejected = 0;
  const factory = async () => {
    if (token.remaining <= refreshWithin) {
      token = { remaining: lifetime };
      issued += 1;
    }
    const bound = token;
    return {
      graphql: async (query, options) => {
        if (bound.remaining <= 0) {
          rejected += 1;
          return new Response('{"errors":"[API] Invalid API key or access token"}', {
            status: 401,
          });
        }
        bound.remaining -= 1;
        return simulator.graphql(query, options);
      },
    };
  };
  return { factory, issued: () => issued, rejected: () => rejected };
}

/** A tag mutation already running at Shopify, as a restarted app would find it. */
async function runningTagMutation(simulator, rows) {
  simulator.uploads.set("tmp/seeded", rows);
  const response = await simulator.graphql(
    "mutation runBulkMutation($mutation: String!, $stagedUploadPath: String!) { x }",
    { variables: { mutation: "mutation call { tagsAdd }", stagedUploadPath: "tmp/seeded" } },
  );
  return (await response.json()).data.bulkOperationRunMutation.bulkOperation.id;
}

function seedTaggingJob(shop, operationId, rows, { startedAgoMs, lastProgressAgoMs }) {
  seed("bulkSyncJob", "shop", {
    ...finishedJob(),
    shop,
    status: "tagging",
    processed: rows,
    total: rows,
    exported: rows,
    toTag: rows,
    tagged: 0,
    mutationProcessed: 0,
    queryBulkOperationId: "gid://shopify/BulkOperation/0",
    addMutationBulkOperationId: operationId,
    addJsonlPath: null,
    removeJsonlPath: null,
    attempts: 0,
    lockedBy: null,
    lockedUntil: null,
    lastProgressCount: 0,
    startedAt: new Date(Date.now() - startedAgoMs),
    lastProgressAt: new Date(Date.now() - lastProgressAgoMs),
    finishedAt: null,
    updatedAt: new Date(Date.now() - lastProgressAgoMs),
  });
}

describe("long-running syncs", () => {
  it("keeps working after the access token it started with has expired", async () => {
    resetDb();
    const shop = nextShop("token-expiry");
    const simulator = await new ShopifySimulator({
      productCount: 600,
      queryPolls: 4,
      mutationPolls: 4,
    }).start();
    try {
      const tokens = expiringTokenAdmins(simulator);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG, { adminFactory: tokens.factory });
      const job = await waitForFinish(shop);

      assert.equal(job.status, "completed", job.errorMessage ?? "");
      assert.equal(job.tagged, job.toTag);
      assert.equal(job.untagged, job.toUntag);
      assert.equal(tokens.rejected(), 0, "no call may go out on an expired token");
      assert.ok(tokens.issued() > 1, "the run outlived its first token, so it must have refreshed");
    } finally {
      await simulator.stop();
    }
  });

  it("does not cancel an operation Shopify kept running while the app was down", async () => {
    resetDb();
    const shop = nextShop("downtime");
    const simulator = await new ShopifySimulator({ productCount: 0, mutationPolls: 2 }).start();
    try {
      setAdmin(simulator.admin);
      const operationId = await runningTagMutation(simulator, 500);
      // Two hours in; nothing recorded for the last 45 minutes (the stall
      // window is 30) because the app was restarted and nobody opened it.
      seedTaggingJob(shop, operationId, 500, {
        startedAgoMs: 2 * 3_600_000,
        lastProgressAgoMs: 45 * 60_000,
      });

      const job = await waitForFinish(shop);

      assert.equal(job.status, "completed", job.errorMessage ?? "");
      assert.equal(job.tagged, 500);
      assert.equal(simulator.countCalls("cancelBulkOperation"), 0);
    } finally {
      await simulator.stop();
    }
  });

  it("allows a healthy run Shopify's full 24 hours, not 6", async () => {
    resetDb();
    const shop = nextShop("seven-hours");
    const simulator = await new ShopifySimulator({ productCount: 0, mutationPolls: 2 }).start();
    try {
      setAdmin(simulator.admin);
      const operationId = await runningTagMutation(simulator, 300);
      seedTaggingJob(shop, operationId, 300, {
        startedAgoMs: 7 * 3_600_000,
        lastProgressAgoMs: 5_000,
      });

      const job = await waitForFinish(shop);

      assert.equal(job.status, "completed", job.errorMessage ?? "");
      assert.equal(job.tagged, 300);
      assert.equal(simulator.countCalls("cancelBulkOperation"), 0);
    } finally {
      await simulator.stop();
    }
  });

  it("still stops a run that has passed the ceiling", async () => {
    resetDb();
    const shop = nextShop("past-ceiling");
    const simulator = await new ShopifySimulator({ productCount: 0, mutationPolls: 50 }).start();
    try {
      setAdmin(simulator.admin);
      const operationId = await runningTagMutation(simulator, 300);
      seedTaggingJob(shop, operationId, 300, {
        startedAgoMs: 25 * 3_600_000,
        lastProgressAgoMs: 5_000,
      });

      const job = await waitForFinish(shop);

      assert.equal(job.status, "failed");
      assert.equal(job.errorMessage, "Sync exceeded the maximum run time of 24 hours.");
      assert.equal(simulator.countCalls("cancelBulkOperation"), 1);
    } finally {
      await simulator.stop();
    }
  });
});
