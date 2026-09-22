// Separate file so it can set its own (tiny) watchdog thresholds — the service
// reads them once at module load.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

process.env.BULK_SYNC_POLL_MS = "5";
process.env.BULK_SYNC_STALL_MS = "300";
process.env.BULK_SYNC_MAX_MS = "5000";

import { ShopifySimulator, TAG } from "./support/shopify-simulator.mjs";
import { resetDb } from "./support/fake-db.mjs";
import { setAdmin } from "./support/fake-shopify-server.mjs";

const SHOP = "qa-watchdog.myshopify.com";

describe("watchdog", () => {
  it("fails a wedged export instead of hanging forever", async () => {
    const bulkSync = await import("../app/services/bulk-sync.server.js");
    const status = await import("../app/lib/bulk-sync-status.js");

    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 1_000,
      hangQuery: true,
    }).start();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, SHOP, TAG);

      const deadline = Date.now() + 15_000;
      let job;
      do {
        await delay(50);
        job = await bulkSync.tickBulkSync(SHOP);
      } while (!status.isBulkSyncFinished(job) && Date.now() < deadline);

      assert.equal(job.status, "failed", "wedged sync should be failed by the watchdog");
      assert.match(job.errorMessage, /made no progress/);
      assert.ok(simulator.countCalls("cancelBulkOperation") >= 1, "should cancel the wedged operation");
    } finally {
      await simulator.stop();
    }
  });

  it("can be cancelled by the user at any time", async () => {
    const bulkSync = await import("../app/services/bulk-sync.server.js");

    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 1_000,
      hangQuery: true,
    }).start();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, SHOP, TAG);
      await delay(50);

      const job = await bulkSync.cancelBulkSync(simulator.admin, SHOP);
      assert.equal(job.status, "cancelled");
      assert.ok(job.finishedAt);
    } finally {
      await simulator.stop();
    }
  });
});

describe("cancellation during the download phase", () => {
  it("does not resurrect a cancelled job when the stream finishes", async () => {
    const bulkSync = await import("../app/services/bulk-sync.server.js");
    const st = await import("../app/lib/bulk-sync-status.js");

    resetDb();
    const shop = "qa-cancel-mid-download.myshopify.com";
    const simulator = await new ShopifySimulator({
      productCount: 120_000,
      queryPolls: 0,
      mutationPolls: 1,
    }).start();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG);

      // Wait until the export is actually streaming, then cancel mid-flight.
      const deadline = Date.now() + 10_000;
      let job;
      do {
        await delay(5);
        job = await bulkSync.tickBulkSync(shop);
      } while (job.status !== "downloading" && Date.now() < deadline);
      assert.equal(job.status, "downloading", "never reached the download phase");

      await bulkSync.cancelBulkSync(simulator.admin, shop);

      // Give the in-flight download every chance to overwrite the cancellation.
      await delay(1_500);

      const final = await bulkSync.getBulkSyncJob(shop);
      assert.equal(final.status, "cancelled", "the finished download overwrote the cancel");
      assert.ok(!st.isBulkSyncActive(final));
      assert.equal(simulator.countCalls("runBulkMutation"), 0, "cancelled sync still tagged products");
    } finally {
      await simulator.stop();
    }
  });
});

describe("Shopify queue time", () => {
  it("does not fail a job that is merely queued at Shopify", async () => {
    const bulkSync = await import("../app/services/bulk-sync.server.js");
    const st = await import("../app/lib/bulk-sync-status.js");

    resetDb();
    const shop = "qa-queued.myshopify.com";
    // Stays in CREATED forever. A 150k-row bulk mutation can legitimately sit
    // queued far longer than the stall timeout (300ms in this file).
    const simulator = await new ShopifySimulator({
      productCount: 150_000,
      queueQueryForever: true,
    }).start();

    try {
      setAdmin(simulator.admin);
      await bulkSync.startBulkSync(simulator.admin, shop, TAG);

      // Well past BULK_SYNC_STALL_MS.
      await delay(1_500);

      const job = await bulkSync.tickBulkSync(shop);
      assert.ok(
        st.isBulkSyncActive(job),
        `queued job was killed by the stall watchdog: ${job.status} — ${job.errorMessage}`,
      );
      assert.equal(job.status, "querying");
    } finally {
      await bulkSync.cancelBulkSync(simulator.admin, shop).catch(() => {});
      await simulator.stop();
    }
  });
});
