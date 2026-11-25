import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, randomBase64Url } from "../src/crypto.js";
import { handleProductionRequest, normalizeProductionCode, promotionActive } from "../src/production/index.js";
import { getSales } from "../src/production/sales.js";
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
  it("pages filtered orders five at a time with a count across all matching rows", async () => {
    await createOrder();
    const [{ id }] = (await listOrders()).orders;
    await workerEnv.DB.prepare(`
      WITH RECURSIVE items(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM items WHERE n < 12)
      INSERT INTO gift_card_orders (
        id, order_ref, idempotency_hash, access_token_hash, purchaser_name, purchaser_email,
        recipient_name, recipient_email, recipient_type, amount_cents, payment_method,
        payment_status, certificate_status, environment, created_at, updated_at, archived_at
      )
      SELECT 'page-' || n, 'page-ref-' || n, 'page-idempotency-' || n, access_token_hash,
        purchaser_name, purchaser_email, recipient_name, recipient_email, recipient_type,
        amount_cents, payment_method, 'pending_payment', 'not_issued', 'production', created_at,
        updated_at, CASE WHEN n = 12 THEN updated_at END
      FROM items CROSS JOIN gift_card_orders WHERE gift_card_orders.id = ?
    `).bind(id).run();

    const load = async (page: number) => {
      const response = await callApi(`/api/admin/orders?archive=active&status=pending&page=${page}`, {
        token: "valid-admin"
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ page: number; pageSize: number; total: number; orders: { id: string }[] }>;
    };
    const pages = await Promise.all([load(1), load(2), load(3)]);
    expect(pages.map((page) => page.orders.length)).toEqual([5, 5, 2]);
    expect(pages.every((page) => page.pageSize === 5 && page.total === 12)).toBe(true);
    const ids = pages.flatMap((page) => page.orders.map((order) => order.id));
    expect(new Set(ids).size).toBe(12);
    expect(ids).not.toContain("page-12");
    expect((await callApi("/api/admin/orders?page=0", { token: "valid-admin" })).status).toBe(400);
  });

  it("permanently deletes a paid test order, its certificate, and its redemption history", async () => {
    const { orderId, code } = await confirmedCertificateCode();
    const redemption = await callApi("/api/admin/certificates/redeem", {
      token: "valid-admin",
      body: { code, amountCents: 3_000, note: "test redemption", requestId: crypto.randomUUID() }
    });
    expect(redemption.status).toBe(200);
    const order = await workerEnv.DB.prepare(`
      SELECT order_ref, updated_at FROM gift_card_orders WHERE id = ?
    `).bind(orderId).first<{ order_ref: string; updated_at: string }>();
    if (!order) throw new Error("Expected a test order.");
    const remove = (body: Record<string, unknown>, token = "valid-admin") =>
      callApi(`/api/admin/orders/${orderId}/delete`, { token, body });
    const body = { orderRef: order.order_ref, updatedAt: order.updated_at };
    expect((await remove(body, "valid-customer")).status).toBe(403);
    expect((await remove({ ...body, orderRef: "different-order" })).status).toBe(400);
    expect((await remove({ ...body, updatedAt: "stale" })).status).toBe(412);
    expect((await remove(body)).status).toBe(200);
    expect((await listOrders()).orders).toEqual([]);
    for (const table of ["gift_certificates", "gift_card_redemptions", "gift_card_email_deliveries"]) {
      expect(await workerEnv.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
    }
    expect(await getSales(workerEnv)).toMatchObject({
      confirmedRevenueCents: 0, outstandingBalanceCents: 0, totalRedeemedCents: 0
    });
  });
  it("archives pending orders with admin authorization, filters them and restores them", async () => {
    const { data } = await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const change = (action: string, token = "valid-admin") =>
      callApi(`/api/admin/orders/${id}/${action}`, { method: "POST", token });
    const filter = async (query: string) => {
      const response = await callApi(`/api/admin/orders?${query}`, { token: "valid-admin" });
      expect(response.status).toBe(200);
      return (await response.json() as { orders: unknown[] }).orders;
    };

    expect((await change("archive", "valid-customer")).status).toBe(403);
    const archived = await change("archive");
    expect(archived.status).toBe(200);
    const archivePayload = await archived.json();
    expect(archivePayload).toMatchObject({ archivedAt: expect.any(String) });
    expect(await (await change("archive")).json()).toEqual(archivePayload);
    expect((await listOrders()).orders).toEqual([]);
    expect(await filter("archive=archived&status=pending")).toMatchObject([
      { id, archived_by: "production-admin-1" }
    ]);
    expect(await filter("archive=all")).toHaveLength(1);
    expect(await filter("archive=archived&status=issued")).toEqual([]);
    expect((await confirmOrder(id)).status).toBe(412);
    expect(await (await change("restore")).json()).toEqual({ archivedAt: null });
    expect(await (await change("restore")).json()).toEqual({ archivedAt: null });
    expect((await listOrders()).orders).toMatchObject([{ id, archived_by: null }]);

    expect((await change("archive")).status).toBe(200);
    expect((await callApi(`/api/orders/${data.orderRef}/report-payment`, {
      method: "POST", accessToken: data.accessToken, body: {}
    })).status).toBe(200);
    expect(await filter("status=reported")).toMatchObject([{ id, archived_at: null }]);
    expect((await change("archive")).status).toBe(412);
    expect((await confirmOrder(id)).status).toBe(200);
    expect((await change("archive")).status).toBe(412);
  });

  it("aggregates confirmed sales beyond the list cap and counts only applied redemptions", async () => {
    const { orderId, code } = await confirmedCertificateCode();
    expect((await callApi("/api/admin/sales", { token: "valid-customer" })).status).toBe(403);
    const redeem = await callApi("/api/admin/certificates/redeem", {
      token: "valid-admin",
      body: { code, amountCents: 3_000, note: "partial use", requestId: crypto.randomUUID() }
    });
    expect(redeem.status).toBe(200);
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(`
        INSERT INTO gift_card_redemptions
          (request_id, code_hash, amount_cents, balance_after_cents, redeemed_by,
           deduction_applied, environment, test_only, created_at)
        SELECT 'unapplied', code_hash, 1000, 6000, redeemed_by, 0, environment, test_only, created_at
        FROM gift_card_redemptions
      `),
      workerEnv.DB.prepare(`
        UPDATE gift_card_orders
        SET created_at = '2025-04-30T00:00:00.000Z', payment_verified_at = '2025-05-01T06:59:59.999Z'
        WHERE id = ?
      `).bind(orderId),
      workerEnv.DB.prepare(`
        WITH RECURSIVE numbers(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 102)
        INSERT INTO gift_card_orders (
          id, order_ref, idempotency_hash, access_token_hash, purchaser_name, purchaser_email,
          recipient_name, recipient_email, recipient_type, amount_cents, payment_method,
          payment_status, certificate_status, environment, created_at, updated_at, archived_at
        )
        SELECT 'fixture-' || n, 'ref-' || n, 'idem-' || n, access_token_hash, purchaser_name,
          purchaser_email, recipient_name, recipient_email, recipient_type, 9900, payment_method,
          CASE WHEN n = 1 THEN 'payment_reported' ELSE 'pending_payment' END,
          'not_issued', 'production', '2025-05-02T00:00:00.000Z',
          '2025-05-02T00:00:00.000Z', CASE WHEN n = 2 THEN '2025-05-02T00:00:00.000Z' END
        FROM numbers CROSS JOIN gift_card_orders WHERE gift_card_orders.id = ?
      `).bind(orderId),
      workerEnv.DB.prepare(`
        UPDATE gift_card_orders SET payment_status = 'paid',
          payment_verified_at = '2025-05-01T07:00:00.000Z', payment_verified_by = 'admin'
        WHERE id = 'fixture-3'
      `),
      workerEnv.DB.prepare(`
        UPDATE gift_card_orders SET payment_status = 'paid', amount_cents = 5000,
          created_at = '2023-05-01T00:00:00.000Z',
          payment_verified_at = '2023-05-02T00:00:00.000Z', payment_verified_by = 'admin'
        WHERE id = 'fixture-4'
      `)
    ]);

    const { orders } = await listOrders();
    expect(orders).toHaveLength(100);
    expect(orders.some(({ id }) => id === orderId)).toBe(false);
    const issued = await callApi("/api/admin/orders?status=partial", { token: "valid-admin" });
    expect(await issued.json()).toMatchObject({ orders: [{ id: orderId }] });
    const report = await callApi("/api/admin/sales", { token: "valid-admin" });
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      confirmedRevenueCents: 24_900, outstandingBalanceCents: 7_000, totalRedeemedCents: 3_000
    });
    const sales = await getSales(workerEnv, new Date("2025-05-01T07:00:00.000Z"));
    expect(sales.confirmedRevenueCents).toBe(24_900);
    expect(sales.thisMonthRevenueCents).toBe(9_900);
    expect(sales.monthlyRevenue).toHaveLength(12);
    expect(sales.monthlyRevenue.slice(-3)).toEqual([
      { month: "2025-03", revenueCents: 0 },
      { month: "2025-04", revenueCents: 10_000 },
      { month: "2025-05", revenueCents: 9_900 }
    ]);
    expect((await getSales(workerEnv, new Date("2025-05-01T06:59:59.999Z")))
      .thisMonthRevenueCents).toBe(10_000);
  });

  it("keeps archiving and payment confirmation mutually exclusive for the same pending order", async () => {
    await createOrder();
    const [{ id }] = (await listOrders()).orders;
    const [archive, payment] = await Promise.all([
      callApi(`/api/admin/orders/${id}/archive`, { method: "POST", token: "valid-admin" }),
      confirmOrder(id)
    ]);
    expect([archive.status, payment.status].sort()).toEqual([200, 412]);
    const order = await workerEnv.DB.prepare(`
      SELECT payment_status, certificate_status, archived_at FROM gift_card_orders WHERE id = ?
    `).bind(id).first();
    expect(order).toEqual(archive.ok
      ? { payment_status: "pending_payment", certificate_status: "not_issued", archived_at: expect.any(String) }
      : { payment_status: "paid", certificate_status: "issued", archived_at: null });
  });
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


describe("holiday promotion", () => {
  it("ends at Vancouver midnight and can be disabled", () => {
    const enabled = { ...workerEnv, HOLIDAY_PROMOTION_ENABLED: "true" };
    expect(promotionActive(enabled, Date.parse("2026-12-26T07:59:59.999Z"))).toBe(true);
    expect(promotionActive(enabled, Date.parse("2026-12-26T08:00:00Z"))).toBe(false);
    expect(promotionActive({ ...enabled, HOLIDAY_PROMOTION_ENABLED: "false" }, Date.parse("2026-12-25T20:00:00Z"))).toBe(false);
  });
  it("calculates complete $100 increments and rejects purchases over $1,000", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-25T20:00:00Z"));
    try {
      const env = { ...workerEnv, HOLIDAY_PROMOTION_ENABLED: "true" };
      for (const [amountCents, bonusCents] of [[9999, 0], [10000, 2500], [19999, 2500], [20000, 5000]]) {
        const response = await callApi("/api/orders", { body: orderBody({ amountCents }), env });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ amountCents, bonusCents, totalValueCents: amountCents + bonusCents });
      }
      expect((await callApi("/api/orders", { body: orderBody({ amountCents: 100001 }), env })).status).toBe(400);
    } finally { clock.mockRestore(); }
  });
  it("awards and redeems bonus while reporting the purchase as revenue", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-25T20:00:00Z"));
    try {
      const env = { ...workerEnv, HOLIDAY_PROMOTION_ENABLED: "true" };
      const body = orderBody({ amountCents: 100000 });
      const response = await callApi("/api/orders", { body, env });
      expect(response.status).toBe(200);
      const result = await response.json() as { orderRef: string; bonusCents: number; totalValueCents: number; amountCents: number };
      expect(result).toMatchObject({ amountCents: 100000, bonusCents: 25000, totalValueCents: 125000 });
      expect(sentEmails.some(({ body }) => String(body.html).includes("$1250.00"))).toBe(true);
      const [{ id }] = (await listOrders()).orders;
      expect((await confirmOrder(id)).status).toBe(200);
      const cert = await workerEnv.DB.prepare("SELECT * FROM gift_certificates WHERE order_id = ?").bind(id).first<{ initial_value_cents: number; balance_cents: number; encrypted_code: string; code_iv: string; code_auth_tag: string }>();
      expect(cert).toMatchObject({ initial_value_cents: 125000, balance_cents: 125000 });
      const code = await decryptSecret({ ciphertext: cert!.encrypted_code, iv: cert!.code_iv, authTag: cert!.code_auth_tag }, workerEnv.CERTIFICATE_ENCRYPTION_KEY);
      const redemption = await callApi("/api/admin/certificates/redeem", { token: "valid-admin", body: { code, amountCents: 125000, requestId: crypto.randomUUID(), note: "" } });
      expect(redemption.status).toBe(200);
      expect(await getSales(workerEnv)).toMatchObject({ confirmedRevenueCents: 100000, promotionalCreditCents: 25000, outstandingBalanceCents: 0, totalRedeemedCents: 125000 });
      expect((await callApi(`/api/orders/${result.orderRef}/certificate.pdf`, { accessToken: String(body.accessToken) })).status).toBe(200);
    } finally { clock.mockRestore(); }
  });
});
