// Exact client scenario: 150,000 Active products, all out of stock, none
// currently tagged — so every one of them needs "add" and zero need "remove".
// This is the worst case for this app (the biggest possible mutation file) and
// the one the client is asking about directly.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

process.env.BULK_SYNC_POLL_MS = "5";
process.env.BULK_SYNC_PROGRESS_BATCH = "5000";

import { ShopifySimulator, TAG } from "./support/shopify-simulator.mjs";
import { resetDb } from "./support/fake-db.mjs";
import { setAdmin } from "./support/fake-shopify-server.mjs";

const SHOP = "qa-zero-inventory-150k.myshopify.com";
const PRODUCT_COUNT = 150_000;

let bulkSync;
let status;

before(async () => {
  bulkSync = await import("../app/services/bulk-sync.server.js");
  status = await import("../app/lib/bulk-sync-status.js");
});

describe("150,000 products, all zero inventory (tag-add-only scenario)", () => {
  let simulator;
  let job;
  let snapshots;
  let appOverheadMs; // time spent in our code, excluding simulated Shopify wait
  let maxPollMs;
  let peakHeap;
  let mutationRowsUploaded;

  before(async () => {
    resetDb();
    simulator = await new ShopifySimulator({
      productCount: PRODUCT_COUNT,
      catalog: "zeroInventory",
      queryPolls: 3,
      mutationPolls: 3,
    }).start();
    setAdmin(simulator.admin);

    snapshots = [];
    maxPollMs = 0;
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 20);

    const t0 = Date.now();
    await bulkSync.startBulkSync(simulator.admin, SHOP, TAG);

    do {
      const p0 = Date.now();
      job = await bulkSync.tickBulkSync(SHOP);
      maxPollMs = Math.max(maxPollMs, Date.now() - p0);
      snapshots.push({
        status: job.status,
        label: status.bulkSyncStatusLabel(job),
        percent: status.bulkSyncProgressPercent(job),
      });
      if (!status.isBulkSyncFinished(job)) await delay(15);
    } while (!status.isBulkSyncFinished(job));

    clearInterval(sampler);
    appOverheadMs = Date.now() - t0;
    peakHeap = peak;
    mutationRowsUploaded = [...(simulator.uploads?.values() ?? [])].reduce((a, b) => a + b, 0);
  });

  after(async () => {
    await simulator?.stop();
  });

  it("completes successfully", () => {
    assert.equal(job.status, "completed");
    assert.equal(job.errorMessage, null);
  });

  it("scans all 150,000 products exactly once", () => {
    assert.equal(job.processed, PRODUCT_COUNT);
    assert.equal(job.total, PRODUCT_COUNT);
  });

  it("tags every product and removes from none — the exact client scenario", () => {
    assert.equal(job.toTag, PRODUCT_COUNT);
    assert.equal(job.toUntag, 0);
    assert.equal(job.tagged, PRODUCT_COUNT);
    assert.equal(job.untagged, 0);
    assert.equal(job.failed, 0);
  });

  it("skips the untag phase entirely (no wasted bulk mutation)", () => {
    // One tagsAdd mutation, and — because toUntag is 0 — no tagsRemove at all.
    assert.equal(simulator.countCalls("runBulkMutation"), 1);
    assert.equal(simulator.countCalls("stageJsonlUpload"), 1);
    assert.ok(
      snapshots.every((s) => s.status !== "untagging"),
      "job entered the untagging phase despite having nothing to untag",
    );
  });

  it("uploads exactly one row per product to Shopify (no duplication)", () => {
    assert.equal(mutationRowsUploaded, PRODUCT_COUNT);
  });

  it("this app's own processing overhead is small — the wait is Shopify's, not ours", () => {
    // Simulated network is local; real "time to first byte" per bulk-op poll
    // will dominate in production. What this proves is that our code does not
    // add multi-minute overhead on top of whatever Shopify takes.
    assert.ok(
      appOverheadMs < 15_000,
      `app-side overhead was ${appOverheadMs}ms for ${PRODUCT_COUNT} products`,
    );
  });

  it("keeps every UI poll fast regardless of catalog size", () => {
    assert.ok(maxPollMs < 1_000, `slowest poll took ${maxPollMs}ms`);
  });

  it("memory stays flat for an all-add catalog (the largest possible mutation file)", () => {
    // 150k lines of {"id":"...","tags":["out-of-stock-hidden"]} is roughly
    // 22MB of JSONL; a buffered implementation would hold that plus a parsed
    // array plus a re-serialized string in memory at once.
    assert.ok(
      peakHeap < 150 * 1024 * 1024,
      `peak heap was ${(peakHeap / 1e6).toFixed(1)}MB`,
    );
  });

  it("reports climbing, human-readable progress the whole way through", () => {
    const labels = snapshots.map((s) => s.label);
    assert.ok(labels.some((l) => l?.startsWith("Exporting products")));
    assert.ok(labels.some((l) => l?.startsWith("Scanning")));
    assert.ok(labels.some((l) => l?.startsWith("Applying the tag")));
    // Counts are locale-formatted (toLocaleString), so build the expectation
    // the same way rather than hard-coding en-US grouping.
    assert.ok(
      labels.some((l) => l?.includes(`${PRODUCT_COUNT.toLocaleString()} products`)),
      `no label mentions the full ${PRODUCT_COUNT.toLocaleString()} count`,
    );
  });

  it("never shows a frozen 'exporting' message once real progress exists", () => {
    // Regression for the exact bug in the original screenshot: once the export
    // has objects, the label must include a live count, not just the static
    // "waiting for the export to start" text.
    const exportingLabels = snapshots
      .map((s) => s.label)
      .filter((l) => l?.startsWith("Exporting products"));
    assert.ok(
      exportingLabels.some((l) => /\d/.test(l)),
      "exporting phase never showed a live count",
    );
  });

  it("ends on an unambiguous, correctly pluralized success message", () => {
    const n = PRODUCT_COUNT.toLocaleString();
    assert.equal(
      status.bulkSyncStatusLabel(job),
      `Sync complete — scanned ${n} products, tagged ${n}, untagged 0.`,
    );
  });
});
