import { authenticate } from "../shopify.server";
import {
  applyTagAction,
  getSettings,
  resolveTagAction,
  withProductLock,
} from "../services/inventory-tags.server";
import {
  graphqlWithRetry,
  shouldRedeliverWebhook,
} from "../services/shopify-retry.server";

const PRODUCT_FOR_IMPORT = `#graphql
  query getProductForImport($id: ID!) {
    product(id: $id) {
      id
      status
      tags
      totalInventory
      tracksInventory
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

  const productId = payload?.id;
  if (!productId) {
    return new Response();
  }

  const settings = await getSettings(shop);
  if (!settings.autoSyncEnabled) {
    console.log(
      `Auto Sync is disabled for ${shop}; skipping product create webhook.`,
    );
    return new Response();
  }

  const productGid = String(productId).startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  try {
    // Shares the inventory webhook's lock so an import and an inventory change
    // for the same product cannot interleave their reads and writes.
    await withProductLock(`${shop}:${productGid}`, async () => {
      const data = await graphqlWithRetry(admin, PRODUCT_FOR_IMPORT, {
        variables: { id: productGid },
        label: "getProductForImport",
        attempts: WEBHOOK_ATTEMPTS,
      });

      const product = data?.product;
      if (!product) return;

      const tagName = settings.tagName;
      const tagAction = resolveTagAction({
        status: product.status,
        tags: product.tags,
        quantity: product.totalInventory,
        tracked: product.tracksInventory,
        tagName,
      });

      if (!tagAction) return;

      const userErrors = await applyTagAction(
        admin,
        product.id,
        tagName,
        tagAction,
        {
          attempts: WEBHOOK_ATTEMPTS,
        },
      );
      if (userErrors.length) {
        console.error(
          `${tagAction === "add" ? "tagsAdd" : "tagsRemove"} failed for imported product ${product.id}:`,
          userErrors,
        );
      }
    });
  } catch (error) {
    console.error(
      `Auto Sync failed for imported product ${productGid} on ${shop}:`,
      error,
    );

    if (shouldRedeliverWebhook(error)) {
      return new Response("Retryable upstream failure", { status: 500 });
    }
  }

  return new Response();
};
