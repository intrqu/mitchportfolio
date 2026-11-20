import { errors as joseErrors } from "jose";
import { verifyFirebaseAdminToken } from "./auth.js";
import {
  allowlistedRecipients,
  enforceCertificateDownloadRateLimit,
  enforceGlobalDailyOrderLimit,
  enforceNewOrderIpLimit,
  enforceOrderRateLimit,
  HttpError,
  verifyTurnstile
} from "./abuse.js";
import { createCertificatePdf } from "./certificate.js";
import {
  decryptSecret,
  encryptSecret,
  equalHex,
  randomHex,
  sha256Hex,
  validateAccessToken
} from "./crypto.js";
import { sendEmail } from "./email.js";
import {
  escapeHtml,
  normalizeRedemptionCode,
  parseEmailAllowlist,
  parseNewOrder,
  validateRequestId
} from "./validation.js";
import type { AdminIdentity, Env, GiftCardOrder, NewOrder } from "./types.js";

const STAGING_PROJECT_ID = "mht-giftcards-staging";
const STAGING_SITE_ORIGIN = "https://intrqu.github.io";
const STAGING_SITE_URL = "https://intrqu.github.io/mitchportfolio-staging/";
const STAGING_HOSTNAME = "intrqu.github.io";
const MAX_BODY_BYTES = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface WorkerDependencies {
  verifyAdminToken?: (token: string, projectId: string) => Promise<AdminIdentity>;
}

interface OrderRow extends Record<string, unknown> {
  id: string;
  order_ref: string;
  idempotency_hash: string;
  access_token_hash: string;
  purchaser_name: string;
  purchaser_email: string;
  recipient_name: string;
  recipient_email: string;
  recipient_type: "self" | "other";
  message: string;
  amount_cents: number;
  payment_status: "pending_payment" | "paid";
  certificate_status: "not_issued" | "issued" | "partially_redeemed" | "redeemed";
  remaining_balance_cents: number | null;
  test_only: number;
  test_payment_simulated: number;
  payment_verified_at: string | null;
  payment_verified_by: string | null;
  order_email_sent_at: string | null;
  admin_email_sent_at: string | null;
  payment_email_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CertificateRow extends Record<string, unknown> {
  code_hash: string;
  order_id: string;
  encrypted_code: string;
  code_iv: string;
  code_auth_tag: string;
  recipient_name: string;
  recipient_email: string;
  initial_value_cents: number;
  balance_cents: number;
  status: "issued" | "partially_redeemed" | "redeemed";
  test_only: number;
  created_at: string;
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
  throw new HttpError(status, message, code);
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

function errorResponse(
  error: unknown,
  origin: string | null,
  allowedOrigin: string
): Response {
  if (error instanceof HttpError) {
    return response({ error: error.message, code: error.code }, error.status, origin, allowedOrigin);
  }
  console.error("Gift card Worker request failed.", error);
  return response(
    { error: "The request could not be completed. Please try again.", code: "internal" },
    500,
    origin,
    allowedOrigin
  );
}

function asGiftCardOrder(row: OrderRow): GiftCardOrder {
  return {
    id: row.id,
    orderRef: row.order_ref,
    amountCents: row.amount_cents,
    purchaserName: row.purchaser_name,
    purchaserEmail: row.purchaser_email,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    recipientType: row.recipient_type,
    message: row.message,
    paymentStatus: row.payment_status,
    certificateStatus: row.certificate_status,
    remainingBalanceCents: row.remaining_balance_cents,
    testOnly: true,
    paymentVerifiedAt: row.payment_verified_at,
    paymentVerifiedBy: row.payment_verified_by,
    orderEmailSentAt: row.order_email_sent_at,
    adminEmailSentAt: row.admin_email_sent_at,
    paymentEmailSentAt: row.payment_email_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function requireAdmin(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies
): Promise<AdminIdentity> {
  const authorization = request.headers.get("Authorization");
  const tokenMatch = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!tokenMatch) fail(401, "Sign in to continue.", "unauthenticated");
  let identity: AdminIdentity;
  try {
    identity = await (dependencies.verifyAdminToken ?? verifyFirebaseAdminToken)(
      tokenMatch[1],
      env.FIREBASE_PROJECT_ID
    );
  } catch (verificationError) {
    if (verificationError instanceof joseErrors.JWKSTimeout ||
        verificationError instanceof TypeError ||
        (verificationError instanceof joseErrors.JOSEError &&
         verificationError.code === "ERR_JOSE_GENERIC")) {
      fail(503, "Firebase sign-in verification is temporarily unavailable.", "auth-provider-unavailable");
    }
    fail(401, "Your sign-in has expired. Sign in again.", "unauthenticated");
  }
  if (!identity.admin) fail(403, "This account is not authorized to manage gift cards.", "permission-denied");
  const allowedAdmins = parseEmailAllowlist(env.STAGING_ADMIN_EMAILS);
  if (!identity.email || !allowedAdmins.has(identity.email.toLowerCase())) {
    fail(403, "This account is not authorized to manage gift cards.", "permission-denied");
  }
  return identity;
}

async function sendOrderEmails(order: OrderRow, env: Env): Promise<{
  confirmationEmailSent: boolean;
  adminEmailSent: boolean;
}> {
  const orderRef = escapeHtml(order.order_ref);
  const purchaser = escapeHtml(order.purchaser_name);
  const amount = (order.amount_cents / 100).toFixed(2);
  const interacEmail = escapeHtml(env.STAGING_INTERAC_EMAIL);
  const confirmationEmailSent = await sendEmail(env, {
    orderId: order.id,
    emailType: "order_confirmation",
    idempotencyKey: `staging-order-confirmation-${order.id}`,
    to: [order.purchaser_email],
    subject: `Gift card order ${order.order_ref}`,
    html: `<p>Your staging gift card test order was received.</p>
      <p>Order reference: <strong>${orderRef}</strong><br>Test value: <strong>$${amount} CAD</strong></p>
      <h2>Interac e-Transfer demo details (DO NOT USE)</h2>
      <p>Demo recipient: <strong>${interacEmail}</strong><br>
      Demo amount: <strong>$${amount} CAD</strong><br>
      Demo order reference: <strong>${orderRef}</strong></p>
      <p>For a real purchase, the order reference would be included in the transfer message. These are sample instructions only: do not send a transfer or any money. No payment is due or accepted, and this staging order cannot receive or reconcile funds.</p>
      <p>Any certificate generated for this staging order is void and has no value.</p>`
  });
  const adminEmailSent = await sendEmail(env, {
    orderId: order.id,
    emailType: "admin_new_order",
    idempotencyKey: `staging-admin-new-order-${order.id}`,
    to: [...parseEmailAllowlist(env.STAGING_ADMIN_EMAILS)],
    subject: `New test gift card order ${order.order_ref}`,
    html: `<p>A staging test gift card order was created.</p>
      <p>Reference: ${orderRef}<br>Value: $${amount} CAD<br>Purchaser: ${purchaser} (${escapeHtml(order.purchaser_email)})</p>`
  });
  return { confirmationEmailSent, adminEmailSent };
}

async function sendCertificate(
  order: OrderRow,
  env: Env,
  idempotencyKey: string
): Promise<{ emailSent: boolean; redemptionCode: string }> {
  const certificate = await env.DB.prepare(`
    SELECT code_hash, order_id, encrypted_code, code_iv, code_auth_tag, recipient_name,
           recipient_email, initial_value_cents, balance_cents, status, test_only, created_at
    FROM gift_certificates WHERE order_id = ?
  `).bind(order.id).first<CertificateRow>();
  if (!certificate || certificate.test_only !== 1 || order.payment_status !== "paid") {
    fail(412, "A verified staging payment is required before certificate delivery.", "failed-precondition");
  }
  const redemptionCode = await decryptSecret({
    ciphertext: certificate.encrypted_code,
    iv: certificate.code_iv,
    authTag: certificate.code_auth_tag
  }, env.CERTIFICATE_ENCRYPTION_KEY);
  const pdf = await createCertificatePdf({
    orderRef: order.order_ref,
    redemptionCode,
    recipientName: certificate.recipient_name,
    message: order.message,
    amountCents: certificate.initial_value_cents,
    issuedAt: certificate.created_at
  });
  const emailSent = await sendEmail(env, {
    orderId: order.id,
    emailType: "certificate_delivery",
    idempotencyKey,
    to: [certificate.recipient_email],
    subject: `Gift certificate ${order.order_ref}`,
    html: `<p><strong>VOID — TEST ONLY. This certificate has no value and cannot be redeemed.</strong></p>
      <p>A test certificate for ${escapeHtml(certificate.recipient_name)} is attached. It was generated only for the staging website.</p>`,
    attachment: { filename: `${order.order_ref}-VOID-TEST-ONLY.pdf`, content: pdf }
  });
  return { emailSent, redemptionCode };
}

async function downloadCertificate(
  request: Request,
  orderRef: string,
  env: Env,
  origin: string | null
): Promise<Response> {
  await enforceCertificateDownloadRateLimit(request, env);
  if (!/^MHT-TEST-[0-9A-F]{16}$/.test(orderRef)) {
    fail(404, "The staging order was not found.", "not-found");
  }
  const authorization = request.headers.get("Authorization");
  const tokenMatch = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!tokenMatch) fail(401, "The order download token is missing.", "unauthenticated");
  let token: string;
  try {
    token = validateAccessToken(tokenMatch[1]);
  } catch {
    fail(404, "The staging order was not found.", "not-found");
  }
  const accessTokenHash = await sha256Hex(token);
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders
    WHERE order_ref = ? AND access_token_hash = ? AND test_only = 1
  `).bind(orderRef, accessTokenHash).first<OrderRow>();
  if (!order) fail(404, "The staging order was not found.", "not-found");
  if (order.payment_status !== "paid" || order.test_payment_simulated !== 1) {
    fail(412, "The certificate is not available until an administrator simulates payment.", "failed-precondition");
  }
  const certificate = await env.DB.prepare(`
    SELECT encrypted_code, code_iv, code_auth_tag, recipient_name, initial_value_cents, created_at
    FROM gift_certificates WHERE order_id = ? AND test_only = 1
  `).bind(order.id).first<{
    encrypted_code: string;
    code_iv: string;
    code_auth_tag: string;
    recipient_name: string;
    initial_value_cents: number;
    created_at: string;
  }>();
  if (!certificate) fail(412, "The test certificate has not been issued yet.", "failed-precondition");
  const redemptionCode = await decryptSecret({
    ciphertext: certificate.encrypted_code,
    iv: certificate.code_iv,
    authTag: certificate.code_auth_tag
  }, env.CERTIFICATE_ENCRYPTION_KEY);
  const pdf = await createCertificatePdf({
    orderRef: order.order_ref,
    redemptionCode,
    recipientName: certificate.recipient_name,
    message: order.message,
    amountCents: certificate.initial_value_cents,
    issuedAt: certificate.created_at
  });
  return pdfResponse(pdf, `${order.order_ref}-VOID-TEST-ONLY.pdf`, origin, env.PUBLIC_SITE_ORIGIN);
}

async function issueCertificate(orderId: string, env: Env): Promise<{
  emailSent: boolean;
  alreadyIssued: boolean;
  redemptionCode: string;
}> {
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE id = ?
  `).bind(orderId).first<OrderRow>();
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status !== "paid" || order.test_payment_simulated !== 1 || order.test_only !== 1) {
    fail(412, "An administrator must simulate payment before issuing a test certificate.", "failed-precondition");
  }
  const currentCertificate = await env.DB.prepare(`
    SELECT order_id FROM gift_certificates WHERE order_id = ?
  `).bind(orderId).first<{ order_id: string }>();
  const existedBeforeRequest = Boolean(currentCertificate);

  const redemptionCode = `MHTTEST${randomHex(16).toUpperCase()}`;
  const codeHash = await sha256Hex(redemptionCode);
  const encrypted = await encryptSecret(redemptionCode, env.CERTIFICATE_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  const issuanceResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO gift_certificates
        (code_hash, order_id, encrypted_code, code_iv, code_auth_tag, recipient_name,
         recipient_email, initial_value_cents, balance_cents, status, test_only, created_at, updated_at)
      SELECT ?, o.id, ?, ?, ?, o.recipient_name, o.recipient_email, o.amount_cents,
             o.amount_cents, 'issued', 1, ?, ?
      FROM gift_card_orders o
      WHERE o.id = ? AND o.payment_status = 'paid'
        AND o.test_payment_simulated = 1 AND o.test_only = 1
    `).bind(
      codeHash,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      now,
      now,
      orderId
    ),
    env.DB.prepare(`
      UPDATE gift_card_orders
      SET certificate_status = 'issued', remaining_balance_cents = amount_cents, updated_at = ?
      WHERE id = ? AND payment_status = 'paid' AND test_only = 1
        AND certificate_status = 'not_issued'
        AND EXISTS (SELECT 1 FROM gift_certificates WHERE order_id = ?)
    `).bind(now, orderId, orderId)
  ]);
  const updatedOrder = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE id = ?
  `).bind(orderId).first<OrderRow>();
  if (!updatedOrder) fail(404, "Gift card order was not found.", "not-found");
  const delivery = await sendCertificate(
    updatedOrder,
    env,
    `staging-certificate-delivery-${orderId}`
  );
  const inserted = (issuanceResults[0]?.meta?.changes ?? 0) > 0;
  return {
    emailSent: delivery.emailSent,
    alreadyIssued: existedBeforeRequest || !inserted,
    redemptionCode: delivery.redemptionCode
  };
}

async function createOrder(request: Request, env: Env): Promise<Response> {
  await enforceOrderRateLimit(request, env);
  const body = await readJson(request);
  let orderInput: NewOrder;
  let accessToken: string;
  let idempotencyKey: string;
  try {
    orderInput = parseNewOrder(body);
    accessToken = validateAccessToken(body.accessToken);
    idempotencyKey = validateRequestId(body.idempotencyKey);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "Order details are invalid.", "invalid-argument");
  }
  await allowlistedRecipients(
    [orderInput.purchaserEmail, orderInput.recipientEmail],
    env.STAGING_ALLOWED_EMAILS
  );
  await verifyTurnstile(body.turnstileToken, env);

  const [idempotencyHash, accessTokenHash] = await Promise.all([
    sha256Hex(idempotencyKey),
    sha256Hex(accessToken)
  ]);
  let order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE idempotency_hash = ?
  `).bind(idempotencyHash).first<OrderRow>();
  let reusedRequest = Boolean(order);
  if (order) {
    if (!equalHex(order.access_token_hash, accessTokenHash)) {
      fail(409, "This order request cannot be reused.", "already-exists");
    }
  } else {
    await enforceGlobalDailyOrderLimit(env);
    await enforceNewOrderIpLimit(request, env);
    const id = crypto.randomUUID();
    const orderRef = `MHT-TEST-${randomHex(8).toUpperCase()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO gift_card_orders
        (id, order_ref, idempotency_hash, access_token_hash, purchaser_name, purchaser_email,
         recipient_name, recipient_email, recipient_type, message, amount_cents,
         payment_method, payment_status, certificate_status, remaining_balance_cents,
         test_only, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging_test', 'pending_payment',
              'not_issued', NULL, 1, ?, ?)
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
      SELECT * FROM gift_card_orders WHERE idempotency_hash = ?
    `).bind(idempotencyHash).first<OrderRow>();
    if (!order) fail(500, "The order could not be saved.", "internal");
    reusedRequest = order.id !== id;
  }

  const emails = await sendOrderEmails(order, env);
  return jsonResponse({
    orderRef: order.order_ref,
    accessToken,
    amountCents: order.amount_cents,
    purchaserEmail: order.purchaser_email,
    emailSent: emails.confirmationEmailSent,
    adminEmailSent: emails.adminEmailSent,
    testOnly: true,
    reusedRequest,
    paymentStatus: order.payment_status
  });
}

async function listOrders(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  let cursorCreatedAt = "";
  let cursorId = "";
  if (cursor) {
    try {
      [cursorCreatedAt, cursorId] = decoder.decode(
        Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - cursor.length % 4) % 4)), (char) => char.charCodeAt(0))
      ).split("\n");
      if (!cursorCreatedAt || !cursorId || cursorId.length > 128) throw new Error();
    } catch {
      fail(400, "The order list cursor is invalid.", "invalid-argument");
    }
  }
  const query = cursor
    ? env.DB.prepare(`
        SELECT * FROM gift_card_orders
        WHERE (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT 26
      `).bind(cursorCreatedAt, cursorCreatedAt, cursorId)
    : env.DB.prepare(`
        SELECT * FROM gift_card_orders ORDER BY created_at DESC, id DESC LIMIT 26
      `);
  const result = await query.all<OrderRow>();
  const rows = result.results.slice(0, 25);
  const last = rows[rows.length - 1];
  const nextCursor = result.results.length > 25 && last
    ? btoa(`${last.created_at}\n${last.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
    : null;
  const orders = rows.map((row) => ({
    ...asGiftCardOrder(row),
    paymentConfirmationEmailSent: Boolean(row.payment_email_sent_at)
  }));
  return jsonResponse({ orders, nextCursor });
}

async function simulatePayment(orderId: string, identity: AdminIdentity, env: Env): Promise<Response> {
  const now = new Date().toISOString();
  const update = await env.DB.prepare(`
    UPDATE gift_card_orders
    SET payment_status = 'paid', test_payment_simulated = 1,
        payment_verified_at = ?, payment_verified_by = ?, updated_at = ?
    WHERE id = ? AND payment_status = 'pending_payment'
      AND payment_method = 'staging_test' AND test_only = 1
  `).bind(now, identity.uid, now, orderId).run();
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE id = ?
  `).bind(orderId).first<OrderRow>();
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status !== "paid" || order.test_payment_simulated !== 1) {
    fail(412, "The order is not eligible for staging payment simulation.", "failed-precondition");
  }
  const alreadyConfirmed = (update.meta?.changes ?? 0) === 0;
  const confirmationEmailSent = await sendEmail(env, {
    orderId,
    emailType: "payment_confirmation",
    idempotencyKey: `staging-payment-confirmation-${orderId}`,
    to: [order.purchaser_email],
    subject: `Test payment simulation ${order.order_ref}`,
    html: `<p><strong>VOID — TEST ONLY.</strong> An administrator simulated payment for test order ${escapeHtml(order.order_ref)}.</p>
      <p>No real payment was received or accepted.</p>`
  });
  const issuance = await issueCertificate(orderId, env);
  return jsonResponse({
    alreadyConfirmed,
    confirmationEmailSent,
    emailSent: issuance.emailSent,
    redemptionCode: issuance.redemptionCode
  });
}

async function retryOrderEmails(orderId: string, env: Env): Promise<Response> {
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE id = ? AND test_only = 1
  `).bind(orderId).first<OrderRow>();
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  const result = await sendOrderEmails(order, env);
  return jsonResponse(result);
}

async function resendCertificate(orderId: string, requestId: string, env: Env): Promise<Response> {
  const order = await env.DB.prepare(`
    SELECT * FROM gift_card_orders WHERE id = ?
  `).bind(orderId).first<OrderRow>();
  if (!order) fail(404, "Gift card order was not found.", "not-found");
  if (order.payment_status !== "paid" || order.test_payment_simulated !== 1 || order.test_only !== 1) {
    fail(412, "A verified staging payment is required before certificate delivery.", "failed-precondition");
  }
  const delivery = await sendCertificate(order, env, `staging-certificate-resend-${orderId}-${requestId}`);
  return jsonResponse({ emailSent: delivery.emailSent, testOnly: true });
}

async function lookupCertificate(codeInput: unknown, env: Env): Promise<Response> {
  let code: string;
  try {
    code = normalizeRedemptionCode(codeInput);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "Redemption code is invalid.", "invalid-argument");
  }
  const codeHash = await sha256Hex(code);
  const certificate = await env.DB.prepare(`
    SELECT c.*, o.order_ref, o.amount_cents
    FROM gift_certificates c
    JOIN gift_card_orders o ON o.id = c.order_id
    WHERE c.code_hash = ? AND c.test_only = 1 AND o.payment_status = 'paid'
      AND o.test_payment_simulated = 1 AND o.test_only = 1
  `).bind(codeHash).first<CertificateRow & { order_ref: string; amount_cents: number }>();
  if (!certificate) fail(404, "No active staging certificate was found for that code.", "not-found");
  const redemptions = await env.DB.prepare(`
    SELECT amount_cents AS amountCents, balance_after_cents AS balanceAfterCents,
           note, redeemed_by AS redeemedBy, created_at AS createdAt
    FROM gift_card_redemptions
    WHERE code_hash = ? AND deduction_applied = 1
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
      testOnly: true
    },
    redemptions: redemptions.results
  });
}

async function redeemCertificate(body: Record<string, unknown>, identity: AdminIdentity, env: Env): Promise<Response> {
  let code: string;
  let requestId: string;
  try {
    code = normalizeRedemptionCode(body.code);
    requestId = validateRequestId(body.requestId);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "Redemption details are invalid.", "invalid-argument");
  }
  if (!Number.isSafeInteger(body.amountCents) || Number(body.amountCents) < 1) {
    fail(400, "Enter a valid redemption amount.", "invalid-argument");
  }
  const amountCents = Number(body.amountCents);
  if (typeof body.note !== "string" || body.note.length > 500) {
    fail(400, "The redemption note must be 500 characters or fewer.", "invalid-argument");
  }
  const note = body.note.trim();
  const codeHash = await sha256Hex(code);
  const prior = await env.DB.prepare(`
    SELECT code_hash, amount_cents, note, deduction_applied
    FROM gift_card_redemptions WHERE request_id = ?
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
    const currentBalance = await env.DB.prepare(`
      SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
    `).bind(codeHash).first<{ balance_cents: number }>();
    return jsonResponse({
      alreadyRedeemed: true,
      balanceCents: currentBalance?.balance_cents ?? 0
    });
  }

  const certificate = await env.DB.prepare(`
    SELECT c.order_id, c.balance_cents
    FROM gift_certificates c
    JOIN gift_card_orders o ON o.id = c.order_id
    WHERE c.code_hash = ? AND c.test_only = 1 AND c.balance_cents >= ?
      AND o.payment_status = 'paid' AND o.test_payment_simulated = 1 AND o.test_only = 1
  `).bind(codeHash, amountCents).first<{ order_id: string; balance_cents: number }>();
  if (!certificate) fail(412, "The certificate is not active or has insufficient balance.", "failed-precondition");

  const now = new Date().toISOString();
  const redemptionResults = await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO gift_card_redemptions
        (request_id, code_hash, amount_cents, balance_after_cents, note,
         redeemed_by, deduction_applied, test_only, created_at)
      SELECT ?, c.code_hash, ?, c.balance_cents - ?, ?, ?, 0, 1, ?
      FROM gift_certificates c
      JOIN gift_card_orders o ON o.id = c.order_id
      WHERE c.code_hash = ? AND c.test_only = 1 AND c.balance_cents >= ?
        AND o.payment_status = 'paid' AND o.test_payment_simulated = 1 AND o.test_only = 1
      ON CONFLICT(request_id) DO NOTHING
    `).bind(requestId, amountCents, amountCents, note, identity.uid, now, codeHash, amountCents),
    env.DB.prepare(`
      UPDATE gift_certificates
      SET balance_cents = balance_cents - ?,
          status = CASE
            WHEN balance_cents - ? = 0 THEN 'redeemed'
            ELSE 'partially_redeemed'
          END,
          updated_at = ?
      WHERE code_hash = ? AND balance_cents >= ?
        AND EXISTS (
          SELECT 1 FROM gift_card_redemptions
          WHERE request_id = ? AND code_hash = ? AND amount_cents = ? AND deduction_applied = 0
        )
    `).bind(amountCents, amountCents, now, codeHash, amountCents, requestId, codeHash, amountCents),
    env.DB.prepare(`
      UPDATE gift_card_orders
      SET remaining_balance_cents = (
            SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
          ),
          certificate_status = (
            SELECT status FROM gift_certificates WHERE code_hash = ?
          ),
          updated_at = ?
      WHERE id = ?
    `).bind(codeHash, codeHash, now, certificate.order_id),
    env.DB.prepare(`
      UPDATE gift_card_redemptions
      SET deduction_applied = 1
      WHERE request_id = ? AND deduction_applied = 0
        AND EXISTS (
          SELECT 1 FROM gift_certificates
          WHERE code_hash = ?
            AND balance_cents = (
              SELECT balance_after_cents FROM gift_card_redemptions WHERE request_id = ?
            )
        )
    `).bind(requestId, codeHash, requestId)
  ]);
  const completed = await env.DB.prepare(`
    SELECT amount_cents, balance_after_cents, note, deduction_applied
    FROM gift_card_redemptions WHERE request_id = ? AND code_hash = ?
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
    fail(412, "The certificate balance changed. Refresh and retry the redemption.", "failed-precondition");
  }
  if ((redemptionResults[0]?.meta?.changes ?? 0) === 0) {
    const currentBalance = await env.DB.prepare(`
      SELECT balance_cents FROM gift_certificates WHERE code_hash = ?
    `).bind(codeHash).first<{ balance_cents: number }>();
    return jsonResponse({
      alreadyRedeemed: true,
      balanceCents: currentBalance?.balance_cents ?? 0
    });
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

export async function handleRequest(
  request: Request,
  env: Env,
  dependencies: WorkerDependencies = {}
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.PUBLIC_SITE_ORIGIN) {
    return response({ error: "This origin is not allowed.", code: "origin-denied" }, 403, origin, env.PUBLIC_SITE_ORIGIN);
  }
  if (request.method === "OPTIONS") {
    return response({}, 204, origin, env.PUBLIC_SITE_ORIGIN);
  }
  if (env.APP_ENV !== "staging" ||
      env.FIREBASE_PROJECT_ID !== STAGING_PROJECT_ID ||
      env.PUBLIC_SITE_ORIGIN !== STAGING_SITE_ORIGIN ||
      env.PUBLIC_SITE_URL !== STAGING_SITE_URL ||
      env.TURNSTILE_EXPECTED_HOSTNAME !== STAGING_HOSTNAME) {
    return response({ error: "This Worker is not configured for staging.", code: "unsafe-config" }, 503, origin, env.PUBLIC_SITE_ORIGIN);
  }

  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/healthz" && request.method === "GET") {
      return response({ ok: true, environment: "staging", testOnly: true }, 200, origin, env.PUBLIC_SITE_ORIGIN);
    }
    if (url.pathname === "/api/orders" && request.method === "POST") {
      const result = await createOrder(request, env);
      return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
    }
    const certificateDownload = url.pathname.match(/^\/api\/orders\/([^/]+)\/certificate\.pdf$/);
    if (certificateDownload && request.method === "GET") {
      return await downloadCertificate(
        request,
        decodeURIComponent(certificateDownload[1]),
        env,
        origin
      );
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const identity = await requireAdmin(request, env, dependencies);
      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        const result = await listOrders(request, env);
        return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
      }
      if (request.method === "POST") {
        const simulate = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/simulate-payment$/);
        if (simulate) return response(await (await simulatePayment(decodeURIComponent(simulate[1]), identity, env)).json(), 200, origin, env.PUBLIC_SITE_ORIGIN);
        const retryEmails = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/retry-order-emails$/);
        if (retryEmails) {
          const result = await retryOrderEmails(decodeURIComponent(retryEmails[1]), env);
          return response(await result.json(), 200, origin, env.PUBLIC_SITE_ORIGIN);
        }
        const issue = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/issue$/);
        if (issue) {
          const result = await issueCertificate(decodeURIComponent(issue[1]), env);
          return response(result, 200, origin, env.PUBLIC_SITE_ORIGIN);
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
          const result = await resendCertificate(decodeURIComponent(resend[1]), requestId, env);
          return response(result, 200, origin, env.PUBLIC_SITE_ORIGIN);
        }
        if (url.pathname === "/api/admin/certificates/lookup") {
          const body = await readJson(request);
          const result = await lookupCertificate(body.code, env);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
        if (url.pathname === "/api/admin/certificates/redeem") {
          const body = await readJson(request);
          const result = await redeemCertificate(body, identity, env);
          return response(await result.json(), result.status, origin, env.PUBLIC_SITE_ORIGIN);
        }
      }
    }
    return response({ error: "This API route was not found.", code: "not-found" }, 404, origin, env.PUBLIC_SITE_ORIGIN);
  } catch (error) {
    return errorResponse(error, origin, env.PUBLIC_SITE_ORIGIN);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
};
