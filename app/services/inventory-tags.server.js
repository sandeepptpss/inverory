import db from "../db.server";
import { graphqlWithRetry } from "./shopify-retry.server";

export const DEFAULT_TAG_NAME = "out-of-stock-hidden";
export const DEFAULT_AUTO_SYNC = false;

export async function getSettings(shop) {
  const setting = await db.tagAutomationSetting.findUnique({ where: { shop } });
  return {
    tagName: setting?.tagName || DEFAULT_TAG_NAME,
    autoSyncEnabled: setting?.autoSyncEnabled ?? DEFAULT_AUTO_SYNC,
  };
}

export async function getTagName(shop) {
  const settings = await getSettings(shop);
  return settings.tagName;
}

export async function setSettings(shop, { tagName, autoSyncEnabled }) {
  const existing = await db.tagAutomationSetting.findUnique({
    where: { shop },
  });
  const finalTagName =
    tagName !== undefined ? tagName : existing?.tagName || DEFAULT_TAG_NAME;
  const finalAutoSync =
    autoSyncEnabled !== undefined
      ? autoSyncEnabled
      : (existing?.autoSyncEnabled ?? DEFAULT_AUTO_SYNC);

  return db.tagAutomationSetting.upsert({
    where: { shop },
    update: {
      ...(tagName !== undefined ? { tagName } : {}),
      ...(autoSyncEnabled !== undefined ? { autoSyncEnabled } : {}),
    },
    create: {
      shop,
      tagName: finalTagName,
      autoSyncEnabled: finalAutoSync,
    },
  });
}

export async function setTagName(shop, tagName) {
  return setSettings(shop, { tagName });
}

// Pure decision logic, kept separate from I/O so it can be unit tested directly.
export function resolveTagAction({ status, tags, quantity, tracked, tagName }) {
  if (status !== "ACTIVE") {
    return null;
  }

  const tagList = Array.isArray(tags) ? tags : [];
  const hasTag = tagList.includes(tagName);

  // Untracked products stay purchasable no matter what quantity reports, so they
  // must never carry the tag.
  if (!tracked) {
    return hasTag ? "remove" : null;
  }

  // A tracked product must report a real number before any tag decision is made.
  // `null < 1` is true in JS, so a missing/garbled quantity used to be read as
  // "out of stock" and tagged an in-stock product.
  if (!Number.isFinite(Number(quantity)) || quantity === null) {
    return null;
  }

  if (quantity < 1) {
    return hasTag ? null : "add";
  }

  return hasTag ? "remove" : null;
}

export async function applyTagAction(
  admin,
  productId,
  tagName,
  tagAction,
  options = {},
) {
  const mutation =
    tagAction === "add"
      ? `#graphql
        mutation addOutOfStockTag($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }`
      : `#graphql
        mutation removeOutOfStockTag($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }`;

  // graphqlWithRetry retries THROTTLED/429/5xx and throws on a top-level
  // `errors` payload. A raw admin.graphql() call could not tell those apart:
  // Shopify answers a throttle with HTTP 200 + {errors:[…]} and no `data`, which
  // read as "zero userErrors" — a silently dropped tag update.
  const data = await graphqlWithRetry(admin, mutation, {
    variables: { id: productId, tags: [tagName] },
    label: tagAction === "add" ? "tagsAdd" : "tagsRemove",
    ...(options.attempts ? { attempts: options.attempts } : {}),
  });

  const userErrors =
    tagAction === "add"
      ? data?.tagsAdd?.userErrors
      : data?.tagsRemove?.userErrors;

  return userErrors || [];
}

// ---------------------------------------------------------------------------
// Per-product serialization
// ---------------------------------------------------------------------------

/**
 * Shopify delivers inventory_levels/update webhooks concurrently — one per
 * (inventory item, location) — so a single order across a multi-variant product
 * fires several at once. Each one independently reads totalInventory and then
 * writes a tag, so two overlapping handlers can read different snapshots and
 * apply their mutations in the wrong order, leaving the tag contradicting stock
 * until the next manual sync.
 *
 * Chaining the work per product makes every handler read the state left by the
 * previous one, so the last writer is always the one with the freshest read.
 *
 * `work` receives `{ waited }`: true when this call actually queued behind
 * another. Callers use it to re-read the product only when it could have been
 * changed underneath them, so the uncontended path costs no extra API call.
 */
const PRODUCT_LOCKS = new Map();

export function withProductLock(key, work) {
  const previous = PRODUCT_LOCKS.get(key);
  const waited = previous !== undefined;
  const run = () => work({ waited });

  // Swallow the predecessor's rejection: a failed handler must not cascade into
  // the next one, it only has to finish so the next can take its turn.
  const result = previous ? previous.then(run, run) : (async () => run())();

  // The tail is what the next caller waits on. It never rejects, so the chain
  // survives a failure, and only the current tail clears the map entry —
  // otherwise a caller that queued in the meantime would lose its lock.
  const tail = result.then(
    () => {},
    () => {},
  );
  PRODUCT_LOCKS.set(key, tail);
  tail.then(() => {
    if (PRODUCT_LOCKS.get(key) === tail) PRODUCT_LOCKS.delete(key);
  });

  return result;
}
