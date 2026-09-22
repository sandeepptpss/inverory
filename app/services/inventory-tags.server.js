import db from "../db.server";
import { graphqlWithRetry } from "./shopify-retry.server";

export const DEFAULT_TAG_NAME = "out-of-stock-hidden";
export const DEFAULT_AUTO_SYNC = false;
/** Shopify rejects a tag longer than this. */
export const MAX_TAG_LENGTH = 255;

/**
 * Validates and cleans a merchant-entered tag name.
 *
 * A comma is the killer: Shopify splits `tagsAdd(tags: ["a, b"])` into two
 * separate tags, so the configured name could never be found on the product
 * again — every sync would re-tag the whole catalog and no product would ever
 * be untagged.
 */
export function normalizeTagName(value) {
  const tagName = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!tagName) {
    return { ok: false, error: "Tag name cannot be empty." };
  }
  if (tagName.includes(",")) {
    return {
      ok: false,
      error:
        "Tag name cannot contain a comma — Shopify reads it as a separator between two tags.",
    };
  }
  if (tagName.length > MAX_TAG_LENGTH) {
    return {
      ok: false,
      error: `Tag name cannot be longer than ${MAX_TAG_LENGTH} characters.`,
    };
  }

  return { ok: true, tagName };
}

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
  if (tagName !== undefined) {
    const validated = normalizeTagName(tagName);
    if (!validated.ok) throw new Error(validated.error);
    tagName = validated.tagName;
  }

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

const canonicalTag = (value) => String(value ?? "").trim().toLowerCase();

/**
 * The tag as it is actually stored on the product, or null. Shopify treats tags
 * case-insensitively, so "Out-Of-Stock" and "out-of-stock" are one tag to the
 * store — matching on the exact string left a restocked product tagged forever
 * and re-sent tagsAdd for it on every run.
 */
export function findExistingTag(tags, tagName) {
  const wanted = canonicalTag(tagName);
  if (!wanted) return null;
  const tagList = Array.isArray(tags) ? tags : [];
  return tagList.find((tag) => canonicalTag(tag) === wanted) ?? null;
}

/**
 * The exact string to hand Shopify for this action. A removal targets the
 * casing stored on the product, so it works whether or not Shopify matches tag
 * case on the way out.
 */
export function tagForAction(tags, tagName, action) {
  if (action !== "remove") return tagName;
  return findExistingTag(tags, tagName) ?? tagName;
}

/**
 * A quantity only counts when Shopify really reported a number. Passing the
 * value straight to `< 1` reads `""`, `[]` and `null` as "out of stock" and
 * tags a product that is actually in stock.
 */
function toQuantity(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Pure decision logic, kept separate from I/O so it can be unit tested directly.
export function resolveTagAction({ status, tags, quantity, tracked, tagName }) {
  if (status !== "ACTIVE") {
    return null;
  }

  // Without a configured tag there is no decision to make; acting would mean
  // writing an empty tag onto the catalog.
  if (!canonicalTag(tagName)) {
    return null;
  }

  const hasTag = findExistingTag(tags, tagName) !== null;

  // Untracked products stay purchasable no matter what quantity reports, so they
  // must never carry the tag.
  if (!tracked) {
    return hasTag ? "remove" : null;
  }

  const amount = toQuantity(quantity);
  if (amount === null) {
    return null;
  }

  if (amount < 1) {
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
