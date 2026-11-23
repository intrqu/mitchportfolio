import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, randomBase64Url } from "../src/crypto.js";
import { handleProductionRequest, normalizeProductionCode } from "../src/production/index.js";
import type { ProductionEnv } from "../src/production/types.js";
import { normalizeRedemptionCode } from "../src/validation.js";

const workerEnv = env as ProductionEnv;
const allowedOrigin = "https://mitchharschtattoo.com";
const sentEmails: Array<{ body: Record<string, unknown>; idempotencyKey: string | null }> = [];
let fetcher: typeof fetch;

const adminVerifier = async (token: string) => {
  if (token === "valid-admin") {
    return { uid: "production-admin-1", admin: true, email: "admin@example.com" };
  }
  if (token === "valid-customer") {
    return { uid: "customer-1", admin: false, email: "customer@example.com" };
  }
  throw new Error("Invalid token");
};

function installFetchStub() {
  sentEmails.length = 0;
  fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("challenges.cloudflare.com/turnstile")) {
      return Response.json({
        success: true,
        hostname: "mitchharschtattoo.com",
        action: "gift_card_order"
      });
    }
    if (url === "https://api.resend.com/emails") {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentEmails.push({
        body: requestBody,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key")
      });
      return Response.json({ id: `production-test-email-${sentEmails.length}` });
    }
    return new Response("Unexpected test fetch", { status: 500 });
  };
}

async function clearDatabase() {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare("DELETE FROM gift_card_redemptions"),
    workerEnv.DB.prepare("DELETE FROM gift_card_email_deliveries"),
    workerEnv.DB.prepare("DELETE FROM gift_certificates"),
    workerEnv.DB.prepare("DELETE FROM gift_card_orders"),
    workerEnv.DB.prepare("DELETE FROM gift_card_ip_limits"),
    workerEnv.DB.prepare(`
      UPDATE gift_card_global_limits
      SET order_day = '', order_count = 0, email_day = '', email_count = 0 WHERE id = 1
    `)
  ]);
}

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: 10_000,
    purchaserName: "Production Test Purchaser",
    purchaserEmail: "customer@example.com",
    recipientName: "Production Test Recipient",
    recipientEmail: "recipient@example.com",
    recipientType: "other",
    message: "A private production test",
    accessToken: randomBase64Url(32),
    idempotencyKey: crypto.randomUUID(),
    turnstileToken: "production-test-turnstile",
    ...overrides
  };
}

async function callApi(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
    accessToken?: string;
    ip?: string;
    env?: ProductionEnv;
  } = {}
): Promise<Response> {
  const headers = new Headers({
    Origin: allowedOrigin,
    "Content-Type": "application/json",
    "CF-Connecting-IP": options.ip ?? `192.0.2.${Math.floor(Math.random() * 200) + 1}`
  });
  const token = options.token ?? options.accessToken;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return handleProductionRequest(new Request(`https://production.test${path}`, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }), options.env ?? workerEnv, { verifyAdminToken: adminVerifier, fetcher });
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  const body = orderBody(overrides);
  const response = await callApi("/api/orders", { body });
  const data = await response.json() as {
    orderRef?: string;
    accessToken?: string;
    interacEmail?: string;
    testOnly?: boolean;
    error?: string;
  };
  expect(response.status, data.error).toBe(200);
  return { body, data };
}

async function listOrders() {
  const response = await callApi("/api/admin/orders", { token: "valid-admin" });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ orders: Array<{ id: string; order_ref: string }> }>;
}

async function confirmOrder(id: string) {
  return callApi(`/api/admin/orders/${id}/confirm-payment`, {
    method: "POST",
    body: { confirmationNote: "Matched to the bank account." },
    token: "valid-admin"
  });
}

async function confirmedCertificateCode(): Promise<{ orderId: string; code: string }> {
  await createOrder();
  const [{ id }] = (await listOrders()).orders;
  const confirmation = await confirmOrder(id);
  expect(confirmation.status).toBe(200);
  const certificate = await workerEnv.DB.prepare(`
    SELECT encrypted_code, code_iv, code_auth_tag
    FROM gift_certificates WHERE order_id = ?
  `).bind(id).first<{ encrypted_code: string; code_iv: string; code_auth_tag: string }>();
  if (!certificate) throw new Error("Test certificate was not issued.");
  const code = await decryptSecret({
    ciphertext: certificate.encrypted_code,
    iv: certificate.code_iv,
    authTag: certificate.code_auth_tag
  }, workerEnv.CERTIFICATE_ENCRYPTION_KEY);
  return { orderId: id, code };
}

beforeEach(async () => {
  await clearDatabase();
  installFetchStub();
});

afterEach(() => {
  fetcher = fetch;
});

describe("production gift card Worker", () => {
  it("uses isolated dummy credentials in the local production test environment", () => {
    expect(workerEnv.PRODUCTION_INTERAC_EMAIL).toBe("payments@example.com");
    expect(workerEnv.RESEND_API_KEY).toBe("test-resend-key");
    expect(workerEnv.TURNSTILE_SECRET_KEY).toBe("test-turnstile-key");
    expect(workerEnv.CERTIFICATE_ENCRYPTION_KEY)
      .toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(workerEnv.RATE_LIMIT_HMAC_KEY)
      .toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  });

  it("fails closed if any required secret or the D1 binding is missing", async () => {
    const requiredSecrets = [
      "PRODUCTION_ADMIN_EMAILS",
      "PRODUCTION_INTERAC_EMAIL",
      "RESEND_API_KEY",
      "TURNSTILE_SECRET_KEY",
      "CERTIFICATE_ENCRYPTION_KEY",
      "RATE_LIMIT_HMAC_KEY"
    ] as const;
    for (const secret of requiredSecrets) {
      const incompleteEnv = { ...workerEnv };
      Object.defineProperty(incompleteEnv, secret, { value: undefined });
      const response = await callApi("/api/healthz", { env: incompleteEnv });
      const result = await response.json() as { code: string };
      expect(response.status, secret).toBe(503);
      expect(result.code, secret).toBe("unsafe-config");
    }

    const missingDatabaseEnv = { ...workerEnv };
    Object.defineProperty(missingDatabaseEnv, "DB", { value: undefined });
    const response = await callApi("/api/healthz", { env: missingDatabaseEnv });
    const result = await response.json() as { code: string };
    expect(response.status).toBe(503);
    expect(result.code).toBe("unsafe-config");

    const issuance = await callApi("/api/admin/orders/order-id/confirm-payment", {
      body: {},
      token: "valid-admin",
      env: missingDatabaseEnv
    });
    const issuanceResult = await issuance.json() as { code: string };
    expect(issuance.status).toBe(503);
    expect(issuanceResult.code).toBe("unsafe-config");
    const redemption = await callApi("/api/admin/certificates/redeem", {
      body: {},
      token: "valid-admin",
      env: missingDatabaseEnv
    });
    const redemptionResult = await redemption.json() as { code: string };
    expect(redemption.status).toBe(503);
    expect(redemptionResult.code).toBe("unsafe-config");
    expect(sentEmails).toHaveLength(0);
  });

  it("fails closed when ordering is disabled", async () => {
    const disabledEnv = { ...workerEnv, ORDERS_ENABLED: "false" };
    const response = await callApi("/api/orders", {
      body: orderBody(),
      env: disabledEnv
    });
    const result = await response.json() as { code: string };
    expect(response.status).toBe(503);
    expect(result.code).toBe("orders-disabled");
    const count = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gift_card_orders"
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("creates production-only orders and sends real payment instructions", async () => {
    const { data } = await createOrder();
    expect(data.orderRef).toMatch(/^MHT-PROD-[0-9A-F]{16}$/);
    expect(data.testOnly).toBe(false);
    expect(data.interacEmail).toBe(workerEnv.PRODUCTION_INTERAC_EMAIL);
    expect(sentEmails).toHaveLength(2);
    const orderEmail = sentEmails.find(({ body }) =>
      Array.isArray(body.to) && body.to.includes("customer@example.com")
    );
    expect(orderEmail).toBeDefined();
    expect(String(orderEmail?.body.subject)).not.toContain("TEST ONLY");
    expect(String(orderEmail?.body.html)).toContain("payments@example.com");
    expect(String(orderEmail?.body.html)).toContain("$100.00 CAD");
    expect(String(orderEmail?.body.html)).toContain(data.orderRef);
    expect(String(orderEmail?.body.html)).toContain("confirms receipt");
    const row = await workerEnv.DB.prepare(`
      SELECT payment_method, payment_status, environment, test_only
      FROM gift_card_orders WHERE order_ref = ?
    `).bind(data.orderRef).first<{
      payment_method: string;
      payment_status: string;
      environment: string;
      test_only: number;
    }>();
    expect(row).toEqual({
      payment_method: "interac_transfer",
      payment_status: "pending_payment",
      environment: "production",
      test_only: 0
    });
  });

  it("records a customer payment report without confirming or issuing", async () => {
    const { data } = await createOrder();
    const response = await callApi(`/api/orders/${data.orderRef}/report-payment`, {
      method: "POST",
      accessToken: data.accessToken,
      body: {}
    });
    const result = await response.json() as { paymentStatus: string; certificateIssued: boolean };
    expect(response.status).toBe(200);
    expect(result.paymentStatus).toBe("payment_reported");
    expect(result.certificateIssued).toBe(false);
    const order = await workerEnv.DB.prepare(`
      SELECT payment_status, payment_verified_at FROM gift_card_orders WHERE order_ref = ?
    `).bind(data.orderRef).first<{ payment_status: string; payment_verified_at: string | null }>();
    expect(order?.payment_status).toBe("payment_reported");
    expect(order?.payment_verified_at).toBeNull();
    const certificates = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gift_certificates"
    ).first<{ count: number }>();
    expect(certificates?.count).toBe(0);
  });

  it("requires admin confirmation and issues one valid certificate idempotently", async () => {
    const { data } = await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const denied = await callApi(`/api/admin/orders/${id}/confirm-payment`, {
      method: "POST",
      body: {},
      token: "valid-customer"
    });
    expect(denied.status).toBe(403);

    const first = await confirmOrder(id);
    const firstResult = await first.json() as {
      action: string;
      alreadyConfirmed: boolean;
      paymentEmailSent: boolean;
      certificateEmailSent: boolean;
    };
    expect(first.status).toBe(200);
    expect(firstResult.action).toBe("Confirm Payment Received");
    expect(firstResult.alreadyConfirmed).toBe(false);
    expect(firstResult.paymentEmailSent).toBe(true);
    expect(firstResult.certificateEmailSent).toBe(true);
    expect(firstResult).not.toHaveProperty("redemptionCode");
    expect(sentEmails).toHaveLength(4);
    const certificateEmail = sentEmails.find(({ body }) => Array.isArray(body.attachments));
    expect(certificateEmail).toBeDefined();
    expect(String(certificateEmail?.body.subject)).not.toContain("VOID");
    expect(String(certificateEmail?.body.html)).not.toContain("VOID");
    expect((certificateEmail?.body.attachments as Array<{ filename: string }>)[0].filename)
      .toBe(`${data.orderRef}.pdf`);

    const second = await confirmOrder(id);
    const secondResult = await second.json() as { alreadyConfirmed: boolean };
    expect(secondResult.alreadyConfirmed).toBe(true);
    expect(sentEmails).toHaveLength(4);
    const count = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gift_certificates WHERE order_id = ?"
    ).bind(id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("does not expose certificates before payment and serves a production PDF afterward", async () => {
    const { data } = await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const earlyResend = await callApi(`/api/admin/orders/${id}/resend`, {
      method: "POST",
      body: { requestId: crypto.randomUUID() },
      token: "valid-admin"
    });
    expect(earlyResend.status).toBe(412);

    const confirmation = await confirmOrder(id);
    expect(confirmation.status).toBe(200);
    const download = await callApi(`/api/orders/${data.orderRef}/certificate.pdf`, {
      accessToken: data.accessToken
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(await download.arrayBuffer());
    expect(pdf.getTitle()).toBe(`Gift Certificate ${data.orderRef}`);
    expect(pdf.getSubject()).toBe("Digital gift certificate");
  });

  it("supports idempotent partial redemption and rejects cross-environment codes", async () => {
    const { orderId, code } = await confirmedCertificateCode();
    expect(normalizeProductionCode(code)).toBe(code);
    expect(() => normalizeRedemptionCode(code)).toThrow();
    expect(() => normalizeProductionCode(`MHTTEST${"A".repeat(32)}`)).toThrow();
    const requestId = crypto.randomUUID();
    const redeem = () => callApi("/api/admin/certificates/redeem", {
      method: "POST",
      body: { code, amountCents: 3_000, note: "partial use", requestId },
      token: "valid-admin"
    });
    const first = await redeem();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      alreadyRedeemed: false,
      amountCents: 3_000,
      balanceAfterCents: 7_000
    });
    const retry = await redeem();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ alreadyRedeemed: true, balanceCents: 7_000 });
    const balance = await workerEnv.DB.prepare(`
      SELECT balance_cents, environment, test_only FROM gift_certificates WHERE order_id = ?
    `).bind(orderId).first<{ balance_cents: number; environment: string; test_only: number }>();
    expect(balance).toEqual({ balance_cents: 7_000, environment: "production", test_only: 0 });
  });

  it("prevents concurrent redemption requests from spending the same balance twice", async () => {
    const { code } = await confirmedCertificateCode();
    const redeem = (requestId: string) => callApi("/api/admin/certificates/redeem", {
      body: { code, amountCents: 7_000, note: "concurrent partial", requestId },
      token: "valid-admin"
    });
    const results = await Promise.all([
      redeem(crypto.randomUUID()),
      redeem(crypto.randomUUID())
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const balance = await workerEnv.DB.prepare(
      "SELECT balance_cents FROM gift_certificates WHERE code_hash = (SELECT code_hash FROM gift_certificates LIMIT 1)"
    ).first<{ balance_cents: number }>();
    expect(balance?.balance_cents).toBe(3_000);
  });

  it("rejects staging project configuration and simulated-payment routes", async () => {
    const stagingEnv = { ...workerEnv, FIREBASE_PROJECT_ID: "mht-giftcards-staging" };
    const health = await callApi("/api/healthz", { env: stagingEnv });
    expect(health.status).toBe(503);
    const simulate = await callApi("/api/admin/orders/test-id/simulate-payment", {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    expect(simulate.status).toBe(404);
  });
});
