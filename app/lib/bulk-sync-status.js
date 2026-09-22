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
        ? `Exporting products from Shopify — ${count(job.exported)} found so far…`
        : "Exporting products from Shopify — waiting for the export to start…";

    case SYNC_STATUS.downloading:
      return job.total > 0
        ? `Scanning ${count(job.processed)} of ${count(job.total)} products…`
        : `Scanning ${count(job.processed)} products…`;

    case SYNC_STATUS.tagging:
      return `Applying the tag — ${count(job.mutationProcessed)} of ${count(job.toTag)} products…`;

    case SYNC_STATUS.untagging:
      return `Removing the tag — ${count(job.mutationProcessed)} of ${count(job.toUntag)} products…`;

    case SYNC_STATUS.completed: {
      const failed = job.failed > 0 ? `, ${count(job.failed)} failed` : "";
      return `Sync complete — scanned ${count(job.processed)} products, tagged ${count(job.tagged)}, untagged ${count(job.untagged)}${failed}.`;
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
    };
  }

  if (!isBulkSyncFinished(job)) return base;

  const finished = {
    ...base,
    mode: "finished",
    statusText: bulkSyncStatusLabel(job),
    elapsed: bulkSyncElapsedLabel(job),
  };

  if (job.status === SYNC_STATUS.failed) {
    return { ...finished, tone: "critical", heading: "Sync unsuccessful" };
  }
  if (job.status === SYNC_STATUS.cancelled) {
    // A cancelled run stopped part-way, so its counters describe nothing a
    // merchant can act on.
    return { ...finished, tone: "info", heading: "Sync cancelled" };
  }

  // `processed` is what the sync actually classified; `total` is Shopify's
  // export size, which counts any non-product row too. Reporting `total` here
  // made the tile disagree with the sentence right above it.
  const stats = [
    { label: "Scanned", value: count(job.processed) },
    { label: "Tagged", value: count(job.tagged), tone: "critical" },
    { label: "Untagged", value: count(job.untagged), tone: "success" },
  ];
  if (Number(job.failed) > 0) {
    stats.push({ label: "Failed", value: count(job.failed), tone: "critical" });
  }
  if (finished.elapsed) {
    stats.push({ label: "Duration", value: finished.elapsed });
  }

  return { ...finished, tone: "success", heading: "Sync complete", stats };
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
