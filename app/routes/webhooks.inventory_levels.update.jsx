import { authenticate } from "../shopify.server";
import {
  applyTagAction,
  getSettings,
  resolveTagAction,
  tagForAction,
  withProductLock,
} from "../services/inventory-tags.server";
import {
  graphqlWithRetry,
  shouldRedeliverWebhook,
} from "../services/shopify-retry.server";

const PRODUCT_FOR_INVENTORY_ITEM = `#graphql
  query getProductForInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      variant {
        product {
          id
          status
          tags
          totalInventory
          tracksInventory
        }
      }
    }
  }`;

// Separate document rather than a conditional field, so the unscoped path sends
// exactly the query it always sent and costs exactly what it always cost.
const PRODUCT_FOR_INVENTORY_ITEM_IN_COLLECTION = `#graphql
  query getProductForInventoryItemInCollection($id: ID!, $collectionId: ID!) {
    inventoryItem(id: $id) {
      variant {
        product {
          id
          status
          tags
          totalInventory
          tracksInventory
          inCollection(id: $collectionId)
        }
      }
    }
  }`;

// Shopify treats a webhook that does not answer within a few seconds as a failed
// delivery, so the in-request retry budget is deliberately small: one quick
// retry absorbs a momentary throttle, and anything worse is handed back as a
// non-2xx for Shopify to redeliver with its own (much longer) backoff.
const WEBHOOK_ATTEMPTS = 2;

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  const inventoryItemId = payload.inventory_item_id;
  if (!inventoryItemId) {
    return new Response();
  }

  const settings = await getSettings(shop);
  if (!settings.autoSyncEnabled) {
    console.log(
      `Auto Sync is disabled for ${shop}; skipping inventory level update.`,
    );
    return new Response();
  }

  const inventoryItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  const collectionId = settings.collectionId ?? null;
  const lookupQuery = collectionId
    ? PRODUCT_FOR_INVENTORY_ITEM_IN_COLLECTION
    : PRODUCT_FOR_INVENTORY_ITEM;
  const lookupOptions = {
    variables: collectionId
      ? { id: inventoryItemGid, collectionId }
      : { id: inventoryItemGid },
    label: collectionId
      ? "getProductForInventoryItemInCollection"
      : "getProductForInventoryItem",
    attempts: WEBHOOK_ATTEMPTS,
  };

  try {
    // Resolve the product first so the lock can be keyed on it. Shopify fires one
    // webhook per (inventory item, location), so a single order on a multi-variant
    // product delivers several concurrently; without the lock they each read
    // totalInventory from a different moment and can apply their tag mutations out
    // of order, leaving the tag contradicting actual stock.
    const lookup = await graphqlWithRetry(admin, lookupQuery, lookupOptions);

    const productId = lookup?.inventoryItem?.variant?.product?.id;
    if (!productId) {
      return new Response();
    }

    await withProductLock(`${shop}:${productId}`, async ({ waited }) => {
      // Only re-read when this handler actually queued behind another one: that
      // predecessor may have changed the tags, so deciding on the snapshot taken
      // before the wait would undo its work. Uncontended webhooks — the normal
      // case — reuse the lookup and cost no extra call.
      const product = waited
        ? (await graphqlWithRetry(admin, lookupQuery, lookupOptions))
            ?.inventoryItem?.variant?.product
        : lookup.inventoryItem.variant.product;

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
      });

      if (!tagAction) return;

      const userErrors = await applyTagAction(
        admin,
        product.id,
        // A removal targets the casing stored on the product, not the
        // configured one, so it lands whether or not Shopify matches tag case.
        tagForAction(product.tags, tagName, tagAction),
        tagAction,
        {
          attempts: WEBHOOK_ATTEMPTS,
        },
      );
      if (userErrors.length) {
        // userErrors are a rejection of the request itself (bad tag, missing
        // product); redelivering would fail identically, so log and accept.
        console.error(
          `${tagAction === "add" ? "tagsAdd" : "tagsRemove"} failed for ${product.id}:`,
          userErrors,
        );
      }
    });
  } catch (error) {
    console.error(
      `Auto Sync failed for inventory item ${inventoryItemId} on ${shop}:`,
      error,
    );

    if (shouldRedeliverWebhook(error)) {
      return new Response("Retryable upstream failure", { status: 500 });
    }
  }

  return new Response();
};
