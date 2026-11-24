import { verifyFirebaseAdminToken } from "../auth.js";
import {
  decryptSecret,
  encryptSecret,
  equalHex,
  randomBase64Url,
  randomHex,
  sha256Hex,
  validateAccessToken
} from "../crypto.js";
import {
  escapeHtml,
  parseEmailAllowlist,
  parseNewOrder,
  validateRequestId
} from "../validation.js";
import { enforceDailyOrderLimit, enforceIpRateLimit, ProductionHttpError, verifyProductionTurnstile } from "./abuse.js";
import { createProductionCertificatePdf } from "./certificate.js";
import { sendOrderEmails, sendProductionEmail } from "./email.js";
import type { ProductionCertificate, ProductionDependencies, ProductionEnv, ProductionOrder } from "./types.js";

const PRODUCTION_PROJECT_ID = "mht-giftcards-production";
const PRODUCTION_SITE_ORIGIN = "https://mitchharschtattoo.com";
const PRODUCTION_SITE_URL = "https://mitchharschtattoo.com/";
const PRODUCTION_HOSTNAME = "mitchharschtattoo.com";
const MAX_BODY_BYTES = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

import { getSales } from "./sales.js";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidKey(value: string): boolean {
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

function isProductionConfigurationValid(env: ProductionEnv): boolean {
  const requiredStrings = [
    env.APP_ENV,
    env.FIREBASE_PROJECT_ID,
    env.PUBLIC_SITE_ORIGIN,
    env.PUBLIC_SITE_URL,
    env.TURNSTILE_EXPECTED_HOSTNAME,
    env.EMAIL_FROM,
    env.ORDERS_ENABLED,
    env.MAX_ORDERS_PER_DAY,
    env.MAX_ORDER_AMOUNT_CENTS,
    env.EMAIL_DAILY_LIMIT,
    env.PRODUCTION_ADMIN_EMAILS,
    env.PRODUCTION_INTERAC_EMAIL,
    env.RESEND_API_KEY,
    env.TURNSTILE_SECRET_KEY,
    env.CERTIFICATE_ENCRYPTION_KEY,
    env.RATE_LIMIT_HMAC_KEY
  ];
  if (!env.DB || requiredStrings.some((value) => typeof value !== "string")) {
    return false;
  }
  const maxOrders = Number(env.MAX_ORDERS_PER_DAY);
  const maxAmount = Number(env.MAX_ORDER_AMOUNT_CENTS);
  const emailLimit = Number(env.EMAIL_DAILY_LIMIT);
  const admins = [...parseEmailAllowlist(env.PRODUCTION_ADMIN_EMAILS)];
  return env.APP_ENV === "production" &&
    env.FIREBASE_PROJECT_ID === PRODUCTION_PROJECT_ID &&
    env.PUBLIC_SITE_ORIGIN === PRODUCTION_SITE_ORIGIN &&
    env.PUBLIC_SITE_URL === PRODUCTION_SITE_URL &&
    env.TURNSTILE_EXPECTED_HOSTNAME === PRODUCTION_HOSTNAME &&
    (env.ORDERS_ENABLED === "true" || env.ORDERS_ENABLED === "false") &&
    Number.isSafeInteger(maxOrders) && maxOrders >= 1 && maxOrders <= 20 &&
    Number.isSafeInteger(maxAmount) &&
      ((env.ORDERS_ENABLED === "false" && maxAmount >= 0) ||
       (env.ORDERS_ENABLED === "true" && maxAmount >= 1)) &&
    Number.isSafeInteger(emailLimit) && emailLimit >= 1 && emailLimit <= 80 &&
    admins.length > 0 && admins.every(isValidEmail) &&
    isValidEmail(env.PRODUCTION_INTERAC_EMAIL) &&
    env.EMAIL_FROM.startsWith("Mitch Harsch Tattoo <") &&
    env.EMAIL_FROM.endsWith(">") &&
    Boolean(env.RESEND_API_KEY) &&
    Boolean(env.TURNSTILE_SECRET_KEY) &&
    isValidKey(env.CERTIFICATE_ENCRYPTION_KEY) &&
    isValidKey(env.RATE_LIMIT_HMAC_KEY);
}

function response(
  body: unknown,
  status: number,
  origin: string | null,
  allowedOrigin: string
): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (origin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
    headers.set("Vary", "Origin");
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function pdfResponse(
  pdf: Uint8Array,
  filename: string,
  origin: string | null,
  allowedOrigin: string
): Response {
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow"
  });
  if (origin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Vary", "Origin");
  }
  const body = new ArrayBuffer(pdf.length);
  new Uint8Array(body).set(pdf);
  return new Response(body, { headers });
}

function fail(status: number, message: string, code: string): never {
  throw new ProductionHttpError(status, message, code);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) fail(413, "Request is too large.", "payload-too-large");
  const text = await request.text();
  if (encoder.encode(text).length > MAX_BODY_BYTES) fail(413, "Request is too large.", "payload-too-large");
  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    fail(400, "A valid JSON request body is required.", "invalid-argument");
  }
}

function errorResponse(error: unknown, origin: string | null): Response {
  if (error instanceof ProductionHttpError) {
    return response({ error: error.message, code: error.code }, error.status, origin, PRODUCTION_SITE_ORIGIN);
  }
  if (error instanceof TypeError) {
    console.error("Production gift card dependency unavailable.", { type: error.name });
    return response(
      { error: "A required service is temporarily unavailable. Please try again.", code: "unavailable" },
      503,
      origin,
      PRODUCTION_SITE_ORIGIN
    );
  }
  console.error("Production gift card request failed.", {
    type: error instanceof Error ? error.name : "unknown"
  });
  return response(
    { error: "The request could not be completed. Please try again.", code: "internal" },
    500,
    origin,
    PRODUCTION_SITE_ORIGIN
  );
}

function orderById(env: ProductionEnv, id: string): Promise<ProductionOrder | null> {
  return env.DB.prepare(`
    SELECT * FROM gift_card_orders
    WHERE id = ? AND environment = 'production' AND test_only = 0
  `).bind(id).first<ProductionOrder>();
}

function parseAccessToken(request: Request): string {
  const match = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/);
  if (!match) fail(401, "The order access token is missing.", "unauthenticated");
  try {
    return validateAccessToken(match[1]);
  } catch {
    fail(401, "The order access token is invalid.", "unauthenticated");
  }
}

async function requireAdmin(
  request: Request,
  env: ProductionEnv,
  dependencies: ProductionDependencies
): Promise<{ uid: string }> {
  const match = request.headers.get("Authorization")?.match(/^Bearer ([^\s]+)$/);
  if (!match) fail(401, "Sign in as a gift card administrator.", "unauthenticated");
  let identity;
  try {
    identity = dependencies.verifyAdminToken
      ? await dependencies.verifyAdminToken(match[1], env.FIREBASE_PROJECT_ID)
      : await verifyFirebaseAdminToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch (error) {
    if (error instanceof TypeError) {
      fail(503, "Administrator authentication is temporarily unavailable.", "unavailable");
    }
    fail(401, "The administrator session is invalid. Sign in again.", "unauthenticated");
  }
  const allowedAdmins = parseEmailAllowlist(env.PRODUCTION_ADMIN_EMAILS);
  if (!identity.admin || !identity.email || !allowedAdmins.has(identity.email.toLowerCase())) {
    fail(403, "This account is not authorized to manage gift cards.", "permission-denied");
  }
  return { uid: identity.uid };
}

async function sendPaymentReportedEmail(
  order: ProductionOrder,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<boolean> {
  return sendProductionEmail(env, {
    orderId: order.id,
    emailType: "payment_reported",
    idempotencyKey: `production-payment-reported-${order.id}`,
    to: [...parseEmailAllowlist(env.PRODUCTION_ADMIN_EMAILS)],
    subject: `Customer reports payment sent for ${order.order_ref}`,
    html: `<p>The purchaser reported sending an Interac e-Transfer for order <strong>${escapeHtml(order.order_ref)}</strong>.</p>
      <p>This report is not payment confirmation. Check the bank account before confirming receipt.</p>`
  }, fetcher);
}

async function createOrder(
  request: Request,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<Response> {
  if (env.ORDERS_ENABLED !== "true") {
    fail(503, "Online gift card ordering is not enabled yet.", "orders-disabled");
  }
  await enforceIpRateLimit(request, env, "orders", 2, 20);
  const body = await readJson(request);
  let orderInput;
  let accessToken: string;
  let idempotencyKey: string;
  try {
    orderInput = parseNewOrder(body);
    accessToken = validateAccessToken(body.accessToken);
    idempotencyKey = validateRequestId(body.idempotencyKey);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "Order details are invalid.", "invalid-argument");
  }
  const maxAmount = Number(env.MAX_ORDER_AMOUNT_CENTS);
  if (orderInput.amountCents > maxAmount) {
    fail(400, "The order amount exceeds the configured maximum.", "amount-too-large");
  }
  await verifyProductionTurnstile(body.turnstileToken, env, fetcher);

  const [idempotencyHash, accessTokenHash] = await Promise.all([
    sha256Hex(idempotencyKey),
    sha256Hex(accessToken)
  ]);
  let order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE idempotency_hash = ? AND environment = 'production'
  `).bind(idempotencyHash).first<ProductionOrder>();
  const reusedRequest = Boolean(order);
  if (order) {
    if (!equalHex(order.access_token_hash, accessTokenHash)) {
      fail(409, "This order request cannot be reused.", "already-exists");
    }
  } else {
    await enforceDailyOrderLimit(env);
    const id = crypto.randomUUID();
    const orderRef = `MHT-PROD-${randomHex(8).toUpperCase()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO gift_card_orders
        (id, order_ref, idempotency_hash, access_token_hash, purchaser_name, purchaser_email,
         recipient_name, recipient_email, recipient_type, message, amount_cents, payment_method,
         payment_status, certificate_status, remaining_balance_cents, environment, test_only,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'interac_transfer',
              'pending_payment', 'not_issued', NULL, 'production', 0, ?, ?)
    `).bind(
      id,
      orderRef,
      idempotencyHash,
      accessTokenHash,
      orderInput.purchaserName,
      orderInput.purchaserEmail,
      orderInput.recipientName,
      orderInput.recipientEmail,
      orderInput.recipientType,
      orderInput.message,
      orderInput.amountCents,
      now,
      now
    ).run();
    order = await env.DB.prepare(`
      SELECT * FROM gift_card_orders
      WHERE idempotency_hash = ? AND environment = 'production'
    `).bind(idempotencyHash).first<ProductionOrder>();
    if (!order) fail(500, "The order could not be saved.", "internal");
  }

  const emails = await sendOrderEmails(order, env, fetcher);
  return jsonResponse({
    orderRef: order.order_ref,
    accessToken,
    amountCents: order.amount_cents,
    purchaserEmail: order.purchaser_email,
    interacEmail: env.PRODUCTION_INTERAC_EMAIL,
    emailSent: emails.confirmationEmailSent,
    adminEmailSent: emails.adminEmailSent,
    testOnly: false,
    reusedRequest,
    paymentStatus: order.payment_status
  });
}

async function reportPayment(
  request: Request,
  orderRef: string,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<Response> {
  const accessTokenHash = await sha256Hex(parseAccessToken(request));
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders
    WHERE order_ref = ? AND access_token_hash = ?
      AND environment = 'production' AND test_only = 0
  `).bind(orderRef, accessTokenHash).first<ProductionOrder>();
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status === "paid") {
    return jsonResponse({ alreadyReported: true, paymentStatus: "paid" });
  }
  const now = new Date().toISOString();
  const update = await env.DB.prepare(`
    UPDATE gift_card_orders
    SET payment_status = 'payment_reported', payment_reported_at = ?, updated_at = ?,
        archived_at = NULL, archived_by = NULL
    WHERE id = ? AND payment_status = 'pending_payment'
      AND environment = 'production' AND test_only = 0
  `).bind(now, now, order.id).run();
  const updated = await orderById(env, order.id);
  if (!updated) fail(404, "Gift card order was not found.", "not-found");
  if (updated.payment_status !== "payment_reported" && updated.payment_status !== "paid") {
    fail(412, "The order cannot accept a payment report.", "failed-precondition");
  }
  if (updated.payment_status === "payment_reported") {
    await sendPaymentReportedEmail(updated, env, fetcher);
  }
  return jsonResponse({
    alreadyReported: (update.meta?.changes ?? 0) === 0,
    paymentStatus: updated.payment_status,
    certificateIssued: false
  });
}

async function getCertificateCode(
  certificate: ProductionCertificate,
  env: ProductionEnv
): Promise<string> {
  if (certificate.encryption_key_version !== 1) {
    fail(500, "The certificate encryption version is unsupported.", "internal");
  }
  return decryptSecret({
    ciphertext: certificate.encrypted_code,
    iv: certificate.code_iv,
    authTag: certificate.code_auth_tag
  }, env.CERTIFICATE_ENCRYPTION_KEY);
}

async function deliverCertificate(
  order: ProductionOrder,
  certificate: ProductionCertificate,
  env: ProductionEnv,
  idempotencyKey: string,
  fetcher: typeof fetch
): Promise<boolean> {
  const redemptionCode = await getCertificateCode(certificate, env);
  const pdf = await createProductionCertificatePdf({
    orderRef: order.order_ref,
    redemptionCode,
    recipientName: certificate.recipient_name,
    message: order.message,
    amountCents: certificate.initial_value_cents,
    issuedAt: certificate.created_at
  });
  return sendProductionEmail(env, {
    orderId: order.id,
    emailType: "certificate_delivery",
    idempotencyKey,
    to: [certificate.recipient_email],
    subject: `Your Mitch Harsch Tattoo gift certificate ${order.order_ref}`,
    html: `<p>Your paid gift certificate is attached. Keep the redemption code private.</p>
      <p>Order reference: <strong>${escapeHtml(order.order_ref)}</strong></p>`,
    attachment: { filename: `${order.order_ref}.pdf`, content: pdf }
  }, fetcher);
}

async function issueCertificate(
  orderId: string,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<{ emailSent: boolean; alreadyIssued: boolean }> {
  const order = await orderById(env, orderId);
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status !== "paid" ||
      !order.payment_verified_at ||
      !order.payment_verified_by ||
      order.test_only !== 0 ||
      order.environment !== "production") {
    fail(412, "An administrator must confirm payment receipt before certificate issuance.", "failed-precondition");
  }

  const before = await env.DB.prepare(`
    SELECT order_id FROM gift_certificates WHERE order_id = ? AND environment = 'production' AND test_only = 0
  `).bind(order.id).first<{ order_id: string }>();
  let certificate = await env.DB.prepare(`
    SELECT * FROM gift_certificates WHERE order_id = ?
  `).bind(order.id).first<ProductionCertificate>();
  let inserted = false;
  if (!certificate) {
    const redemptionCode = `MHTPROD${randomHex(16).toUpperCase()}`;
    const codeHash = await sha256Hex(redemptionCode);
    const encrypted = await encryptSecret(redemptionCode, env.CERTIFICATE_ENCRYPTION_KEY);
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO gift_certificates
          (code_hash, order_id, encrypted_code, code_iv, code_auth_tag, encryption_key_version,
           recipient_name, recipient_email, initial_value_cents, balance_cents, status,
           environment, test_only, created_at, updated_at)
        SELECT ?, o.id, ?, ?, ?, 1, o.recipient_name, o.recipient_email, o.amount_cents,
               o.amount_cents, 'issued', 'production', 0, ?, ?
        FROM gift_card_orders o
        WHERE o.id = ? AND o.payment_status = 'paid'
          AND o.payment_verified_at IS NOT NULL AND o.payment_verified_by IS NOT NULL
          AND o.environment = 'production' AND o.test_only = 0
      `).bind(codeHash, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, now, order.id),
      env.DB.prepare(`
        UPDATE gift_card_orders
        SET certificate_status = 'issued', remaining_balance_cents = amount_cents, updated_at = ?
        WHERE id = ? AND payment_status = 'paid'
          AND certificate_status = 'not_issued' AND environment = 'production' AND test_only = 0
          AND EXISTS (SELECT 1 FROM gift_certificates WHERE order_id = ? AND environment = 'production' AND test_only = 0)
      `).bind(now, order.id, order.id)
    ]);
    inserted = (results[0]?.meta?.changes ?? 0) > 0;
    certificate = await env.DB.prepare(`
      SELECT * FROM gift_certificates WHERE order_id = ?
        AND environment = 'production' AND test_only = 0
    `).bind(order.id).first<ProductionCertificate>();
  }
  if (!certificate) fail(412, "The production certificate could not be issued.", "failed-precondition");
  const emailSent = await deliverCertificate(
    order,
    certificate,
    env,
    `production-certificate-delivery-${order.id}`,
    fetcher
  );
  return { emailSent, alreadyIssued: Boolean(before) || !inserted };
}

async function confirmPayment(
  orderId: string,
  identity: { uid: string },
  body: Record<string, unknown>,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<Response> {
  const note = typeof body.confirmationNote === "string" ? body.confirmationNote.trim() : "";
  if (note.length > 500) {
    fail(400, "The payment note must be 500 characters or fewer.", "invalid-argument");
  }
  const order = await orderById(env, orderId);
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_method !== "interac_transfer") {
    fail(412, "Only manual Interac payments can be confirmed.", "failed-precondition");
  }

  let alreadyConfirmed = order.payment_status === "paid";
  if (!alreadyConfirmed) {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`
      UPDATE gift_card_orders
      SET payment_status = 'paid', payment_verified_at = ?, payment_verified_by = ?,
          payment_confirmation_note = ?, updated_at = ?
      WHERE id = ? AND payment_status IN ('pending_payment', 'payment_reported')
        AND archived_at IS NULL
        AND environment = 'production' AND test_only = 0
    `).bind(now, identity.uid, note, now, order.id).run();
    alreadyConfirmed = (result.meta?.changes ?? 0) === 0;
  }
  const confirmedOrder = await orderById(env, order.id);
  if (!confirmedOrder ||
      confirmedOrder.payment_status !== "paid" ||
      !confirmedOrder.payment_verified_at ||
      !confirmedOrder.payment_verified_by) {
    fail(412, "Payment must be confirmed by an administrator before issuing a certificate.", "failed-precondition");
  }

  const paymentEmailSent = await sendProductionEmail(env, {
    orderId: order.id,
    emailType: "payment_confirmation",
    idempotencyKey: `production-payment-confirmation-${order.id}`,
    to: [order.purchaser_email],
    subject: `Payment confirmed for gift card order ${order.order_ref}`,
    html: `<p>Payment for order <strong>${escapeHtml(order.order_ref)}</strong> has been confirmed.</p>
      <p>Your gift certificate is attached in a separate email.</p>`
  }, fetcher);
  const issuance = await issueCertificate(order.id, env, fetcher);
  return jsonResponse({
    action: "Confirm Payment Received",
    alreadyConfirmed,
    paymentEmailSent,
    certificateEmailSent: issuance.emailSent,
    alreadyIssued: issuance.alreadyIssued
  });
}

async function downloadCertificate(
  request: Request,
  orderRef: string,
  env: ProductionEnv,
  origin: string | null
): Promise<Response> {
  await enforceIpRateLimit(request, env, "certificate-download", 5, 50);
  if (!/^MHT-PROD-[0-9A-F]{16}$/.test(orderRef)) {
    fail(404, "The gift card order was not found.", "not-found");
  }
  const accessTokenHash = await sha256Hex(parseAccessToken(request));
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders
    WHERE order_ref = ? AND access_token_hash = ?
      AND payment_status = 'paid' AND payment_verified_at IS NOT NULL
      AND environment = 'production' AND test_only = 0
  `).bind(orderRef, accessTokenHash).first<ProductionOrder>();
  if (!order) fail(404, "The gift card order was not found.", "not-found");
  const certificate = await env.DB.prepare(`
    SELECT * FROM gift_certificates
    WHERE order_id = ? AND environment = 'production' AND test_only = 0
  `).bind(order.id).first<ProductionCertificate>();
  if (!certificate) fail(412, "The certificate is not available until payment has been confirmed.", "failed-precondition");
  const redemptionCode = await getCertificateCode(certificate, env);
  const pdf = await createProductionCertificatePdf({
    orderRef: order.order_ref,
    redemptionCode,
    recipientName: certificate.recipient_name,
    message: order.message,
    amountCents: certificate.initial_value_cents,
    issuedAt: certificate.created_at
  });
  return pdfResponse(pdf, `${order.order_ref}.pdf`, origin, PRODUCTION_SITE_ORIGIN);
}

const orderStatusFilters = new Map([
  ["all", "1"],
  ["pending", "payment_status = 'pending_payment'"],
  ["reported", "payment_status = 'payment_reported'"],
  ["paid_unissued", "payment_status = 'paid' AND certificate_status = 'not_issued'"],
  ["issued", "certificate_status = 'issued'"],
  ["partial", "certificate_status = 'partially_redeemed'"],
  ["redeemed", "certificate_status = 'redeemed'"]
]);

async function listOrders(env: ProductionEnv, query: URLSearchParams): Promise<Response> {
  const archive = query.get("archive") ?? "active";
  const archiveFilter = {
    active: "AND (archived_at IS NOT NULL) = 0",
    archived: "AND (archived_at IS NOT NULL) = 1",
    all: ""
  };
  if (archive !== "active" && archive !== "archived" && archive !== "all") {
    fail(400, "Choose a valid archive filter.", "invalid-argument");
  }
  const statusFilter = orderStatusFilters.get(query.get("status") ?? "all");
  if (!statusFilter) fail(400, "Choose a valid order status.", "invalid-argument");

  const result = await env.DB.prepare(`
    SELECT * FROM gift_card_orders
    WHERE environment = 'production' AND test_only = 0
      ${archiveFilter[archive]} AND (${statusFilter})
    ORDER BY created_at DESC, id DESC LIMIT 100
  `).all<ProductionOrder>();
  return jsonResponse({ orders: result.results });
}

async function setOrderArchived(
  orderId: string,
  archived: boolean,
  identity: { uid: string },
  env: ProductionEnv
): Promise<Response> {
  const now = new Date().toISOString();
  const order = await env.DB.prepare(`
    UPDATE gift_card_orders
    SET archived_at = ?, archived_by = ?, updated_at = ?
    WHERE id = ? AND environment = 'production' AND test_only = 0
      AND ${archived ? `
        archived_at IS NULL AND payment_status = 'pending_payment'
        AND certificate_status = 'not_issued'
        AND NOT EXISTS (SELECT 1 FROM gift_certificates WHERE order_id = gift_card_orders.id)
      ` : "archived_at IS NOT NULL"}
    RETURNING archived_at
  `).bind(archived ? now : null, archived ? identity.uid : null, now, orderId)
    .first<{ archived_at: string | null }>();
  if (order) return jsonResponse({ archivedAt: order.archived_at });

  const existing = await orderById(env, orderId);
  if (!existing) fail(404, "Gift card order was not found.", "not-found");
  if (archived && !existing.archived_at) {
    fail(412, "Only orders awaiting payment with no certificate can be archived.", "failed-precondition");
  }
  return jsonResponse({ archivedAt: existing.archived_at });
}

async function retryOrderEmails(
  orderId: string,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<Response> {
  const order = await orderById(env, orderId);
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  return jsonResponse(await sendOrderEmails(order, env, fetcher));
}

async function resendCertificate(
  orderId: string,
  requestId: string,
  env: ProductionEnv,
  fetcher: typeof fetch
): Promise<Response> {
  const order = await orderById(env, orderId);
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status !== "paid" || !order.payment_verified_at) {
    fail(412, "An administrator must confirm payment before resending a certificate.", "failed-precondition");
  }
  const certificate = await env.DB.prepare(`
    SELECT * FROM gift_certificates WHERE order_id = ?
      AND environment = 'production' AND test_only = 0
  `).bind(order.id).first<ProductionCertificate>();
  if (!certificate) fail(412, "The certificate has not been issued.", "failed-precondition");
  const emailSent = await deliverCertificate(
    order,
    certificate,
    env,
    `production-certificate-resend-${order.id}-${requestId}`,
    fetcher
  );
  return jsonResponse({ emailSent, alreadyIssued: true });
}

export function normalizeProductionCode(value: unknown): string {
  if (typeof value !== "string") fail(400, "Enter a redemption code.", "invalid-argument");
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^MHTPROD[0-9A-F]{32}$/.test(normalized)) {
    fail(400, "That production redemption code is not valid.", "invalid-argument");
  }
  return normalized;
}

async function lookupCertificate(body: Record<string, unknown>, env: ProductionEnv): Promise<Response> {
  const codeHash = await sha256Hex(normalizeProductionCode(body.code));
  const certificate = await env.DB.prepare(`
    SELECT c.*, o.order_ref, o.amount_cents
    FROM gift_certificates c
    JOIN gift_card_orders o ON o.id = c.order_id
    WHERE c.code_hash = ? AND c.environment = 'production' AND c.test_only = 0
      AND o.payment_status = 'paid' AND o.payment_verified_at IS NOT NULL
      AND o.environment = 'production' AND o.test_only = 0
  `).bind(codeHash).first<ProductionCertificate & { order_ref: string; amount_cents: number }>();
  if (!certificate) fail(404, "No active production certificate was found.", "not-found");
  const redemptions = await env.DB.prepare(`
    SELECT amount_cents AS amountCents, balance_after_cents AS balanceAfterCents,
           note, redeemed_by AS redeemedBy, created_at AS createdAt
    FROM gift_card_redemptions
    WHERE code_hash = ? AND environment = 'production' AND test_only = 0 AND deduction_applied = 1
    ORDER BY created_at DESC LIMIT 100
  `).bind(codeHash).all();
  return jsonResponse({
    certificate: {
      orderRef: certificate.order_ref,
      recipientName: certificate.recipient_name,
      recipientEmail: certificate.recipient_email,
      amountCents: certificate.initial_value_cents,
      balanceCents: certificate.balance_cents,
      status: certificate.status,
      environment: "production"
    },
    redemptions: redemptions.results
  });
}

async function redeemCertificate(
  body: Record<string, unknown>,
  identity: { uid: string },
  env: ProductionEnv
): Promise<Response> {
  const code = normalizeProductionCode(body.code);
  let requestId: string;
  try {
    requestId = validateRequestId(body.requestId);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "A valid request ID is required.", "invalid-argument");
  }
  if (!Number.isSafeInteger(body.amountCents) || Number(body.amountCents) < 1) {
    fail(400, "Enter a valid redemption amount.", "invalid-argument");
  }
  if (typeof body.note !== "string" || body.note.length > 500) {
    fail(400, "The redemption note must be 500 characters or fewer.", "invalid-argument");
  }
  const amountCents = Number(body.amountCents);
  const note = body.note.trim();
  const codeHash = await sha256Hex(code);
  const prior = await env.DB.prepare(`
    SELECT code_hash, amount_cents, note, deduction_applied
    FROM gift_card_redemptions WHERE request_id = ? AND environment = 'production' AND test_only = 0
  `).bind(requestId).first<{
    code_hash: string;
    amount_cents: number;
    note: string;
    deduction_applied: number;
  }>();
  if (prior) {
    if (!equalHex(prior.code_hash, codeHash) || prior.amount_cents !== amountCents || prior.note !== note) {
      fail(409, "This redemption request ID was already used for different details.", "already-exists");
    }
    if (prior.deduction_applied !== 1) {
      fail(409, "This redemption request is still being processed. Retry shortly.", "aborted");
    }
    const balance = await env.DB.prepare(`
      SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
    `).bind(codeHash).first<{ balance_cents: number }>();
    return jsonResponse({ alreadyRedeemed: true, balanceCents: balance?.balance_cents ?? 0 });
  }

  const changes = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO gift_card_redemptions
        (request_id, code_hash, amount_cents, balance_after_cents, note, redeemed_by,
         deduction_applied, environment, test_only, created_at)
      SELECT ?, c.code_hash, ?, c.balance_cents - ?, ?, ?, 0, 'production', 0, ?
      FROM gift_certificates c
      JOIN gift_card_orders o ON o.id = c.order_id
      WHERE c.code_hash = ? AND c.environment = 'production' AND c.test_only = 0
        AND c.balance_cents >= ? AND o.payment_status = 'paid'
        AND o.payment_verified_at IS NOT NULL AND o.environment = 'production' AND o.test_only = 0
      ON CONFLICT(request_id) DO NOTHING
    `).bind(requestId, amountCents, amountCents, note, identity.uid, new Date().toISOString(), codeHash, amountCents),
    env.DB.prepare(`
      UPDATE gift_certificates
      SET balance_cents = balance_cents - ?,
          status = CASE WHEN balance_cents - ? = 0 THEN 'redeemed' ELSE 'partially_redeemed' END,
          updated_at = ?
      WHERE code_hash = ? AND environment = 'production' AND test_only = 0 AND balance_cents >= ?
        AND EXISTS (
          SELECT 1 FROM gift_card_redemptions
          WHERE request_id = ? AND code_hash = ? AND amount_cents = ? AND note = ?
            AND deduction_applied = 0 AND environment = 'production' AND test_only = 0
        )
    `).bind(amountCents, amountCents, new Date().toISOString(), codeHash, amountCents,
      requestId, codeHash, amountCents, note),
    env.DB.prepare(`
      UPDATE gift_card_orders
      SET remaining_balance_cents = (
            SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
          ),
          certificate_status = (
            SELECT status FROM gift_certificates WHERE code_hash = ?
          ),
          updated_at = ?
      WHERE id = (SELECT order_id FROM gift_certificates WHERE code_hash = ?)
        AND environment = 'production' AND test_only = 0
    `).bind(codeHash, codeHash, new Date().toISOString(), codeHash),
    env.DB.prepare(`
      UPDATE gift_card_redemptions
      SET deduction_applied = 1
      WHERE request_id = ? AND code_hash = ? AND deduction_applied = 0
        AND EXISTS (
          SELECT 1 FROM gift_certificates
          WHERE code_hash = ? AND balance_cents = (
            SELECT balance_after_cents FROM gift_card_redemptions WHERE request_id = ?
          )
        )
    `).bind(requestId, codeHash, codeHash, requestId)
  ]);

  const completed = await env.DB.prepare(`
    SELECT amount_cents, balance_after_cents, note, deduction_applied
    FROM gift_card_redemptions WHERE request_id = ? AND code_hash = ?
      AND environment = 'production' AND test_only = 0
  `).bind(requestId, codeHash).first<{
    amount_cents: number;
    balance_after_cents: number;
    note: string;
    deduction_applied: number;
  }>();
  if (completed && (completed.amount_cents !== amountCents || completed.note !== note)) {
    fail(409, "This redemption request ID was already used for different details.", "already-exists");
  }
  if (!completed || completed.deduction_applied !== 1) {
    fail(412, "The certificate is inactive or its balance is insufficient.", "failed-precondition");
  }
  if ((changes[0]?.meta?.changes ?? 0) === 0) {
    const balance = await env.DB.prepare(`
      SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
    `).bind(codeHash).first<{ balance_cents: number }>();
    return jsonResponse({ alreadyRedeemed: true, balanceCents: balance?.balance_cents ?? 0 });
  }
  return jsonResponse({
    alreadyRedeemed: false,
    amountCents: completed.amount_cents,
    balanceAfterCents: completed.balance_after_cents
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function handleProductionRequest(
  request: Request,
  env: ProductionEnv,
  dependencies: ProductionDependencies = {}
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.PUBLIC_SITE_ORIGIN) {
    return response({ error: "This origin is not allowed.", code: "origin-denied" }, 403, origin, env.PUBLIC_SITE_ORIGIN);
  }
  if (request.method === "OPTIONS") {
    return response({}, 204, origin, env.PUBLIC_SITE_ORIGIN);
  }
  if (!isProductionConfigurationValid(env)) {
    return response({ error: "Production Worker configuration is incomplete.", code: "unsafe-config" }, 503, origin, env.PUBLIC_SITE_ORIGIN);
  }

  const url = new URL(request.url);
  const fetcher = dependencies.fetcher ?? fetch;
  try {
    if (url.pathname === "/api/healthz" && request.method === "GET") {
      return response({
        ok: true,
        environment: "production",
        orderingEnabled: env.ORDERS_ENABLED === "true"
      }, 200, origin, env.PUBLIC_SITE_ORIGIN);
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      const result = await createOrder(request, env, fetcher);
      return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
    }
    const paymentReport = url.pathname.match(/^\/api\/orders\/([^/]+)\/report-payment$/);
    if (paymentReport && request.method === "POST") {
      const result = await reportPayment(request, paymentReport[1], env, fetcher);
      return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
    }
    const certificateDownload = url.pathname.match(/^\/api\/orders\/([^/]+)\/certificate\.pdf$/);
    if (certificateDownload && request.method === "GET") {
      return await downloadCertificate(request, certificateDownload[1], env, origin);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const identity = await requireAdmin(request, env, dependencies);
      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        const result = await listOrders(env, url.searchParams);
        return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
      }
      if (url.pathname === "/api/admin/sales" && request.method === "GET") {
        return response(await getSales(env), 200, origin, env.PUBLIC_SITE_ORIGIN);
      }
      if (request.method === "POST") {
        const archive = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(archive|restore)$/);
        if (archive) {
          const result = await setOrderArchived(archive[1], archive[2] === "archive", identity, env);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        const confirm = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/confirm-payment$/);
        if (confirm) {
          const result = await confirmPayment(
            confirm[1],
            identity,
            await readJson(request),
            env,
            fetcher
          );
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        const retryEmails = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/retry-order-emails$/);
        if (retryEmails) {
          const result = await retryOrderEmails(retryEmails[1], env, fetcher);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        const resend = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/resend$/);
        if (resend) {
          const body = await readJson(request);
          let requestId: string;
          try {
            requestId = validateRequestId(body.requestId);
          } catch (error) {
            fail(400, error instanceof Error ? error.message : "A valid request ID is required.", "invalid-argument");
          }
          const result = await resendCertificate(resend[1], requestId, env, fetcher);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        if (url.pathname === "/api/admin/certificates/lookup") {
          const result = await lookupCertificate(await readJson(request), env);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        if (url.pathname === "/api/admin/certificates/redeem") {
          const result = await redeemCertificate(await readJson(request), identity, env);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
      }
    }
    return response({ error: "Endpoint not found.", code: "not-found" }, 404, origin, env.PUBLIC_SITE_ORIGIN);
  } catch (error) {
    return errorResponse(error, origin);
  }
}

export default {
  fetch(request: Request, env: ProductionEnv): Promise<Response> {
    return handleProductionRequest(request, env);
  }
};
