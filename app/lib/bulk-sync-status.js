// Shared by the server runner and the React component, so it must stay free of
// node/prisma imports — the component previously pulled these helpers out of a
// *.server.js module, which leaks server-only code into the client bundle.

export const SYNC_STATUS = {
  querying: "querying",
  downloading: "downloading",
  tagging: "tagging",
  untagging: "untagging",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export const ACTIVE_STATUSES = [
  SYNC_STATUS.querying,
  SYNC_STATUS.downloading,
  SYNC_STATUS.tagging,
  SYNC_STATUS.untagging,
];

const ACTIVE_SET = new Set(ACTIVE_STATUSES);

export function isBulkSyncActive(job) {
  return Boolean(job && ACTIVE_SET.has(job.status));
}

export function isBulkSyncFinished(job) {
  return Boolean(
    job &&
      (job.status === SYNC_STATUS.completed ||
        job.status === SYNC_STATUS.failed ||
        job.status === SYNC_STATUS.cancelled),
  );
}

function count(value) {
  return Number(value || 0).toLocaleString();
}

/** "1 product" / "12 products": the noun agrees with the number it counts. */
export function formatProductCount(value) {
  const n = Number(value || 0);
  return `${count(n)} ${n === 1 ? "product" : "products"}`;
}

const canonicalTag = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Whether two tag names are one tag to Shopify, which matches tags
 * case-insensitively. The settings form uses it to decide whether an edit is a
 * real rename that will leave the old tag behind on products.
 */
export function isSameTag(a, b) {
  return canonicalTag(a) === canonicalTag(b);
}

/** Whether a sync pushed any tag change to Shopify before it stopped. */
function mutationStarted(job) {
  return Boolean(job?.addMutationBulkOperationId || job?.removeMutationBulkOperationId);
}

/**
 * " in “Summer Sale”" for a collection-scoped run, and the empty string for a
 * whole-catalog one — so every existing message is byte-for-byte what it was
 * before collection scoping existed.
 */
function scopeSuffix(job) {
  if (!job?.collectionId) return "";
  return job.collectionTitle
    ? ` in “${job.collectionTitle}”`
    : " in the selected collection";
}

/** Human label for the scope a job (or the settings) is pointed at. */
export function syncScopeLabel({ collectionId = null, collectionTitle = null } = {}) {
  if (!collectionId) return "Entire product catalog";
  return collectionTitle ? `Collection: ${collectionTitle}` : "Selected collection";
}

/**
 * Determinate progress for the current phase, or null when the phase has no
 * known denominator yet (Shopify does not tell us the catalog size until the
 * export finishes, so the query phase counts up instead of filling a bar).
 */
export function bulkSyncProgress(job) {
  if (!isBulkSyncActive(job)) return null;

  switch (job.status) {
    case SYNC_STATUS.querying:
      return { current: Number(job.exported || 0), total: 0 };
    case SYNC_STATUS.downloading:
      return { current: Number(job.processed || 0), total: Number(job.total || 0) };
    case SYNC_STATUS.tagging:
      return {
        current: Number(job.mutationProcessed || 0),
        total: Number(job.toTag || 0),
      };
    case SYNC_STATUS.untagging:
      return {
        current: Number(job.mutationProcessed || 0),
        total: Number(job.toUntag || 0),
      };
    default:
      return null;
  }
}

export function bulkSyncProgressPercent(job) {
  const progress = bulkSyncProgress(job);
  if (!progress || !progress.total) return null;
  return Math.min(100, Math.round((progress.current / progress.total) * 100));
}

export function bulkSyncStatusLabel(job) {
  if (!job) return null;

  switch (job.status) {
    case SYNC_STATUS.querying:
      return job.exported > 0
        ? `Exporting products${scopeSuffix(job)} from Shopify — ${count(job.exported)} found so far…`
        : `Exporting products${scopeSuffix(job)} from Shopify — waiting for the export to start…`;

    case SYNC_STATUS.downloading:
      return job.total > 0
        ? `Scanning ${count(job.processed)} of ${formatProductCount(job.total)}${scopeSuffix(job)}…`
        : `Scanning ${formatProductCount(job.processed)}${scopeSuffix(job)}…`;

    case SYNC_STATUS.tagging:
      return `Applying the tag — ${count(job.mutationProcessed)} of ${formatProductCount(job.toTag)}…`;

    case SYNC_STATUS.untagging:
      return `Removing the tag — ${count(job.mutationProcessed)} of ${formatProductCount(job.toUntag)}…`;

    case SYNC_STATUS.completed: {
      // A run whose tag updates Shopify rejected is not a clean success, and
      // the sentence must not open by claiming one.
      const hasFailures = job.failed > 0;
      const opening = hasFailures ? "Sync finished with errors" : "Sync complete";
      const failed = hasFailures ? `, ${count(job.failed)} failed` : "";
      return `${opening} — scanned ${formatProductCount(job.processed)}${scopeSuffix(job)}, tagged ${count(job.tagged)}, untagged ${count(job.untagged)}${failed}.`;
    }

    case SYNC_STATUS.failed:
      return `Sync failed: ${job.errorMessage || "unknown error"}`;

    case SYNC_STATUS.cancelled:
      return "Sync cancelled.";

    default:
      return null;
  }
}

/**
 * Everything the dashboard needs to render the sync panel, derived in one place
 * so the headline, the banner tone and the stat tiles cannot disagree.
 *
 * `isStarting` deliberately outranks a finished job: the component still holds
 * the previous run while the new one is being claimed, and rendering that as an
 * outcome showed "Sync complete" — with the old counts — over a run that had
 * just been kicked off.
 */
export function bulkSyncView({ job = null, isStarting = false, startError = null } = {}) {
  const base = {
    mode: "idle",
    statusText: null,
    percent: null,
    progress: null,
    elapsed: null,
    tone: null,
    heading: null,
    stats: [],
    // Secondary lines under the headline: what the outcome means for the
    // merchant's products, which the one-sentence summary cannot carry.
    notes: [],
  };

  if (isBulkSyncActive(job)) {
    return {
      ...base,
      mode: "running",
      statusText: bulkSyncStatusLabel(job),
      percent: bulkSyncProgressPercent(job),
      progress: bulkSyncProgress(job),
      elapsed: bulkSyncElapsedLabel(job),
    };
  }

  if (isStarting) {
    return { ...base, mode: "running", statusText: "Starting sync…" };
  }

  if (startError) {
    return {
      ...base,
      mode: "finished",
      statusText: `Could not start the sync: ${startError}`,
      tone: "critical",
      heading: "Sync unsuccessful",
      // The banner is about the click that just failed, not about the stored
      // job, so nothing job-derived (age, settings drift) belongs next to it.
      startFailed: true,
    };
  }

  if (!isBulkSyncFinished(job)) return base;

  const finished = {
    ...base,
    mode: "finished",
    statusText: bulkSyncStatusLabel(job),
    elapsed: bulkSyncElapsedLabel(job),
  };

  // A run that stopped early has no stat tiles, so its duration goes here; a
  // completed run shows it as a tile instead, and saying it twice is noise.
  const ranFor = finished.elapsed ? [`Ran for ${finished.elapsed} before stopping.`] : [];

  if (job.status === SYNC_STATUS.failed) {
    return {
      ...finished,
      tone: "critical",
      heading: "Sync unsuccessful",
      notes: [
        mutationStarted(job)
          ? "Some products may already have been updated before it stopped. Run the sync again to finish."
          : "No products were changed.",
        ...ranFor,
      ],
    };
  }
  if (job.status === SYNC_STATUS.cancelled) {
    // A cancelled run stopped part-way, so its counters describe nothing a
    // merchant can act on — but whether it had already changed products does.
    return {
      ...finished,
      tone: "info",
      heading: "Sync cancelled",
      notes: [
        mutationStarted(job)
          ? "It was stopped while tags were being updated, so some products may already have changed. Run the sync again to finish."
          : "It was stopped before any product was changed.",
        ...ranFor,
      ],
    };
  }

  // `processed` is what the sync actually classified; `total` is Shopify's
  // export size, which counts any non-product row too. Reporting `total` here
  // made the tile disagree with the sentence right above it.
  const stats = [
    // Only when the run was scoped: on a whole-catalog sync the tile would be
    // noise, and the tile row is what a merchant reads to confirm a run did
    // what they expected.
    ...(job.collectionId
      ? [{ label: "Scope", value: job.collectionTitle || "Selected collection" }]
      : []),
    { label: "Scanned", value: count(job.processed) },
    {
      label: "Tags Added",
      value: count(job.tagged),
      tone: Number(job.tagged) > 0 ? "critical" : undefined,
    },
    {
      label: "Tags Removed",
      value: count(job.untagged),
      tone: Number(job.untagged) > 0 ? "success" : undefined,
    },
  ];
  if (Number(job.failed) > 0) {
    stats.push({ label: "Failed", value: count(job.failed), tone: "critical" });
  }
  if (finished.elapsed) {
    stats.push({ label: "Duration", value: finished.elapsed });
  }

  const failed = Number(job.failed || 0);
  const notes = [];
  if (failed > 0) {
    notes.push(
      `${formatProductCount(failed)} could not be updated because Shopify rejected the change. Run the sync again to retry.`,
    );
  } else if (Number(job.processed || 0) === 0) {
    // An empty scan is almost always a scope problem, not a healthy catalog.
    notes.push(
      job.collectionId
        ? `No active products were found${scopeSuffix(job)}. Check that the collection contains active products.`
        : "No active products were found in your store.",
    );
  } else if (
    // Judged on what the scan asked for, not on what landed: a run whose every
    // update failed also ends with tagged = untagged = 0.
    Number(job.toTag || 0) + Number(job.toUntag || 0) === 0 &&
    Number(job.tagged || 0) + Number(job.untagged || 0) === 0
  ) {
    notes.push("All products were already up to date with your automation rules — nothing needed to change.");
  }

  if (failed > 0) {
    return { ...finished, tone: "warning", heading: "Sync finished with errors", stats, notes };
  }
  return { ...finished, tone: "success", heading: "Sync complete", stats, notes };
}

/**
 * The fresher of two snapshots of the one job row. The dashboard hears about
 * the job from three fetchers (start, poll, cancel) whose responses can land in
 * any order, and each keeps its last answer indefinitely; taking whichever
 * arrived last let a previous run's final poll overwrite the run that had just
 * been started, which then was never polled and never displayed.
 */
export function newerJob(current, incoming) {
  if (!incoming) return current ?? null;
  if (!current) return incoming;
  const time = (value) => {
    const ms = new Date(value ?? NaN).getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  // Different runs: the later run wins. Comparing start times rather than
  // write times keeps this safe across app instances whose clocks drift a
  // little, since two runs start at least one whole run apart.
  const currentStart = time(current.startedAt);
  const incomingStart = time(incoming.startedAt);
  if (currentStart !== null && incomingStart !== null && currentStart !== incomingStart) {
    return incomingStart > currentStart ? incoming : current;
  }

  // Same run: the later write wins, so a poll answered just before a cancel
  // cannot land after it and bring the run back to life on screen.
  const currentAt = time(current.updatedAt);
  const incomingAt = time(incoming.updatedAt);
  if (currentAt === null || incomingAt === null) return incoming;
  return incomingAt >= currentAt ? incoming : current;
}

/**
 * A finished run's summary stays on screen indefinitely. Once the merchant has
 * since changed the tag or the scope, that summary describes settings no longer
 * in force, and nothing else on the page says a new run is needed.
 */
export function bulkSyncSettingsDrift(job, settings) {
  if (job?.status !== SYNC_STATUS.completed || !settings) return null;

  const changes = [];
  // Shopify treats tags case-insensitively, so a case-only rename is not drift.
  if (job.tagName && canonicalTag(job.tagName) !== canonicalTag(settings.tagName)) {
    changes.push(`it used the tag “${job.tagName}”`);
  }
  if ((job.collectionId || null) !== (settings.collectionId || null)) {
    changes.push(
      job.collectionId
        ? `it scanned ${job.collectionTitle ? `“${job.collectionTitle}”` : "a different collection"}`
        : "it scanned the entire catalog",
    );
  }
  if (!changes.length) return null;

  return `Your settings have changed since this sync ran (${changes.join(" and ")}). Run sync now to apply the current settings to existing products.`;
}

/** "just now", "5 minutes ago", "3 days ago" — how old a finished result is. */
export function bulkSyncFinishedAgoLabel(job, now = Date.now()) {
  if (!isBulkSyncFinished(job)) return null;
  const stoppedAt = new Date(job.finishedAt ?? job.updatedAt ?? NaN).getTime();
  if (!Number.isFinite(stoppedAt)) return null;

  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const seconds = Math.max(0, Math.round((now - stoppedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

/** Dashboard poll cadence, in ms, for a run that has been going this long. */
export const POLL_FAST_MS = 2_000;
export const POLL_MEDIUM_MS = 5_000;
export const POLL_SLOW_MS = 10_000;

/**
 * A full catalog sync is usually over in minutes, so the first stretch polls
 * fast enough to feel live. Past that the run is a long export sitting in
 * Shopify's queue and a fixed 2s poll is just load: a six-hour job would make
 * ~10,800 round trips per open tab.
 */
export function bulkSyncPollDelayMs(job, now = Date.now()) {
  const startedAt = job?.startedAt ? new Date(job.startedAt).getTime() : NaN;
  if (!Number.isFinite(startedAt)) return POLL_FAST_MS;

  const runningMs = now - startedAt;
  if (runningMs < 2 * 60_000) return POLL_FAST_MS;
  if (runningMs < 10 * 60_000) return POLL_MEDIUM_MS;
  return POLL_SLOW_MS;
}

export function bulkSyncElapsedLabel(job) {
  if (!job?.startedAt) return null;

  // For a finished job the clock must stop. Falling back to Date.now() here
  // keeps counting while the page sits open, so a sync that took seconds is
  // reported as "41m 42s". Rows written before the finishedAt column existed
  // have it NULL, so fall back to updatedAt — the last time the job was
  // actually touched — and give up rather than invent a duration.
  let end;
  if (isBulkSyncFinished(job)) {
    const stoppedAt = job.finishedAt ?? job.updatedAt;
    if (!stoppedAt) return null;
    end = new Date(stoppedAt).getTime();
  } else {
    end = Date.now();
  }

  const started = new Date(job.startedAt).getTime();
  const seconds = Math.max(0, Math.round((end - started) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
