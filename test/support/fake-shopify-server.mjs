// Stands in for app/shopify.server.js, which would otherwise demand real API
// credentials at import time. Tests register the admin client the background
// runner should receive.

let currentAdmin = null;

export function setAdmin(admin) {
  currentAdmin = admin;
}

export const unauthenticated = {
  async admin() {
    if (!currentAdmin) throw new Error("No admin registered for this test");
    return { admin: currentAdmin, session: { shop: "test.myshopify.com" } };
  },
};

let currentWebhookResult = null;

export function setWebhookResult(result) {
  currentWebhookResult = result;
}

export const authenticate = {
  webhook: async (request) => {
    if (typeof currentWebhookResult === "function") {
      return currentWebhookResult(request);
    }
    if (currentWebhookResult) return currentWebhookResult;
    return {
      shop: "test.myshopify.com",
      topic: "inventory_levels/update",
      payload: {},
      admin: currentAdmin,
    };
  },
};
export const apiVersion = "2026-07";
export default { unauthenticated, authenticate, setAdmin, setWebhookResult };

