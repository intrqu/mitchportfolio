import { env } from "cloudflare:workers";
import { createLocalJWKSet, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyFirebaseAdminToken } from "../src/auth.js";
import { createCertificatePdf } from "../src/certificate.js";
import { handleRequest } from "../src/index.js";
import { randomBase64Url } from "../src/crypto.js";
import type { Env } from "../src/types.js";

const workerEnv = env as Env;
const allowedOrigin = "https://intrqu.github.io";
const sentEmails: Array<{ body: Record<string, unknown>; idempotencyKey: string | null }> = [];
const adminVerifier = async (token: string) => {
  if (token === "valid-admin") return { uid: "staging-admin-1", admin: true, email: "admin@example.com" };
  if (token === "valid-non-admin") return { uid: "customer-1", admin: false, email: "test@example.com" };
  if (token === "unavailable") throw new TypeError("fetch failed");
  throw new Error("Invalid token");
};

function installFetchStub() {
  sentEmails.length = 0;
  let failNextEmail = false;
  const mockedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("challenges.cloudflare.com/turnstile")) {
      return Response.json({
        success: true,
        hostname: "intrqu.github.io",
        action: "gift_card_order"
      });
    }
    if (url === "https://api.resend.com/emails") {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentEmails.push({
        body: requestBody,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key")
      });
      if (failNextEmail) {
        failNextEmail = false;
        return new Response("Temporary test failure", { status: 503 });
      }
      return Response.json({ id: `test-email-${sentEmails.length}` });
    }
    return new Response("Unexpected test fetch", { status: 500 });
  });
  vi.stubGlobal("fetch", mockedFetch);
  return () => { failNextEmail = true; };
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
    purchaserName: "Test Purchaser",
    purchaserEmail: "test@example.com",
    recipientName: "Test Recipient",
    recipientEmail: "test@example.com",
    recipientType: "other",
    message: "A staging gift",
    accessToken: randomBase64Url(32),
    idempotencyKey: crypto.randomUUID(),
    turnstileToken: "test-turnstile-token",
    ...overrides
  };
}

async function callApi(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
    ip?: string;
  } = {}
): Promise<Response> {
  const headers = new Headers({
    Origin: allowedOrigin,
    "Content-Type": "application/json"
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.ip) headers.set("CF-Connecting-IP", options.ip);
  return handleRequest(new Request(`https://giftcards.test${path}`, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }), workerEnv, { verifyAdminToken: adminVerifier });
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  const body = orderBody(overrides);
  const response = await callApi("/api/orders", { body, ip: `192.0.2.${Math.floor(Math.random() * 200) + 1}` });
  const data = await response.json() as {
    orderRef?: string;
    accessToken?: string;
    emailSent?: boolean;
    error?: string;
  };
  expect(response.status, data.error).toBe(200);
  return { data, body };
}

async function listOrders() {
  const response = await callApi("/api/admin/orders", { token: "valid-admin" });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ orders: Array<{ id: string; orderRef: string }> }>;
}

beforeEach(async () => {
  await clearDatabase();
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("staging gift card Worker", () => {
  it("persists an allowlisted order and makes retries idempotent", async () => {
    const { data, body } = await createOrder();
    expect(data.orderRef).toMatch(/^MHT-TEST-[0-9A-F]{16}$/);
    expect(data.accessToken).toBe(body.accessToken);
    expect(sentEmails).toHaveLength(2);
    expect(sentEmails.every((email) =>
      String(email.body.subject).startsWith("TEST ONLY — DO NOT SEND MONEY:") &&
      String(email.body.html).includes("TEST ONLY — DO NOT SEND MONEY")
    )).toBe(true);
    expect(String(sentEmails[0].body.html)).toContain("Order reference:");
    expect(String(sentEmails[0].body.html)).toContain(data.orderRef);
    expect(String(sentEmails[0].body.html)).toContain("test-interac@example.com");
    expect(String(sentEmails[0].body.html)).toContain("$100.00 CAD");
    expect(String(sentEmails[0].body.html)).toContain("transfer message");

    const retry = await callApi("/api/orders", {
      body: { ...body, turnstileToken: "fresh-test-turnstile-token" },
      ip: "192.0.2.201"
    });
    const retryData = await retry.json() as { orderRef: string; reusedRequest: boolean };
    expect(retry.status).toBe(200);
    expect(retryData.orderRef).toBe(data.orderRef);
    expect(retryData.reusedRequest).toBe(true);
    expect(sentEmails).toHaveLength(2);

    const orders = await listOrders();
    expect(orders.orders).toHaveLength(1);
  });

  it("rejects orders outside the staging email allowlist", async () => {
    const response = await callApi("/api/orders", {
      body: orderBody({ recipientEmail: "outside@example.net" }),
      ip: "192.0.2.210"
    });
    const result = await response.json() as { code: string };
    expect(response.status).toBe(400);
    expect(result.code).toBe("email-not-allowlisted");
    expect(sentEmails).toHaveLength(0);
  });

  it("limits public order attempts per IP and day", async () => {
    const ip = "192.0.2.220";
    expect((await callApi("/api/orders", { body: orderBody(), ip })).status).toBe(200);
    expect((await callApi("/api/orders", { body: orderBody(), ip })).status).toBe(200);
    const limited = await callApi("/api/orders", { body: orderBody(), ip });
    const result = await limited.json() as { code: string };
    expect(limited.status).toBe(429);
    expect(result.code).toBe("rate-limited");
  });

  it("retries a failed order email without duplicating the order", async () => {
    const failNextEmail = installFetchStub();
    failNextEmail();
    const body = orderBody();
    const first = await callApi("/api/orders", { body, ip: "192.0.2.221" });
    const firstResult = await first.json() as { emailSent: boolean };
    expect(firstResult.emailSent).toBe(false);
    expect(first.status).toBe(200);

    const [{ id }] = (await listOrders()).orders;
    const adminRetry = await callApi(`/api/admin/orders/${id}/retry-order-emails`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    const adminRetryResult = await adminRetry.json() as {
      confirmationEmailSent: boolean;
      adminEmailSent: boolean;
    };
    expect(adminRetryResult.confirmationEmailSent).toBe(true);
    expect(adminRetryResult.adminEmailSent).toBe(true);

    const retry = await callApi("/api/orders", {
      body: { ...body, turnstileToken: "fresh-test-turnstile-token" },
      ip: "192.0.2.222"
    });
    const retryResult = await retry.json() as { emailSent: boolean; reusedRequest: boolean };
    expect(retryResult.emailSent).toBe(true);
    expect(retryResult.reusedRequest).toBe(true);
    const orders = await listOrders();
    expect(orders.orders).toHaveLength(1);
    expect(sentEmails).toHaveLength(3);
  });

  it("requires a server-verified admin token and admin permission", async () => {
    const missing = await callApi("/api/admin/orders");
    expect(missing.status).toBe(401);
    const customer = await callApi("/api/admin/orders", { token: "valid-non-admin" });
    expect(customer.status).toBe(403);
    const forged = await callApi("/api/admin/orders", { token: "forged-token" });
    expect(forged.status).toBe(401);
    const unavailable = await callApi("/api/admin/orders", { token: "unavailable" });
    expect(unavailable.status).toBe(503);
  });

  it("verifies Firebase token issuer, audience, signature, expiration, and admin claim", async () => {
    const keyPair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    }, true, ["sign", "verify"]);
    const publicJwk: JWK = {
      ...await crypto.subtle.exportKey("jwk", keyPair.publicKey),
      kid: "test-staging-key",
      alg: "RS256",
      use: "sig"
    };
    const keySet = createLocalJWKSet({ keys: [publicJwk] });
    const token = await new SignJWT({ admin: true, email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-staging-key" })
      .setSubject("staging-admin")
      .setIssuer("https://securetoken.google.com/mht-giftcards-staging")
      .setAudience("mht-giftcards-staging")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);

    await expect(verifyFirebaseAdminToken(token, "mht-giftcards-staging", keySet))
      .resolves.toMatchObject({ uid: "staging-admin", admin: true, email: "admin@example.com" });
    await expect(verifyFirebaseAdminToken(token, "wrong-project", keySet)).rejects.toThrow();

    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({ admin: true, email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-staging-key" })
      .setSubject("staging-admin")
      .setIssuer("https://securetoken.google.com/mht-giftcards-staging")
      .setAudience("mht-giftcards-staging")
      .setIssuedAt(now - 7_200)
      .setExpirationTime(now - 3_600)
      .sign(keyPair.privateKey);
    await expect(verifyFirebaseAdminToken(expiredToken, "mht-giftcards-staging", keySet))
      .rejects.toThrow();
  });

  it("gates issuance on simulated admin payment and avoids duplicate issuance", async () => {
    const { data } = await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const certificatesBeforePayment = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gift_certificates"
    ).first<{ count: number }>();
    expect(certificatesBeforePayment?.count).toBe(0);

    const earlyIssue = await callApi(`/api/admin/orders/${id}/issue`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    expect(earlyIssue.status).toBe(412);
    const earlyDownload = await callApi(
      `/api/orders/${data.orderRef}/certificate.pdf`,
      { token: data.accessToken, ip: "192.0.2.230" }
    );
    expect(earlyDownload.status).toBe(412);

    const firstConfirm = await callApi(`/api/admin/orders/${id}/simulate-payment`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    const issued = await firstConfirm.json() as {
      alreadyConfirmed: boolean;
      emailSent: boolean;
      confirmationEmailSent: boolean;
      redemptionCode: string;
    };
    expect(firstConfirm.status).toBe(200);
    expect(issued.alreadyConfirmed).toBe(false);
    expect(issued.emailSent).toBe(true);
    expect(issued.confirmationEmailSent).toBe(true);
    expect(issued.redemptionCode).toMatch(/^MHTTEST[0-9A-F]{32}$/);
    expect(sentEmails).toHaveLength(4);
    expect(sentEmails.every((email) =>
      String(email.body.subject).startsWith("TEST ONLY — DO NOT SEND MONEY:") &&
      String(email.body.html).includes("TEST ONLY — DO NOT SEND MONEY")
    )).toBe(true);
    const certificateEmail = sentEmails.find((email) => Array.isArray(email.body.attachments));
    expect(certificateEmail).toBeDefined();
    expect(String(certificateEmail?.body.subject)).toContain("Gift certificate");
    expect(String(certificateEmail?.body.html)).toContain("VOID — TEST ONLY");
    expect((certificateEmail?.body.attachments as Array<{ filename: string }>)[0].filename)
      .toContain("VOID-TEST-ONLY.pdf");
    const attachment = (certificateEmail?.body.attachments as Array<{ content: string }>)[0];
    expect(atob(attachment.content).startsWith("%PDF-")).toBe(true);

    const download = await callApi(
      `/api/orders/${data.orderRef}/certificate.pdf`,
      { token: data.accessToken, ip: "192.0.2.231" }
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    expect(new TextDecoder().decode(new Uint8Array(await download.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    const secondConfirm = await callApi(`/api/admin/orders/${id}/simulate-payment`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    const retried = await secondConfirm.json() as { alreadyConfirmed: boolean };
    expect(retried.alreadyConfirmed).toBe(true);
    expect(sentEmails).toHaveLength(4);

    const certificateCount = await workerEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gift_certificates"
    ).first<{ count: number }>();
    expect(certificateCount?.count).toBe(1);
  });

  it("records partial redemptions once and preserves the exact remaining balance", async () => {
    await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const payment = await callApi(`/api/admin/orders/${id}/simulate-payment`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    const { redemptionCode } = await payment.json() as { redemptionCode: string };
    const requestId = crypto.randomUUID();

    const redeem = () => callApi("/api/admin/certificates/redeem", {
      method: "POST",
      body: { code: redemptionCode, amountCents: 3_000, note: "test partial", requestId },
      token: "valid-admin"
    });
    const first = await redeem();
    const firstResult = await first.json() as { alreadyRedeemed: boolean; balanceAfterCents: number };
    expect(first.status).toBe(200);
    expect(firstResult.alreadyRedeemed).toBe(false);
    expect(firstResult.balanceAfterCents).toBe(7_000);

    const retry = await redeem();
    const retryResult = await retry.json() as { alreadyRedeemed: boolean; balanceCents: number };
    expect(retry.status).toBe(200);
    expect(retryResult.alreadyRedeemed).toBe(true);
    expect(retryResult.balanceCents).toBe(7_000);

    const lookup = await callApi("/api/admin/certificates/lookup", {
      body: { code: redemptionCode },
      token: "valid-admin"
    });
    const lookupResult = await lookup.json() as {
      certificate: { balanceCents: number; testOnly: boolean };
      redemptions: unknown[];
    };
    expect(lookupResult.certificate.balanceCents).toBe(7_000);
    expect(lookupResult.certificate.testOnly).toBe(true);
    expect(lookupResult.redemptions).toHaveLength(1);
  });

  it("serializes concurrent redemption attempts without allowing a negative balance", async () => {
    await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const payment = await callApi(`/api/admin/orders/${id}/simulate-payment`, {
      method: "POST",
      body: {},
      token: "valid-admin"
    });
    const { redemptionCode } = await payment.json() as { redemptionCode: string };
    const redeem = (amountCents: number) => callApi("/api/admin/certificates/redeem", {
      body: {
        code: redemptionCode,
        amountCents,
        note: "",
        requestId: crypto.randomUUID()
      },
      token: "valid-admin"
    });
    const results = await Promise.all([redeem(7_000), redeem(7_000)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const balance = await workerEnv.DB.prepare(
      "SELECT balance_cents FROM gift_certificates"
    ).first<{ balance_cents: number }>();
    expect(balance?.balance_cents).toBe(3_000);
  });

  it("generates a clearly void PDF within the 10 ms target", async () => {
    const start = performance.now();
    const pdf = await createCertificatePdf({
      orderRef: "MHT-TEST-1234ABCD1234ABCD",
      redemptionCode: `MHTTEST${"A".repeat(32)}`,
      recipientName: "Test Recipient",
      message: "A sample certificate for worker CPU testing.",
      amountCents: 15_000,
      issuedAt: new Date().toISOString()
    });
    const elapsed = performance.now() - start;
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(elapsed).toBeLessThan(10);
  });
});
