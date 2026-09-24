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

let currentAdminSession = null;

/** What `authenticate.admin` resolves to for the dashboard route's loader/action. */
export function setAdminSession(value) {
  currentAdminSession = value;
}

export const authenticate = {
  admin: async () => {
    if (!currentAdminSession) throw new Error("No admin session registered for this test");
    return {
      session: { shop: currentAdminSession.shop },
      admin: currentAdminSession.admin,
    };
  },
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
export default { unauthenticated, authenticate, setAdmin, setAdminSession, setWebhookResult };

