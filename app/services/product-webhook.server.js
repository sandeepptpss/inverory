import {
  applyStatusAction,
  applyTagAction,
  getSettings,
  resolveStatusAction,
  resolveTagAction,
  statusRulesActive,
  tagForAction,
  withProductLock,
} from "./inventory-tags.server";
import {
  graphqlWithRetry,
  shouldRedeliverWebhook,
} from "./shopify-retry.server";

const PRODUCT_FOR_TAG_SYNC = `#graphql
  query getProductForTagSync($id: ID!) {
    product(id: $id) {
      id
      status
      tags
      totalInventory
      tracksInventory
    }
  }`;

// Separate document rather than a conditional field, so the unscoped path sends
// exactly the query it always sent and costs exactly what it always cost.
const PRODUCT_FOR_TAG_SYNC_IN_COLLECTION = `#graphql
  query getProductForTagSyncInCollection($id: ID!, $collectionId: ID!) {
    product(id: $id) {
      id
      status
      tags
      totalInventory
      tracksInventory
      inCollection(id: $collectionId)
    }
  }`;

// Shopify treats a webhook that does not answer within a few seconds as a failed
// delivery, so the in-request retry budget is deliberately small: one quick
// retry absorbs a momentary throttle, and anything worse is handed back as a
// non-2xx for Shopify to redeliver with its own (much longer) backoff.
const WEBHOOK_ATTEMPTS = 2;

function toProductGid(id) {
  return String(id).startsWith("gid://") ? String(id) : `gid://shopify/Product/${id}`;
}

/**
 * Shared body of the products/create and products/update handlers: re-read the
 * product and bring its tag (and, with the status rules on, its status) in line
 * with the rules.
 *
 * products/update also fires for our own tagsAdd/tagsRemove/productUpdate. That
 * settles rather than loops: once the product matches the rules the next pass
 * resolves to no action, so the echo costs one read and stops.
 */
export async function syncProductTagFromWebhook({ shop, admin, payload, label }) {
  const productId = payload?.id;
  if (!productId) return new Response();

  // Draft and archived products are never modified, so a status we can read
  // straight from the payload saves the Admin API call entirely — worth having
  // on products/update, which fires on every product edit in the store.
  const payloadStatus = payload?.status ? String(payload.status).toUpperCase() : null;
  if (payloadStatus && payloadStatus !== "ACTIVE" && payloadStatus !== "UNLISTED") {
    return new Response();
  }

  const settings = await getSettings(shop);
  if (!settings.autoSyncEnabled) {
    console.log(`Auto Sync is disabled for ${shop}; skipping ${label}.`);
    return new Response();
  }

  // An unlisted product is only this app's business while the status rules are
  // in force; otherwise it is skipped exactly as it always was.
  const statusRules = statusRulesActive(settings);
  if (payloadStatus === "UNLISTED" && !statusRules) {
    return new Response();
  }

  const productGid = toProductGid(productId);
  const collectionId = settings.collectionId ?? null;

  try {
    // Shares the inventory webhook's lock so a product edit and an inventory
    // change for the same product cannot interleave their reads and writes.
    await withProductLock(`${shop}:${productGid}`, async () => {
      const data = await graphqlWithRetry(
        admin,
        collectionId ? PRODUCT_FOR_TAG_SYNC_IN_COLLECTION : PRODUCT_FOR_TAG_SYNC,
        {
          variables: collectionId
            ? { id: productGid, collectionId }
            : { id: productGid },
          label: collectionId
            ? "getProductForTagSyncInCollection"
            : "getProductForTagSync",
          attempts: WEBHOOK_ATTEMPTS,
        },
      );

      const product = data?.product;
      if (!product) return;

      const tagName = settings.tagName;
      const tagAction = resolveTagAction({
        status: product.status,
        tags: product.tags,
        quantity: product.totalInventory,
        tracked: product.tracksInventory,
        tagName,
        collectionScoped: Boolean(collectionId),
        inCollection: product.inCollection,
        manageUnlisted: statusRules,
      });

      if (tagAction) {
        const userErrors = await applyTagAction(
          admin,
          product.id,
          tagForAction(product.tags, tagName, tagAction),
          tagAction,
          { attempts: WEBHOOK_ATTEMPTS },
        );
        if (userErrors.length) {
          // userErrors are a rejection of the request itself (bad tag, missing
          // product); redelivering would fail identically, so log and accept.
          console.error(
            `${tagAction === "add" ? "tagsAdd" : "tagsRemove"} failed for ${product.id}:`,
            userErrors,
          );
        }
      }

      const statusAction = resolveStatusAction({
        status: product.status,
        quantity: product.totalInventory,
        tracked: product.tracksInventory,
        enabled: statusRules,
        inCollection: product.inCollection,
      });

      if (!statusAction) return;

      const statusErrors = await applyStatusAction(admin, product.id, statusAction, {
        attempts: WEBHOOK_ATTEMPTS,
      });
      if (statusErrors.length) {
        console.error(
          `productUpdate (status ${statusAction}) failed for ${product.id}:`,
          statusErrors,
        );
      }
    });
  } catch (error) {
    console.error(`Auto Sync failed for product ${productGid} on ${shop}:`, error);

    if (shouldRedeliverWebhook(error)) {
      return new Response("Retryable upstream failure", { status: 500 });
    }
  }

  return new Response();
}
