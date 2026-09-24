import db from "../db.server";
import { graphqlWithRetry } from "./shopify-retry.server";

export const DEFAULT_TAG_NAME = "out-of-stock-hidden";
export const DEFAULT_AUTO_SYNC = false;
/** Shopify rejects a tag longer than this. */
export const MAX_TAG_LENGTH = 255;

export const COLLECTION_GID_PREFIX = "gid://shopify/Collection/";
/** Width of the collectionTitle columns; Shopify allows titles this long. */
export const MAX_COLLECTION_TITLE_LENGTH = 255;

/**
 * The cached title is display-only, so an over-long one is shortened rather
 * than allowed to fail the whole settings save. Cut on code points so an emoji
 * is never split into half a surrogate pair, which MySQL rejects outright.
 */
export function clipCollectionTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) return null;
  const chars = Array.from(title);
  return chars.length > MAX_COLLECTION_TITLE_LENGTH
    ? chars.slice(0, MAX_COLLECTION_TITLE_LENGTH).join("")
    : title;
}

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

/**
 * Accepts what a picker or a form can plausibly hand back — a Collection GID, a
 * bare numeric id, or nothing at all — and returns the canonical GID, or null
 * for "no scope, use the whole catalog".
 *
 * Anything else is rejected rather than silently dropped: a malformed id that
 * fell through as null would quietly widen the sync back to the full catalog,
 * which is the one mistake a merchant would not notice until it had already
 * retagged products outside the collection they picked.
 */
export function normalizeCollectionId(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "all") {
    return { ok: true, collectionId: null };
  }

  if (/^\d+$/.test(raw)) {
    return { ok: true, collectionId: `${COLLECTION_GID_PREFIX}${raw}` };
  }

  const legacyId = raw.startsWith(COLLECTION_GID_PREFIX)
    ? raw.slice(COLLECTION_GID_PREFIX.length)
    : null;
  if (legacyId && /^\d+$/.test(legacyId)) {
    return { ok: true, collectionId: raw };
  }

  return { ok: false, error: "That is not a valid collection." };
}

/** The numeric id Shopify's `products(query:)` search filter expects. */
export function collectionLegacyId(collectionId) {
  const raw = String(collectionId ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const legacyId = raw.startsWith(COLLECTION_GID_PREFIX)
    ? raw.slice(COLLECTION_GID_PREFIX.length)
    : null;
  return legacyId && /^\d+$/.test(legacyId) ? legacyId : null;
}

export async function getSettings(shop) {
  const setting = await db.tagAutomationSetting.findUnique({ where: { shop } });
  return {
    tagName: setting?.tagName || DEFAULT_TAG_NAME,
    autoSyncEnabled: setting?.autoSyncEnabled ?? DEFAULT_AUTO_SYNC,
    // Normalised on the way out too, so a row written before this column
    // existed (or an empty string from an older form post) reads as "no scope"
    // rather than as a collection whose id is "".
    collectionId: setting?.collectionId || null,
    collectionTitle: (setting?.collectionId && setting?.collectionTitle) || null,
  };
}

const COLLECTIONS_PAGE = `#graphql
  query dashboardCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }`;

const COLLECTIONS_PAGE_SIZE = 250;
const COLLECTIONS_MAX_PAGES = 5;

/**
 * The collections the picker offers. Paged rather than capped at one request so
 * a store with a few hundred collections can still find the one it wants; the
 * page ceiling keeps a pathological catalog from stalling the dashboard load.
 */
export async function fetchCollections(admin) {
  const collections = [];
  let after = null;

  for (let page = 0; page < COLLECTIONS_MAX_PAGES; page += 1) {
    const data = await graphqlWithRetry(admin, COLLECTIONS_PAGE, {
      variables: { first: COLLECTIONS_PAGE_SIZE, after },
      label: "dashboardCollections",
      attempts: 2,
    });

    const connection = data?.collections;
    for (const node of connection?.nodes ?? []) {
      if (node?.id) collections.push({ id: node.id, title: node.title || node.id });
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }

  return collections;
}

const COLLECTION_BY_ID = `#graphql
  query dashboardCollection($id: ID!) {
    collection(id: $id) { id title }
  }`;

/**
 * The saved scope's collection as Shopify has it right now: `{ id, title }`,
 * or null when it no longer exists. Throws when Shopify could not be asked, so
 * callers can tell "deleted" apart from "unknown" and never block on the latter.
 *
 * Without this, a deleted collection fails silently in both directions: the
 * manual sync exports zero products and reports "Sync complete", and Auto Sync
 * skips every product without saying why.
 */
export async function fetchCollection(admin, collectionId) {
  const data = await graphqlWithRetry(admin, COLLECTION_BY_ID, {
    variables: { id: collectionId },
    label: "dashboardCollection",
    attempts: 2,
  });
  const node = data?.collection;
  return node?.id ? { id: node.id, title: node.title || node.id } : null;
}

export async function getTagName(shop) {
  const settings = await getSettings(shop);
  return settings.tagName;
}

export async function setSettings(
  shop,
  { tagName, autoSyncEnabled, collectionId, collectionTitle },
) {
  if (tagName !== undefined) {
    const validated = normalizeTagName(tagName);
    if (!validated.ok) throw new Error(validated.error);
    tagName = validated.tagName;
  }

  // `undefined` leaves the scope alone; `null` (or "") clears it back to the
  // whole catalog. Each caller only sends the fields its own form owns, so a
  // save from one card can never revert what another card changed.
  let scope;
  if (collectionId !== undefined) {
    const validated = normalizeCollectionId(collectionId);
    if (!validated.ok) throw new Error(validated.error);
    scope = {
      collectionId: validated.collectionId,
      collectionTitle: validated.collectionId ? clipCollectionTitle(collectionTitle) : null,
    };
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
      ...(scope ?? {}),
    },
    create: {
      shop,
      tagName: finalTagName,
      autoSyncEnabled: finalAutoSync,
      collectionId: scope?.collectionId ?? existing?.collectionId ?? null,
      collectionTitle: scope?.collectionTitle ?? existing?.collectionTitle ?? null,
    },
  });
}

export async function setCollectionScope(shop, collectionId, collectionTitle) {
  return setSettings(shop, { collectionId, collectionTitle });
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

/**
 * Pure decision logic, kept separate from I/O so it can be unit tested directly.
 *
 * `collectionScoped` / `inCollection` carry the optional collection scope. When
 * a collection is selected, a product outside it is left exactly as it is —
 * including a tag it already carries, which this app may well have put there
 * under a previous scope. Stripping those would make changing the selection a
 * destructive act on products the merchant did not ask about.
 */
export function resolveTagAction({
  status,
  tags,
  quantity,
  tracked,
  tagName,
  collectionScoped = false,
  inCollection = false,
}) {
  if (status !== "ACTIVE") {
    return null;
  }

  if (collectionScoped && inCollection !== true) {
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
