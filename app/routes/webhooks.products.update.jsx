import { authenticate } from "../shopify.server";
import { syncProductTagFromWebhook } from "../services/product-webhook.server";

/**
 * Inventory webhooks only fire when a quantity moves, so on their own they miss
 * every change that makes an existing product eligible for the rules:
 * publishing a sold-out draft, archiving and restoring, or switching inventory
 * tracking on or off. Without this topic those products keep whatever tag they
 * had until the merchant runs a full catalog sync by hand.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    return new Response();
  }

  return syncProductTagFromWebhook({
    shop,
    admin,
    payload,
    label: "product update webhook",
  });
};
