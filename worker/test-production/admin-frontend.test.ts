import { describe, expect, it } from "vitest";
import {
  createProductionAdminApi,
  validateProductionAdminConfig
} from "../../production-admin-api.js";

const config = {
  apiKey: "AIzaTestProductionWebApiKey",
  authDomain: "mht-giftcards-production.firebaseapp.com",
  projectId: "mht-giftcards-production",
  appId: "1:123456789:web:production",
  workerApiBaseUrl: "https://mht-giftcards-api.example.workers.dev"
};

describe("production admin frontend boundary", () => {
  it("accepts only production Firebase and the dedicated production Worker", () => {
    expect(validateProductionAdminConfig(config)).toEqual({
      workerApiBaseUrl: "https://mht-giftcards-api.example.workers.dev"
    });
    expect(() => validateProductionAdminConfig({
      ...config,
      projectId: "mht-giftcards-staging",
      authDomain: "mht-giftcards-staging.firebaseapp.com"
    })).toThrow("does not match");
    expect(() => validateProductionAdminConfig({
      ...config,
      apiKey: "REPLACE_WITH_PRODUCTION_FIREBASE_WEB_API_KEY",
      workerApiBaseUrl: ""
    })).toThrow("does not match");
    expect(() => validateProductionAdminConfig({
      ...config,
      workerApiBaseUrl: "https://mht-giftcards-staging-api.example.workers.dev"
    })).toThrow("dedicated production Worker");
    expect(() => validateProductionAdminConfig({
      ...config,
      workerApiBaseUrl: "https://mht-giftcards-api.example.workers.dev/path"
    })).toThrow("dedicated production Worker");
  });

  it("sends manual payment confirmation only to the production API with an admin bearer token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        action: "Confirm Payment Received",
        alreadyConfirmed: false,
        paymentEmailSent: true,
        certificateEmailSent: true
      });
    };
    const auth = { currentUser: { getIdToken: async () => "production-admin-id-token" } };
    const api = createProductionAdminApi(config, auth, fetcher);

    const result = await api.call("confirmPayment", {
      orderId: "prod-order-1",
      confirmationNote: "Matched to the bank account."
    });

    expect(result.action).toBe("Confirm Payment Received");
    const recorded = calls[0];
    if (!recorded?.init) throw new Error("The production API request was not captured.");
    const { url, init } = recorded;
    expect(url).toBe(
      "https://mht-giftcards-api.example.workers.dev/api/admin/orders/prod-order-1/confirm-payment"
    );
    expect(new Headers(init.headers).get("Authorization"))
      .toBe("Bearer production-admin-id-token");
    expect(JSON.parse(String(init.body))).toEqual({
      orderId: "prod-order-1",
      confirmationNote: "Matched to the bank account."
    });
    expect(url).not.toContain("simulate-payment");
  });

  it("routes certificate lookup and redemption through the production admin API only", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ ok: true });
    };
    const auth = { currentUser: { getIdToken: async () => "production-admin-id-token" } };
    const api = createProductionAdminApi(config, auth, fetcher);

    await api.call("lookupCertificate", { code: `MHTPROD${"A".repeat(32)}` });
    await api.call("redeemCertificate", {
      code: `MHTPROD${"A".repeat(32)}`,
      amountCents: 500,
      note: "",
      requestId: "35a94226-a7ed-40c4-96d2-c42bd7a4da87"
    });

    expect(urls).toEqual([
      "https://mht-giftcards-api.example.workers.dev/api/admin/certificates/lookup",
      "https://mht-giftcards-api.example.workers.dev/api/admin/certificates/redeem"
    ]);
  });

  it("rejects unavailable or simulated actions and unauthenticated requests", async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ ok: true });
    };
    const auth = { currentUser: null };
    const api = createProductionAdminApi(config, auth, fetcher);

    // @ts-expect-error Exercise rejection of a route not in the production action whitelist.
    await expect(api.call("simulatePayment", { orderId: "order-1" }))
      .rejects.toThrow("not available");
    await expect(api.call("listOrders")).rejects.toThrow("Sign in");
    expect(urls).toHaveLength(0);
  });
});
