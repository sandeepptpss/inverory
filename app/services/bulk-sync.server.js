import { randomUUID } from "node:crypto";
import os from "node:os";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { resolveTagAction, tagForAction } from "./inventory-tags.server";
import { ACTIVE_STATUSES, isBulkSyncActive, SYNC_STATUS } from "../lib/bulk-sync-status";
import {
  FatalError,
  graphqlWithRetry,
  sleep,
} from "./shopify-retry.server";
import {
  JsonlWriter,
  fileAsBlob,
  fileExists,
  removeFile,
  streamJsonlFromUrl,
  tempJsonlPath,
} from "./jsonl.server";

export { isBulkSyncActive, SYNC_STATUS };

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** How often the runner asks Shopify how the bulk operation is going. */
const POLL_INTERVAL_MS = num(process.env.BULK_SYNC_POLL_MS, 2_500);
/** Lease length. Renewed while a long step (the download) is running. */
const LEASE_MS = num(process.env.BULK_SYNC_LEASE_MS, 60_000);
/** Fail a job whose counters have not moved in this long. */
const NO_PROGRESS_TIMEOUT_MS = num(process.env.BULK_SYNC_STALL_MS, 30 * 60_000);
/** Hard ceiling, so a job can never run forever even if it keeps inching along. */
const MAX_JOB_DURATION_MS = num(process.env.BULK_SYNC_MAX_MS, 6 * 60 * 60_000);
/** Consecutive retryable step failures tolerated before the job is failed. */
const MAX_STEP_ATTEMPTS = num(process.env.BULK_SYNC_MAX_ATTEMPTS, 5);
/** DB write cadence while streaming the export. */
const PROGRESS_BATCH_SIZE = num(process.env.BULK_SYNC_PROGRESS_BATCH, 2_000);

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

// Only top-level product fields, so every export line is one product and the
// JSONL stays small: ~150 bytes per product, ~22MB for a 150k catalog.
const PRODUCTS_BULK_QUERY = `{
  products(query: "status:active") {
    edges {
      node {
        id
        status
        tags
        totalInventory
        tracksInventory
      }
    }
  }
}`;

const ADD_TAG_MUTATION = `mutation call($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors {
      message
    }
  }
}`;

const REMOVE_TAG_MUTATION = `mutation call($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) {
    userErrors {
      message
    }
  }
}`;

const TERMINAL_OK = "COMPLETED";
const IN_FLIGHT = new Set(["CREATED", "RUNNING", "CANCELING"]);

export async function getBulkSyncJob(shop) {
  return db.bulkSyncJob.findUnique({ where: { shop } });
}

// ---------------------------------------------------------------------------
// Public entry points. Both return quickly: the expensive work happens in a
// background runner, never inside the HTTP request that triggered it.
// ---------------------------------------------------------------------------

/**
 * Atomically claims the right to start a run. Two simultaneous clicks (or two
 * app instances) both see "no active job" if they only read first, and both
 * launch a bulk query; the conditional write means exactly one wins.
 * Returns null when someone else already holds the run.
 */
async function claimStart(shop, tagName) {
  const now = new Date();
  const claim = {
    tagName,
    status: SYNC_STATUS.querying,
    queryBulkOperationId: null,
    addMutationBulkOperationId: null,
    removeMutationBulkOperationId: null,
    addJsonlPath: null,
    removeJsonlPath: null,
    exported: 0,
    total: 0,
    processed: 0,
    mutationProcessed: 0,
    toTag: 0,
    toUntag: 0,
    tagged: 0,
    untagged: 0,
    failed: 0,
    errorMessage: null,
    lockedBy: null,
    lockedUntil: null,
    attempts: 0,
    lastProgressAt: now,
    lastProgressCount: 0,
    startedAt: now,
    finishedAt: null,
  };

  try {
    return await db.bulkSyncJob.create({ data: { shop, ...claim } });
  } catch (error) {
    // P2002: the row already exists, so fall through to the conditional update.
    if (error?.code !== "P2002") throw error;
  }

  const { count } = await db.bulkSyncJob.updateMany({
    where: { shop, status: { notIn: ACTIVE_STATUSES } },
    data: claim,
  });

  return count > 0 ? getBulkSyncJob(shop) : null;
}

export async function startBulkSync(admin, shop, tagName, options = {}) {
  const previous = await getBulkSyncJob(shop);
  if (previous && !isBulkSyncActive(previous)) {
    await cleanupFiles(previous);
  }

  const claimed = await claimStart(shop, tagName);
  if (!claimed) {
    // Another click or instance already owns the active run.
    ensureRunner(shop, options);
    return getBulkSyncJob(shop);
  }

  try {
    return await beginExport(admin, shop, tagName, options);
  } catch (error) {
    // The claim is already persisted, so a failure here must release it rather
    // than leave the job stuck in `querying` with no operation to poll.
    await finish(shop, SYNC_STATUS.failed, { errorMessage: friendlyError(error) });
    throw error;
  }
}

async function beginExport(admin, shop, tagName, options) {
  // A previous run that crashed can leave a bulk query running; Shopify allows
  // only one per app per shop, so clear it before asking for a new one.
  await cancelStaleBulkOperation(admin, "QUERY");

  const data = await graphqlWithRetry(
    admin,
    `#graphql
    mutation startBulkProductQuery($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { variables: { query: PRODUCTS_BULK_QUERY }, label: "bulkOperationRunQuery" },
  );

  const userErrors = data?.bulkOperationRunQuery?.userErrors || [];
  if (userErrors.length) {
    throw new FatalError(
      `Could not start the export: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const job = await db.bulkSyncJob.update({
    where: { shop },
    data: {
      queryBulkOperationId: data.bulkOperationRunQuery.bulkOperation.id,
      lastProgressAt: new Date(),
    },
  });

  ensureRunner(shop, options);
  return job;
}

/**
 * Called by the UI poll. Reads the persisted job and makes sure a runner is
 * alive — it never waits on Shopify, so the poll always returns in milliseconds
 * and the progress display keeps updating.
 */
export async function tickBulkSync(shop, options = {}) {
  const job = await getBulkSyncJob(shop);
  if (isBulkSyncActive(job)) {
    ensureRunner(shop, options);
  }
  return job;
}

/**
 * The Shopify operation the job is waiting on right now. Keyed off status: once
 * the tagging phase finishes, `addMutationBulkOperationId` still holds a
 * completed operation, so preferring whichever id is non-null would cancel the
 * wrong one during the untagging phase.
 */
function currentOperationId(job) {
  switch (job.status) {
    case SYNC_STATUS.querying:
    case SYNC_STATUS.downloading:
      return job.queryBulkOperationId;
    case SYNC_STATUS.tagging:
      return job.addMutationBulkOperationId;
    case SYNC_STATUS.untagging:
      return job.removeMutationBulkOperationId;
    default:
      return null;
  }
}

export async function cancelBulkSync(admin, shop) {
  const job = await getBulkSyncJob(shop);
  if (!isBulkSyncActive(job)) return job;

  const operationId = currentOperationId(job);

  if (operationId) {
    await cancelBulkOperation(admin, operationId).catch(() => {});
  }

  await cleanupFiles(job);
  return finish(shop, SYNC_STATUS.cancelled, {});
}

// ---------------------------------------------------------------------------
// Background runner
// ---------------------------------------------------------------------------

const RUNNERS = new Map();

function ensureRunner(shop, options = {}) {
  if (RUNNERS.has(shop)) return RUNNERS.get(shop);

  const promise = runLoop(shop, options)
    .catch((error) => {
      console.error(`[bulk-sync] runner crashed for ${shop}:`, error);
    })
    .finally(() => {
      RUNNERS.delete(shop);
    });

  RUNNERS.set(shop, promise);
  return promise;
}

/** Exposed for tests and for a graceful shutdown that wants to drain runners. */
export function activeRunners() {
  return Array.from(RUNNERS.values());
}

async function resolveAdmin(shop, options) {
  if (options.adminFactory) return options.adminFactory(shop);
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

async function runLoop(shop, options) {
  // Resolved once per runner rather than borrowed from the request, so the
  // client outlives the HTTP request that started the sync.
  const admin = await resolveAdmin(shop, options);

  for (;;) {
    const current = await getBulkSyncJob(shop);
    if (!isBulkSyncActive(current)) return;

    const job = await acquireLease(shop);
    if (!job) {
      // Another instance owns it; wait for its lease to lapse or the job to end.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const expired = await enforceWatchdog(admin, job);
    if (expired) return;

    let waitMs = POLL_INTERVAL_MS;
    try {
      const result = await runStep(admin, job);
      if (!isBulkSyncActive(result.job)) {
        await releaseLease(shop);
        return;
      }
      waitMs = result.waitMs ?? 0;
      if (job.attempts > 0) {
        await db.bulkSyncJob.update({ where: { shop }, data: { attempts: 0 } });
      }
    } catch (error) {
      if (error instanceof SyncAborted) {
        await cleanupFiles(job);
        return;
      }
      const stillRunning = await handleStepError(shop, job, error);
      if (!stillRunning) return;
      waitMs = POLL_INTERVAL_MS;
    }

    if (waitMs > 0) await sleep(waitMs);
  }
}

async function handleStepError(shop, job, error) {
  const attempts = job.attempts + 1;
  const fatal = error instanceof FatalError || error?.retryable === false;

  console.error(
    `[bulk-sync] step failed for ${shop} (${job.status}, attempt ${attempts}):`,
    error,
  );

  if (fatal || attempts >= MAX_STEP_ATTEMPTS) {
    await cleanupFiles(job);
    await finish(shop, SYNC_STATUS.failed, {
      errorMessage: friendlyError(error),
    });
    return false;
  }

  await db.bulkSyncJob.update({ where: { shop }, data: { attempts } });
  return true;
}

function friendlyError(error) {
  const message = String(error?.message || "Unknown error");
  return message.length > 500 ? `${message.slice(0, 497)}…` : message;
}

// ---------------------------------------------------------------------------
// Lease + watchdog
// ---------------------------------------------------------------------------

async function acquireLease(shop) {
  const now = new Date();
  const { count } = await db.bulkSyncJob.updateMany({
    where: {
      shop,
      OR: [
        { lockedUntil: null },
        { lockedUntil: { lt: now } },
        { lockedBy: INSTANCE_ID },
      ],
    },
    data: { lockedBy: INSTANCE_ID, lockedUntil: new Date(now.getTime() + LEASE_MS) },
  });

  return count > 0 ? getBulkSyncJob(shop) : null;
}

async function releaseLease(shop) {
  await db.bulkSyncJob
    .updateMany({
      where: { shop, lockedBy: INSTANCE_ID },
      data: { lockedBy: null, lockedUntil: null },
    })
    .catch(() => {});
}

/** Returns true when the job was terminated. */
async function enforceWatchdog(admin, job) {
  const now = Date.now();
  const startedAt = new Date(job.startedAt).getTime();
  const lastProgressAt = new Date(job.lastProgressAt ?? job.startedAt).getTime();

  let reason = null;
  if (now - startedAt > MAX_JOB_DURATION_MS) {
    reason = `Sync exceeded the maximum run time of ${Math.round(MAX_JOB_DURATION_MS / 60_000)} minutes.`;
  } else if (now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
    reason = `Sync made no progress for ${Math.round(NO_PROGRESS_TIMEOUT_MS / 60_000)} minutes and was stopped.`;
  }

  if (!reason) return false;

  const operationId = currentOperationId(job);
  if (operationId) {
    await cancelBulkOperation(admin, operationId).catch(() => {});
  }

  await cleanupFiles(job);
  await finish(job.shop, SYNC_STATUS.failed, { errorMessage: reason });
  return true;
}

/**
 * Advances the watchdog only when the counter really moved. Writing
 * `lastProgressAt` unconditionally would make a wedged operation look healthy
 * forever, which is how the old version could hang indefinitely.
 */
async function recordProgress(job, counter, data = {}, { queued = false } = {}) {
  // Sitting in Shopify's bulk queue (status CREATED, objectCount still 0) is
  // normal waiting, not a stall — a 150k-row mutation can be queued for a long
  // time before it starts moving. Counting it as a stall would fail a healthy
  // job; the absolute MAX_JOB_DURATION_MS cap still bounds a queue that never
  // drains. Once the operation is RUNNING, a frozen counter is a real stall.
  const changed = queued || counter !== job.lastProgressCount;

  return db.bulkSyncJob.update({
    where: { shop: job.shop },
    data: {
      ...data,
      ...(changed ? { lastProgressCount: counter, lastProgressAt: new Date() } : {}),
      lockedUntil: new Date(Date.now() + LEASE_MS),
    },
  });
}

/**
 * Status changes are conditional on the job still being in the state the step
 * started from. Without this, a long step (the download, a running mutation)
 * would happily overwrite a cancellation that arrived while it was working, and
 * a cancelled sync would come back to life.
 */
async function transitionFrom(shop, expectedStatus, data) {
  await db.bulkSyncJob.updateMany({
    where: { shop, status: expectedStatus },
    data,
  });
  return getBulkSyncJob(shop);
}

async function finish(shop, status, data) {
  await db.bulkSyncJob.updateMany({
    where: { shop, status: { in: ACTIVE_STATUSES } },
    data: {
      ...data,
      status,
      finishedAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
    },
  });
  return getBulkSyncJob(shop);
}

/** Thrown when a step notices the job was cancelled out from under it. */
class SyncAborted extends Error {
  constructor() {
    super("Sync was cancelled");
    this.name = "SyncAborted";
  }
}

async function cleanupFiles(job) {
  await removeFile(job.addJsonlPath);
  await removeFile(job.removeJsonlPath);
}

// ---------------------------------------------------------------------------
// Shopify bulk operation helpers
// ---------------------------------------------------------------------------

async function fetchBulkOperationStatus(admin, id) {
  const data = await graphqlWithRetry(
    admin,
    `#graphql
    query bulkOperationStatus($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { id status errorCode url objectCount }
      }
    }`,
    { variables: { id }, label: "bulkOperationStatus" },
  );

  return data?.node ?? null;
}

async function fetchCurrentBulkOperation(admin, type) {
  const data = await graphqlWithRetry(
    admin,
    `#graphql
    query currentBulkOperation($type: BulkOperationType!) {
      currentBulkOperation(type: $type) { id status url objectCount }
    }`,
    { variables: { type }, label: "currentBulkOperation" },
  );

  return data?.currentBulkOperation ?? null;
}

async function cancelBulkOperation(admin, id) {
  return graphqlWithRetry(
    admin,
    `#graphql
    mutation cancelBulkOperation($id: ID!) {
      bulkOperationCancel(id: $id) {
        bulkOperation { id status }
        userErrors { message }
      }
    }`,
    { variables: { id }, label: "bulkOperationCancel", attempts: 2 },
  );
}

async function cancelStaleBulkOperation(admin, type) {
  const current = await fetchCurrentBulkOperation(admin, type).catch(() => null);
  if (current && IN_FLIGHT.has(current.status)) {
    await cancelBulkOperation(admin, current.id).catch(() => {});
  }
}

async function stageJsonlUpload(admin, filePath, filename) {
  const data = await graphqlWithRetry(
    admin,
    `#graphql
    mutation stageJsonlUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            resource: "BULK_MUTATION_VARIABLES",
            filename,
            mimeType: "text/jsonl",
            httpMethod: "POST",
          },
        ],
      },
      label: "stagedUploadsCreate",
    },
  );

  const userErrors = data?.stagedUploadsCreate?.userErrors || [];
  if (userErrors.length) {
    throw new FatalError(
      `Could not prepare the upload: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const target = data.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  // File-backed Blob: the payload streams from disk instead of being read into
  // memory, which matters once the id list runs to six figures.
  form.append("file", await fileAsBlob(filePath), filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text().catch(() => "");
    throw new Error(`Staged upload failed: ${uploadResponse.status} ${body.slice(0, 300)}`);
  }

  return target.parameters.find((param) => param.name === "key").value;
}

async function runBulkMutation(admin, mutation, stagedUploadPath) {
  const data = await graphqlWithRetry(
    admin,
    `#graphql
    mutation runBulkMutation($mutation: String!, $stagedUploadPath: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
        bulkOperation { id status }
        userErrors { field message code }
      }
    }`,
    { variables: { mutation, stagedUploadPath }, label: "bulkOperationRunMutation" },
  );

  const userErrors = data?.bulkOperationRunMutation?.userErrors || [];
  if (userErrors.length) {
    throw new FatalError(
      `Could not start the tag update: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }

  return data.bulkOperationRunMutation.bulkOperation;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

async function runStep(admin, job) {
  switch (job.status) {
    case SYNC_STATUS.querying:
      return stepQuerying(admin, job);
    case SYNC_STATUS.downloading:
      return stepDownloading(admin, job);
    case SYNC_STATUS.tagging:
      return stepMutating(admin, job, "add");
    case SYNC_STATUS.untagging:
      return stepMutating(admin, job, "remove");
    default:
      return { job };
  }
}

async function stepQuerying(admin, job) {
  if (!job.queryBulkOperationId) {
    // The claim is written before Shopify is asked for the export, so a runner
    // can arrive in this window. Wait for the starter to fill in the id; the
    // watchdog catches the case where it never does.
    return { job, waitMs: POLL_INTERVAL_MS };
  }

  const op = await fetchBulkOperationStatus(admin, job.queryBulkOperationId);

  if (!op || IN_FLIGHT.has(op.status)) {
    const exported = Number(op?.objectCount || 0);
    // `exported` is the live count Shopify reports while the export builds, so
    // the user sees the number climbing instead of a frozen message.
    const updated = await recordProgress(job, exported, { exported }, {
      queued: op?.status === "CREATED",
    });
    return { job: updated, waitMs: POLL_INTERVAL_MS };
  }

  if (op.status !== TERMINAL_OK) {
    await cleanupFiles(job);
    return {
      job: await finish(job.shop, SYNC_STATUS.failed, {
        errorMessage: `Shopify export ${op.status.toLowerCase()}${op.errorCode ? `: ${op.errorCode}` : ""}`,
      }),
    };
  }

  const total = Number(op.objectCount || 0);

  if (!op.url || total === 0) {
    return {
      job: await finish(job.shop, SYNC_STATUS.completed, {
        exported: total,
        total,
        processed: 0,
      }),
    };
  }

  return {
    job: await transitionFrom(job.shop, SYNC_STATUS.querying, {
      status: SYNC_STATUS.downloading,
      exported: total,
      total,
      processed: 0,
      lastProgressCount: 0,
      lastProgressAt: new Date(),
    }),
    waitMs: 0,
  };
}

async function stepDownloading(admin, job) {
  // Re-read the operation so the signed URL is fresh; the one handed out when
  // the export completed can expire before a resumed run gets to it.
  const op = await fetchBulkOperationStatus(admin, job.queryBulkOperationId);
  if (!op?.url) {
    throw new FatalError("Shopify export result is no longer available. Run the sync again.");
  }

  const addPath = await tempJsonlPath(job.shop, "add");
  const removePath = await tempJsonlPath(job.shop, "remove");
  const addWriter = new JsonlWriter(addPath);
  const removeWriter = new JsonlWriter(removePath);

  // Nothing in this loop accumulates per-product state: each line is classified
  // and written straight to disk, so peak memory is flat regardless of catalog
  // size. (A de-duplicating Set would reintroduce O(catalog) memory; it is not
  // needed because an export never repeats a node and a retried download starts
  // from fresh output files.)
  let processed = 0;

  try {
    for await (const product of streamJsonlFromUrl(op.url, { label: "bulkExport" })) {
      // Defensive: if the export query ever gains a nested connection, its child
      // lines must not be counted or tagged as products.
      if (typeof product?.id !== "string" || !product.id.includes("/Product/")) {
        continue;
      }

      processed += 1;

      const action = resolveTagAction({
        status: product.status,
        tags: product.tags ?? [],
        quantity: product.totalInventory,
        tracked: product.tracksInventory,
        tagName: job.tagName,
      });

      if (action === "add") {
        await addWriter.write({ id: product.id, tags: [job.tagName] });
      } else if (action === "remove") {
        // The casing stored on the product, so the removal lands whether or not
        // Shopify matches tag case.
        await removeWriter.write({
          id: product.id,
          tags: [tagForAction(product.tags, job.tagName, "remove")],
        });
      }

      // Checkpoint: publishes "Scanning 5,000 of 150,000" to the UI and renews
      // the lease (recordProgress extends lockedUntil) so a multi-minute
      // download is never mistaken for a dead runner.
      if (processed % PROGRESS_BATCH_SIZE === 0) {
        const latest = await recordProgress(job, processed, {
          processed,
          toTag: addWriter.count,
          toUntag: removeWriter.count,
        });
        // A cancel (or the watchdog) can land mid-stream; stop promptly instead
        // of finishing a download nobody is waiting for.
        if (latest.status !== SYNC_STATUS.downloading) throw new SyncAborted();
      }
    }
  } catch (error) {
    await addWriter.destroy();
    await removeWriter.destroy();
    throw error;
  }

  const toTag = await addWriter.close();
  const toUntag = await removeWriter.close();
  if (!toTag) await removeFile(addPath);
  if (!toUntag) await removeFile(removePath);

  const common = {
    processed,
    total: Math.max(job.total, processed),
    toTag,
    toUntag,
    mutationProcessed: 0,
    lastProgressCount: 0,
    lastProgressAt: new Date(),
    addJsonlPath: toTag ? addPath : null,
    removeJsonlPath: toUntag ? removePath : null,
  };

  if (!toTag && !toUntag) {
    return { job: await finish(job.shop, SYNC_STATUS.completed, common) };
  }

  return {
    job: await transitionFrom(job.shop, SYNC_STATUS.downloading, {
      ...common,
      status: toTag ? SYNC_STATUS.tagging : SYNC_STATUS.untagging,
    }),
    waitMs: 0,
  };
}

const MUTATION_PHASES = {
  add: {
    idField: "addMutationBulkOperationId",
    pathField: "addJsonlPath",
    mutation: ADD_TAG_MUTATION,
    resultField: "tagsAdd",
    filename: "add-tags.jsonl",
    resultCounter: "tagged",
  },
  remove: {
    idField: "removeMutationBulkOperationId",
    pathField: "removeJsonlPath",
    mutation: REMOVE_TAG_MUTATION,
    resultField: "tagsRemove",
    filename: "remove-tags.jsonl",
    resultCounter: "untagged",
  },
};

async function stepMutating(admin, job, phase) {
  const spec = MUTATION_PHASES[phase];
  let operationId = job[spec.idField];

  if (!operationId) {
    // A crash between "upload staged" and "id persisted" would otherwise start a
    // second bulk mutation. Adopt one that is already running instead.
    const current = await fetchCurrentBulkOperation(admin, "MUTATION").catch(() => null);
    if (current && IN_FLIGHT.has(current.status)) {
      operationId = current.id;
    } else {
      const filePath = job[spec.pathField];
      if (!(await fileExists(filePath))) {
        // The temp file is gone (restart on ephemeral storage, or another
        // instance). Rebuilding it means re-running the export.
        throw new FatalError(
          "The prepared tag update was lost before it could be sent. Run the sync again.",
        );
      }
      const stagedUploadPath = await stageJsonlUpload(admin, filePath, spec.filename);
      operationId = (await runBulkMutation(admin, spec.mutation, stagedUploadPath)).id;
    }

    job = await transitionFrom(job.shop, job.status, {
      [spec.idField]: operationId,
      lastProgressAt: new Date(),
    });
    if (!isBulkSyncActive(job)) throw new SyncAborted();
  }

  const op = await fetchBulkOperationStatus(admin, operationId);

  if (!op || IN_FLIGHT.has(op.status)) {
    const done = Number(op?.objectCount || 0);
    const updated = await recordProgress(job, done, { mutationProcessed: done }, {
      queued: op?.status === "CREATED",
    });
    return { job: updated, waitMs: POLL_INTERVAL_MS };
  }

  if (op.status !== TERMINAL_OK) {
    await cleanupFiles(job);
    return {
      job: await finish(job.shop, SYNC_STATUS.failed, {
        errorMessage: `Tag update ${op.status.toLowerCase()}${op.errorCode ? `: ${op.errorCode}` : ""}`,
      }),
    };
  }

  const { succeeded, failed } = op.url
    ? await countMutationResults(op.url, spec.resultField)
    : { succeeded: 0, failed: 0 };

  await removeFile(job[spec.pathField]);

  const data = {
    [spec.resultCounter]: succeeded,
    failed: job.failed + failed,
    [spec.pathField]: null,
    mutationProcessed: 0,
    lastProgressCount: 0,
    lastProgressAt: new Date(),
  };

  if (phase === "add" && job.toUntag > 0) {
    return {
      job: await transitionFrom(job.shop, SYNC_STATUS.tagging, {
        ...data,
        status: SYNC_STATUS.untagging,
      }),
      waitMs: 0,
    };
  }

  return { job: await finish(job.shop, SYNC_STATUS.completed, data) };
}

/**
 * Result lines look like {"data":{"tagsAdd":{"userErrors":[]}},"__lineNumber":0},
 * or carry a top-level "errors" key when that row's mutation failed. Streamed so
 * a 150k-row result set costs no more memory than a 10-row one.
 */
async function countMutationResults(url, fieldName) {
  let succeeded = 0;
  let failed = 0;

  for await (const line of streamJsonlFromUrl(url, { label: "mutationResults" })) {
    const userErrors = line?.data?.[fieldName]?.userErrors ?? [];
    if (line?.errors || userErrors.length > 0) {
      failed += 1;
    } else {
      succeeded += 1;
    }
  }

  return { succeeded, failed };
}
