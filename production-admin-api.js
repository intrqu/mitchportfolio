const PRODUCTION_PROJECT_ID = "mht-giftcards-production";
const PRODUCTION_AUTH_DOMAIN = `${PRODUCTION_PROJECT_ID}.firebaseapp.com`;

const ACTION_ROUTES = Object.freeze({
  listOrders: { method: "GET", path: "/api/admin/orders" },
  confirmPayment: {
    method: "POST",
    path: (data) => `/api/admin/orders/${encodeURIComponent(data.orderId)}/confirm-payment`
  },
  retryOrderEmails: {
    method: "POST",
    path: (data) => `/api/admin/orders/${encodeURIComponent(data.orderId)}/retry-order-emails`
  },
  resendCertificate: {
    method: "POST",
    path: (data) => `/api/admin/orders/${encodeURIComponent(data.orderId)}/resend`
  },
  lookupCertificate: { method: "POST", path: "/api/admin/certificates/lookup" },
  redeemCertificate: { method: "POST", path: "/api/admin/certificates/redeem" }
});

export function validateProductionAdminConfig(config) {
  if (!config ||
      config.projectId !== PRODUCTION_PROJECT_ID ||
      config.authDomain !== PRODUCTION_AUTH_DOMAIN ||
      typeof config.apiKey !== "string" ||
      !config.apiKey ||
      config.apiKey.startsWith("REPLACE_") ||
      typeof config.appId !== "string" ||
      !config.appId ||
      config.appId.startsWith("REPLACE_")) {
    throw new Error("Production Firebase web-app configuration is missing or does not match.");
  }

  let workerUrl;
  try {
    workerUrl = new URL(config.workerApiBaseUrl);
  } catch {
    throw new Error("The production Worker URL is not configured.");
  }
  if (workerUrl.protocol !== "https:" ||
      !workerUrl.hostname.startsWith("mht-giftcards-api.") ||
      !workerUrl.hostname.endsWith(".workers.dev") ||
      workerUrl.hostname === "mht-giftcards-api.workers.dev" ||
      workerUrl.port ||
      workerUrl.username ||
      workerUrl.password ||
      (workerUrl.pathname !== "" && workerUrl.pathname !== "/") ||
      workerUrl.search ||
      workerUrl.hash) {
    throw new Error("The admin page must use the dedicated production Worker URL.");
  }
  return { workerApiBaseUrl: workerUrl.origin };
}

export function createProductionAdminApi(config, auth, fetcher = fetch) {
  const { workerApiBaseUrl } = validateProductionAdminConfig(config);
  return {
    async call(action, data = {}) {
      const route = ACTION_ROUTES[action];
      if (!route) throw new Error("This production administration action is not available.");
      const user = auth.currentUser;
      if (!user) throw new Error("Sign in to continue.");

      const path = typeof route.path === "function" ? route.path(data) : route.path;
      const headers = new Headers({
        Authorization: `Bearer ${await user.getIdToken()}`,
        Accept: "application/json"
      });
      const init = { method: route.method, headers };
      if (route.method === "POST") {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(data);
      }

      const response = await fetcher(`${workerApiBaseUrl}${path}`, init);
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error("The production Worker returned an invalid response.");
      }
      if (!response.ok) {
        const requestError = new Error(result?.error || "The request could not be completed.");
        requestError.code = `production/${result?.code || "internal"}`;
        throw requestError;
      }
      return result;
    }
  };
}
