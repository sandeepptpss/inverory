import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Read at module load by the service, so they must be set before the dynamic
// import below.
process.env.BULK_SYNC_POLL_MS = "5";
process.env.BULK_SYNC_PROGRESS_BATCH = "5000";
process.env.BULK_SYNC_LEASE_MS = "30000";

import { ShopifySimulator, TAG, expectedCounts } from "./support/shopify-simulator.mjs";
import { resetDb } from "./support/fake-db.mjs";
import { setAdmin } from "./support/fake-shopify-server.mjs";

// A unique shop per suite: the runner registry is keyed by shop, so reusing one
// name lets a previous suite's runner (bound to an already-stopped simulator)
// adopt the next suite's job.
let shopCounter = 0;
const nextShop = (name) => `qa-${name}-${++shopCounter}.myshopify.com`;

let bulkSync;
let status;

before(async () => {
  bulkSync = await import("../app/services/bulk-sync.server.js");
  status = await import("../app/lib/bulk-sync-status.js");
});

/**
 * Drives the sync the way the UI does: start it, then poll the cheap tick
 * endpoint on an interval, recording every snapshot the user would have seen.
 */
async function runSync(simulator, { shop, timeoutMs = 120_000 } = {}) {
  setAdmin(simulator.admin);

  const snapshots = [];
  const heapSamples = [];
  const sampler = setInterval(() => {
    heapSamples.push(process.memoryUsage().heapUsed);
  }, 20);

  const startedAt = Date.now();
  let pollCount = 0;
  let maxPollMs = 0;

  try {
    await bulkSync.startBulkSync(simulator.admin, shop, TAG);

    for (;;) {
      const pollStart = Date.now();
      const job = await bulkSync.tickBulkSync(shop);
      maxPollMs = Math.max(maxPollMs, Date.now() - pollStart);
      pollCount += 1;

      snapshots.push({
        status: job.status,
        processed: job.processed,
        exported: job.exported,
        total: job.total,
        mutationProcessed: job.mutationProcessed,
        label: status.bulkSyncStatusLabel(job),
        percent: status.bulkSyncProgressPercent(job),
      });

      if (status.isBulkSyncFinished(job)) {
        return {
          job,
          snapshots,
          pollCount,
          maxPollMs,
          durationMs: Date.now() - startedAt,
          peakHeap: Math.max(...heapSamples, 0),
        };
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Sync did not finish within ${timeoutMs}ms (last status ${job.status})`);
      }

      await delay(20);
    }
  } finally {
    clearInterval(sampler);
  }
}

describe("full catalog sync — 150,000 products", () => {
  const PRODUCT_COUNT = 150_000;
  let simulator;
  let result;

  before(async () => {
    resetDb();
    simulator = await new ShopifySimulator({
      productCount: PRODUCT_COUNT,
      queryPolls: 3,
      mutationPolls: 2,
    }).start();
    result = await runSync(simulator, { shop: nextShop("large") });
  });

  after(async () => {
    await simulator?.stop();
  });

  it("completes successfully", () => {
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.errorMessage, null);
  });

  it("scans every product exactly once", () => {
    assert.equal(result.job.processed, PRODUCT_COUNT);
    assert.equal(result.job.total, PRODUCT_COUNT);
  });

  it("tags and untags the right products", () => {
    const { toTag, toUntag } = expectedCounts(PRODUCT_COUNT);
    assert.equal(result.job.toTag, toTag);
    assert.equal(result.job.toUntag, toUntag);
    assert.equal(result.job.tagged, toTag);
    assert.equal(result.job.untagged, toUntag);
    assert.equal(result.job.failed, 0);
  });

  it("finishes in a reasonable time", () => {
    assert.ok(
      result.durationMs < 90_000,
      `took ${result.durationMs}ms for ${PRODUCT_COUNT} products`,
    );
  });

  it("keeps every status poll fast, so the UI never freezes", () => {
    // The old implementation did the download and upload inside this request;
    // it is now a single indexed read.
    assert.ok(
      result.maxPollMs < 1_000,
      `slowest status poll took ${result.maxPollMs}ms`,
    );
  });

  it("reports climbing progress rather than a frozen message", () => {
    const scanning = result.snapshots.filter((s) => s.status === "downloading");
    assert.ok(scanning.length >= 2, "expected several scanning snapshots");

    const counts = scanning.map((s) => s.processed);
    assert.ok(Math.max(...counts) > Math.min(...counts), "processed count never moved");

    const labels = new Set(result.snapshots.map((s) => s.label));
    assert.ok(labels.size > 3, `only saw ${labels.size} distinct labels`);
    // Counts are rendered with toLocaleString, so build the expectation the
    // same way rather than hard-coding en-US grouping.
    const total = PRODUCT_COUNT.toLocaleString();
    assert.ok(
      [...labels].some((l) => l.startsWith("Scanning ") && l.endsWith(` of ${total} products…`)),
      `no "Scanning N of ${total}" label among: ${[...labels].slice(0, 6).join(" | ")}`,
    );
  });

  it("exposes a determinate percentage while scanning and tagging", () => {
    const percents = result.snapshots
      .filter((s) => s.status === "downloading" || s.status === "tagging")
      .map((s) => s.percent)
      .filter((p) => p !== null);

    assert.ok(percents.length > 0, "no determinate progress was ever reported");
    assert.ok(percents.every((p) => p >= 0 && p <= 100));
  });

  it("ends on a clear success message", () => {
    const { toTag, toUntag } = expectedCounts(PRODUCT_COUNT);
    assert.equal(
      status.bulkSyncStatusLabel(result.job),
      `Sync complete — scanned ${PRODUCT_COUNT.toLocaleString()} products, ` +
        `tagged ${toTag.toLocaleString()}, untagged ${toUntag.toLocaleString()}.`,
    );
  });

  it("issues exactly one bulk query and one bulk mutation per phase", () => {
    assert.equal(simulator.countCalls("startBulkProductQuery"), 1);
    assert.equal(simulator.countCalls("runBulkMutation"), 2);
    assert.equal(simulator.countCalls("stageJsonlUpload"), 2);
  });

  it("does not re-download the export on every poll", () => {
    // One status read per poll is expected; the export body is fetched once.
    assert.ok(
      simulator.countCalls("bulkOperationStatus") < 40,
      `made ${simulator.countCalls("bulkOperationStatus")} status calls`,
    );
  });
});

describe("memory behaviour", () => {
  it("peak heap does not scale with catalog size", async () => {
    const measure = async (productCount) => {
      resetDb();
      const simulator = await new ShopifySimulator({
        productCount,
        queryPolls: 1,
        mutationPolls: 1,
      }).start();
      try {
        const baseline = process.memoryUsage().heapUsed;
        const run = await runSync(simulator, { shop: nextShop("mem") });
        assert.equal(run.job.status, "completed");
        return Math.max(0, run.peakHeap - baseline);
      } finally {
        await simulator.stop();
      }
    };

    const small = await measure(10_000);
    const large = await measure(150_000);

    // Buffering the export would put the 15x-bigger catalog at roughly 15x the
    // heap. Streaming keeps it flat; 4x leaves generous room for GC timing.
    assert.ok(
      large < Math.max(small * 4, 96 * 1024 * 1024),
      `peak heap grew from ${(small / 1e6).toFixed(1)}MB (10k) to ${(large / 1e6).toFixed(1)}MB (150k)`,
    );
  });
});

describe("concurrent polls", () => {
  it("never starts duplicate bulk operations", async () => {
    resetDb();
    const shop = nextShop("concurrent");
    const simulator = await new ShopifySimulator({
      productCount: 20_000,
      queryPolls: 2,
      mutationPolls: 2,
    }).start();

    try {
      setAdmin(simulator.admin);

      // Six tabs hit "Run sync now" at the same instant on a cold start — the
      // race the atomic claim exists for.
      await Promise.all(
        Array.from({ length: 6 }, () => bulkSync.startBulkSync(simulator.admin, shop, TAG)),
      );
      assert.equal(simulator.countCalls("startBulkProductQuery"), 1);

      // Then eight tabs poll concurrently while more start attempts arrive.
      // Every count is taken while the run is still active, so a start that
      // legitimately races the finish cannot make the assertion flaky.
      let queriesWhileActive = 0;
      for (;;) {
        const jobs = await Promise.all(
          Array.from({ length: 8 }, () => bulkSync.tickBulkSync(shop)),
        );
        if (jobs.some((job) => status.isBulkSyncFinished(job))) break;

        await Promise.all(
          Array.from({ length: 3 }, () => bulkSync.startBulkSync(simulator.admin, shop, TAG)),
        );
        const job = await bulkSync.getBulkSyncJob(shop);
        if (status.isBulkSyncActive(job)) {
          queriesWhileActive = Math.max(
            queriesWhileActive,
            simulator.countCalls("startBulkProductQuery"),
          );
        }
        await delay(15);
      }

      assert.equal(queriesWhileActive, 1, "a second export was started mid-run");

      const job = await bulkSync.getBulkSyncJob(shop);
      assert.equal(job.status, "completed");
      assert.equal(job.processed, 20_000);
      assert.equal(simulator.countCalls("runBulkMutation"), 2);
    } finally {
      await simulator.stop();
    }
  });
});

describe("rate limits and retries", () => {
  it("recovers from THROTTLED responses", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 5_000,
      queryPolls: 2,
      mutationPolls: 1,
      throttleCount: 4,
    }).start();

    try {
      const run = await runSync(simulator, { shop: nextShop("throttle") });
      assert.equal(run.job.status, "completed");
      assert.equal(run.job.processed, 5_000);
    } finally {
      await simulator.stop();
    }
  });
});

describe("failure reporting", () => {
  it("surfaces a failed Shopify export as a clear error", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 1_000,
      queryPolls: 1,
      queryOutcome: "FAILED",
    }).start();

    try {
      const run = await runSync(simulator, { shop: nextShop("failed-export") });
      assert.equal(run.job.status, "failed");
      assert.match(status.bulkSyncStatusLabel(run.job), /^Sync failed: Shopify export failed/);
    } finally {
      await simulator.stop();
    }
  });

  it("counts per-product mutation errors without failing the whole sync", async () => {
    resetDb();
    const simulator = await new ShopifySimulator({
      productCount: 3_000,
      queryPolls: 1,
      mutationPolls: 1,
      mutationFailureRate: 0.1,
    }).start();

    try {
      const run = await runSync(simulator, { shop: nextShop("partial") });
      assert.equal(run.job.status, "completed");
      assert.ok(run.job.failed > 0, "expected some rows to be reported as failed");
      assert.match(status.bulkSyncStatusLabel(run.job), /failed\.$/);
    } finally {
      await simulator.stop();
    }
  });
});
