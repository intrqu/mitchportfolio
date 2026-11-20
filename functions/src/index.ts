import { timingSafeEqual } from "node:crypto";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import {
  createRedemptionCode,
  decryptValue,
  escapeHtml,
  encryptValue,
  hashSecret,
  isSameRedemption,
  normalizeRedemptionCode,
  parseNewOrder,
  applyRedemption,
  type NewOrderInput,
  validateAccessToken,
  validateRequestId
} from "./domain.js";
import { createCertificatePdf } from "./certificate.js";
import {
  consumeRateLimit,
  RateLimitExceeded,
  type RateLimitRules
} from "./rate-limit.js";

if (getApps().length === 0) initializeApp();

const db = getFirestore();
const interacEmail = defineString("INTERAC_EMAIL");
const adminNotificationEmails = defineString("ADMIN_NOTIFICATION_EMAILS", { default: "" });
const emailFrom = defineString("EMAIL_FROM");
const emailProvider = defineString("EMAIL_PROVIDER", { default: "resend" });
const publicSiteUrl = defineString("PUBLIC_SITE_URL");
const resendApiKey = defineSecret("RESEND_API_KEY");
const certificateEncryptionKey = defineSecret("CERTIFICATE_ENCRYPTION_KEY");
const rateLimitHmacKey = defineSecret("RATE_LIMIT_HMAC_KEY");

const FUNCTION_OPTIONS = {
  region: "us-west1" as const,
  maxInstances: 1,
  concurrency: 2
};
const ORDER_IP_LIMITS: RateLimitRules = { perMinute: 2, perHour: 5, perDay: 20 };
const ORDER_GLOBAL_LIMITS: RateLimitRules = { perDay: 20 };
const REPORT_IP_LIMITS: RateLimitRules = { perMinute: 5, perHour: 10, perDay: 30 };
const REPORT_GLOBAL_LIMITS: RateLimitRules = { perDay: 100 };
const EMAIL_LIMITS: RateLimitRules = { perMinute: 30, perDay: 80 };

type MailAttachment = { filename: string; content: string };
type Mail = {
  to: string[];
  subject: string;
  html: string;
  idempotencyKey: string;
  attachments?: MailAttachment[];
};
type GiftCardOrderEmailDetails = Pick<
  NewOrderInput,
  "amountCents" | "purchaserName" | "purchaserEmail"
> & {
  interacEmail?: string;
  instructionsEmailSentAt?: unknown;
  adminOrderNotifiedAt?: unknown;
};

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function requireAdmin(uid: string | undefined, admin: boolean | undefined): string {
  if (!uid || admin !== true) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return uid;
}

async function sendMail(mail: Mail): Promise<void> {
  if (emailProvider.value() !== "resend") {
    throw new Error("Unsupported EMAIL_PROVIDER. Configure the Resend adapter or add a server-side provider adapter.");
  }
  const key = resendApiKey.value();
  const from = emailFrom.value().trim();
  if (!key || !from || from.includes("REPLACE_")) {
    throw new Error("Email delivery is not configured.");
  }
  try {
    await consumeRateLimit(
      db,
      "gift-card-email",
      "all",
      EMAIL_LIMITS,
      rateLimitHmacKey.value(),
      mail.to.length
    );
  } catch (error) {
    if (error instanceof RateLimitExceeded) {
      throw new Error("The daily gift card email safety limit has been reached.");
    }
    throw error;
  }
  const { idempotencyKey, ...message } = mail;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({ from, ...message })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 400)}`);
  }
}

async function applyPublicRateLimit(
  request: { rawRequest: { ip?: string } },
  scope: string,
  ipRules: RateLimitRules,
  globalRules?: RateLimitRules
): Promise<void> {
  const ip = request.rawRequest.ip;
  if (!ip) {
    throw new HttpsError("failed-precondition", "Unable to verify this request. Please try again later.");
  }
  try {
    await consumeRateLimit(db, `${scope}:ip`, ip, ipRules, rateLimitHmacKey.value());
    if (globalRules) {
      await consumeRateLimit(db, `${scope}:global`, "all", globalRules, rateLimitHmacKey.value());
    }
  } catch (error) {
    if (error instanceof RateLimitExceeded) {
      throw new HttpsError("resource-exhausted", cleanError(error));
    }
    throw error;
  }
}

function adminEmails(): string[] {
  return adminNotificationEmails.value().split(",").map((email) => email.trim()).filter(Boolean);
}

function millis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

function lookupOrderByRef(orderRef: string) {
  return db.collection("giftCardOrders").where("orderRef", "==", orderRef).limit(1).get();
}

function tokenMatches(supplied: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(supplied), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const createGiftCardOrder = onCall(
  { ...FUNCTION_OPTIONS, enforceAppCheck: true, secrets: [resendApiKey, rateLimitHmacKey] },
  async (request) => {
    await applyPublicRateLimit(request, "gift-card-order", ORDER_IP_LIMITS, ORDER_GLOBAL_LIMITS);
    let order;
    let accessToken: string;
    try {
      order = parseNewOrder(request.data);
      accessToken = validateAccessToken(request.data?.accessToken);
    } catch (error) {
      throw new HttpsError("invalid-argument", cleanError(error));
    }
    const transferEmail = interacEmail.value().trim();
    if (!transferEmail || transferEmail.includes("REPLACE_")) {
      throw new HttpsError("failed-precondition", "e-Transfer checkout is not configured yet.");
    }

    const orderRefDoc = db.collection("giftCardOrders").doc(hashSecret(accessToken).slice(0, 32));
    const sequenceRef = db.doc("giftCardMetadata/orderSequence");
    const accessTokenHash = hashSecret(accessToken);
    const result = await db.runTransaction(async (transaction) => {
      const existingOrder = await transaction.get(orderRefDoc);
      if (existingOrder.exists) {
        if (!tokenMatches(accessToken, String(existingOrder.data()?.accessTokenHash ?? ""))) {
          throw new HttpsError("already-exists", "This order request could not be resumed.");
        }
        return {
          orderRef: String(existingOrder.data()?.orderRef ?? ""),
          order: existingOrder.data()!,
          created: false
        };
      }
      const sequenceDoc = await transaction.get(sequenceRef);
      const sequence = Number(sequenceDoc.data()?.value ?? 1000) + 1;
      const orderRef = `MHT-${sequence}`;
      transaction.set(sequenceRef, { value: sequence }, { merge: true });
      const newOrder = {
        orderRef,
        ...order,
        paymentMethod: "interac",
        paymentStatus: "pending_payment",
        certificateStatus: "not_issued",
        interacEmail: transferEmail,
        certificateHash: null,
        amountCents: order.amountCents,
        surchargeCents: 0,
        accessTokenHash,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      transaction.create(orderRefDoc, newOrder);
      return { orderRef, order: newOrder, created: true };
    });

    const savedOrder = result.order as GiftCardOrderEmailDetails;
    const savedTransferEmail = typeof savedOrder.interacEmail === "string"
      ? savedOrder.interacEmail
      : transferEmail;
    let emailSent = true;
    if (!savedOrder.instructionsEmailSentAt) {
      try {
        await sendMail({
          to: [savedOrder.purchaserEmail],
          subject: `e-Transfer instructions for ${result.orderRef}`,
          html: `<p>Thanks for your gift certificate order, ${escapeHtml(savedOrder.purchaserName)}.</p>
            <p>Send <strong>${formatMoney(savedOrder.amountCents)}</strong> by Interac e-Transfer to <strong>${escapeHtml(savedTransferEmail)}</strong>.</p>
            <p>Include order reference <strong>${result.orderRef}</strong> in the transfer message. Your certificate is issued after Mitch confirms payment.</p>
            <p>Use the "I've sent my payment" button on the order confirmation screen after sending the transfer. If you have closed that page, contact Mitch through the website and include your order reference.</p>`,
          idempotencyKey: `gift-card-order-instructions/${orderRefDoc.id}`
        });
        await orderRefDoc.update({ instructionsEmailSentAt: FieldValue.serverTimestamp() });
      } catch (error) {
        emailSent = false;
        logger.error("Gift card payment instructions email failed", {
          orderRef: result.orderRef,
          error: cleanError(error)
        });
      }
    }
    const recipients = adminEmails();
    if (recipients.length && !savedOrder.adminOrderNotifiedAt) {
      try {
        await sendMail({
          to: recipients,
          subject: `New gift card order ${result.orderRef}`,
          html: `<p>New e-Transfer gift card order ${result.orderRef} for ${formatMoney(savedOrder.amountCents)}.</p>
            <p>Purchaser: ${escapeHtml(savedOrder.purchaserName)} (${escapeHtml(savedOrder.purchaserEmail)})</p>
            <p>Review it in the gift card admin dashboard.</p>`,
          idempotencyKey: `gift-card-new-order-admin/${orderRefDoc.id}`
        });
        await orderRefDoc.update({ adminOrderNotifiedAt: FieldValue.serverTimestamp() });
      } catch (error) {
        logger.error("New gift card admin notification failed", {
          orderRef: result.orderRef,
          error: cleanError(error)
        });
      }
    }
    return {
      orderRef: result.orderRef,
      accessToken,
      interacEmail: savedTransferEmail,
      emailSent,
      amountCents: savedOrder.amountCents,
      purchaserEmail: savedOrder.purchaserEmail,
      reusedRequest: !result.created
    };
  }
);

export const reportInteracPayment = onCall(
  { ...FUNCTION_OPTIONS, enforceAppCheck: true, secrets: [resendApiKey, rateLimitHmacKey] },
  async (request) => {
    await applyPublicRateLimit(
      request,
      "gift-card-payment-report",
      REPORT_IP_LIMITS,
      REPORT_GLOBAL_LIMITS
    );
    const orderRef = typeof request.data?.orderRef === "string" ? request.data.orderRef.trim() : "";
    let accessToken: string;
    try {
      accessToken = validateAccessToken(request.data?.accessToken);
    } catch {
      throw new HttpsError("invalid-argument", "This order confirmation is not valid.");
    }
    if (!/^MHT-\d{4,}$/.test(orderRef)) {
      throw new HttpsError("invalid-argument", "This order confirmation is not valid.");
    }
    const result = await lookupOrderByRef(orderRef);
    if (result.empty) throw new HttpsError("not-found", "Order not found.");
    const orderDoc = result.docs[0];
    const data = orderDoc.data();
    if (!tokenMatches(accessToken, String(data.accessTokenHash ?? ""))) {
      throw new HttpsError("permission-denied", "This order confirmation is not valid.");
    }
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(orderDoc.ref);
      if (!current.exists) throw new HttpsError("not-found", "Order not found.");
      const status = current.data()?.paymentStatus;
      if (status === "pending_payment") {
        transaction.update(orderDoc.ref, {
          paymentStatus: "payment_reported",
          paymentReportedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      }
      if (status !== "pending_payment" && status !== "payment_reported" && status !== "paid") {
        throw new HttpsError("failed-precondition", "This order cannot accept a payment report.");
      }
    });

    const latestOrder = await orderDoc.ref.get();
    const latestData = latestOrder.data()!;
    const recipients = adminEmails();
    if (latestData.paymentStatus === "payment_reported" &&
        !latestData.paymentReportedAdminNotifiedAt &&
        recipients.length) {
      try {
        await sendMail({
          to: recipients,
          subject: `e-Transfer reported for ${orderRef}`,
          html: `<p>The purchaser reports sending the e-Transfer for order ${orderRef} (${formatMoney(data.amountCents)}).</p>
            <p>Check your bank account before confirming payment in the admin dashboard.</p>`,
          idempotencyKey: `gift-card-payment-reported/${orderDoc.id}`
        });
        await orderDoc.ref.update({
          paymentReportedAdminNotifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (error) {
        logger.error("Payment reported admin notification failed", { orderRef, error: cleanError(error) });
      }
    }
    return { reported: true };
  }
);

export const listGiftCardOrders = onCall(FUNCTION_OPTIONS, async (request) => {
  requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
  const collection = db.collection("giftCardOrders");
  let query = collection.orderBy("createdAt", "desc");
  const cursor = typeof request.data?.cursor === "string" ? request.data.cursor : "";
  if (cursor) {
    const cursorDocument = await collection.doc(requiredOrderId(cursor)).get();
    if (!cursorDocument.exists) throw new HttpsError("invalid-argument", "Order page cursor is not valid.");
    query = query.startAfter(cursorDocument);
  }
  const snapshot = await query.limit(100).get();
  return {
    nextCursor: snapshot.size === 100 ? snapshot.docs[snapshot.docs.length - 1].id : null,
    orders: snapshot.docs.map((document) => {
      const order = document.data();
      return {
        id: document.id,
        orderRef: order.orderRef,
        amountCents: order.amountCents,
        purchaserName: order.purchaserName,
        purchaserEmail: order.purchaserEmail,
        recipientName: order.recipientName,
        recipientEmail: order.recipientEmail,
        message: order.message,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        certificateStatus: order.certificateStatus,
        remainingBalanceCents: order.remainingBalanceCents ?? null,
        createdAt: millis(order.createdAt),
        paymentVerifiedAt: millis(order.paymentVerifiedAt),
        paymentConfirmationEmailSent: Boolean(order.paymentConfirmationEmailSentAt),
        issuedAt: millis(order.issuedAt)
      };
    })
  };
});

export const confirmInteracPayment = onCall(
  { ...FUNCTION_OPTIONS, secrets: [resendApiKey, certificateEncryptionKey, rateLimitHmacKey] },
  async (request) => {
    const adminUid = requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
    const orderId = requiredOrderId(request.data?.orderId);
    const orderRef = db.collection("giftCardOrders").doc(orderId);
    const newlyVerified = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(orderRef);
      if (!snapshot.exists) throw new HttpsError("not-found", "Order not found.");
      const order = snapshot.data()!;
      if (order.paymentMethod !== "interac") throw new HttpsError("failed-precondition", "This is not an e-Transfer order.");
      if (order.paymentStatus === "paid") return false;
      if (order.paymentStatus !== "pending_payment" && order.paymentStatus !== "payment_reported") {
        throw new HttpsError("failed-precondition", "This order cannot be marked paid.");
      }
      transaction.update(orderRef, {
        paymentStatus: "paid",
        paymentVerifiedAt: FieldValue.serverTimestamp(),
        paymentVerifiedBy: adminUid,
        updatedAt: FieldValue.serverTimestamp()
      });
      return true;
    });

    const snapshot = await orderRef.get();
    const order = snapshot.data()!;
    let confirmationEmailSent = true;
    if (!order.paymentConfirmationEmailSentAt) {
      try {
        await sendMail({
          to: [order.purchaserEmail],
          subject: `Payment confirmed for ${order.orderRef}`,
          html: `<p>Payment for order ${order.orderRef} has been confirmed.</p><p>Your gift certificate is being issued and will be sent to ${escapeHtml(order.recipientEmail)}.</p>`,
          idempotencyKey: `gift-card-payment-confirmed/${orderId}`
        });
        await orderRef.update({
          paymentConfirmationEmailSentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (error) {
        confirmationEmailSent = false;
        logger.error("Gift card payment confirmation email failed", { orderId, error: cleanError(error) });
      }
    }
    const issuance = await issueCertificate(orderId);
    return { ...issuance, confirmationEmailSent, alreadyConfirmed: !newlyVerified };
  }
);

export const issueGiftCertificate = onCall(
  { ...FUNCTION_OPTIONS, secrets: [resendApiKey, certificateEncryptionKey, rateLimitHmacKey] },
  async (request) => {
    requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
    return issueCertificate(requiredOrderId(request.data?.orderId));
  }
);

async function issueCertificate(
  orderId: string,
  resendRequestId?: string
): Promise<{ issued: boolean; emailSent: boolean; alreadyIssued: boolean }> {
  const orderRef = db.collection("giftCardOrders").doc(orderId);
  const orderSnapshot = await orderRef.get();
  if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
  const order = orderSnapshot.data()!;
  if (order.paymentStatus !== "paid") {
    throw new HttpsError("failed-precondition", "Payment must be verified before a certificate can be issued.");
  }

  const newCode = createRedemptionCode();
  const newCodeHash = hashSecret(newCode.replace(/[^A-Z0-9]/g, ""));
  const encryptedCode = encryptValue(newCode, certificateEncryptionKey.value());
  const issuance = await db.runTransaction(async (transaction) => {
    const latest = await transaction.get(orderRef);
    if (!latest.exists || latest.data()?.paymentStatus !== "paid") {
      throw new HttpsError("failed-precondition", "Payment must be verified before a certificate can be issued.");
    }
    const existingHash = latest.data()?.certificateHash;
    if (typeof existingHash === "string" && existingHash) {
      return { certificateHash: existingHash, created: false };
    }
    const certificateRef = db.collection("giftCertificates").doc(newCodeHash);
    transaction.create(certificateRef, {
      orderId,
      initialValueCents: order.amountCents,
      balanceCents: order.amountCents,
      status: "issued",
      recipientName: order.recipientName,
      recipientEmail: order.recipientEmail,
      encryptedCode,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.update(orderRef, {
      certificateHash: newCodeHash,
      certificateStatus: "issued",
      remainingBalanceCents: order.amountCents,
      issuedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { certificateHash: newCodeHash, created: true };
  });

  const certificateRef = db.collection("giftCertificates").doc(issuance.certificateHash);
  const [certificateSnapshot, latestOrderSnapshot] = await Promise.all([
    certificateRef.get(),
    orderRef.get()
  ]);
  if (!certificateSnapshot.exists || !latestOrderSnapshot.exists) {
    throw new HttpsError("internal", "Issued certificate records could not be read.");
  }
  const certificate = certificateSnapshot.data()!;
  const deliveryRef = resendRequestId
    ? certificateRef.collection("deliveries").doc(resendRequestId)
    : null;
  const deliverySnapshot = deliveryRef ? await deliveryRef.get() : null;
  const shouldSendEmail = resendRequestId
    ? !deliverySnapshot?.data()?.sentAt
    : !certificate.emailSentAt;
  if (!shouldSendEmail) {
    return { issued: true, emailSent: true, alreadyIssued: !issuance.created };
  }

  const code = issuance.created
    ? newCode
    : decryptValue(certificate.encryptedCode, certificateEncryptionKey.value());
  const issuedAt = certificate.createdAt instanceof Timestamp
    ? certificate.createdAt.toDate()
    : new Date();
  const pdf = await createCertificatePdf({
    code,
    amountCents: certificate.initialValueCents,
    recipientName: certificate.recipientName,
    message: latestOrderSnapshot.data()!.message || "",
    issuedAt
  });

  let emailSent = true;
  try {
    await sendMail({
      to: [certificate.recipientEmail],
      subject: "Your Mitch Harsch Tattoo gift certificate",
      html: `<p>Hello ${escapeHtml(certificate.recipientName)},</p><p>Your gift certificate is attached. Contact Mitch through <a href="${escapeHtml(publicSiteUrl.value())}/#booking">the website</a> to book and present the redemption code.</p>`,
      idempotencyKey: resendRequestId
        ? `gift-card-certificate-resend/${orderId}/${resendRequestId}`
        : `gift-card-certificate-issued/${orderId}`,
      attachments: [{ filename: `mitch-harsch-gift-certificate-${order.orderRef}.pdf`, content: pdf.toString("base64") }]
    });
    if (deliveryRef) {
      await deliveryRef.set({
        sentAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp()
      });
    } else {
      await certificateRef.update({ emailSentAt: FieldValue.serverTimestamp() });
    }
  } catch (error) {
    emailSent = false;
    logger.error("Gift certificate delivery email failed", { orderId, error: cleanError(error) });
  }
  return { issued: true, emailSent, alreadyIssued: !issuance.created };
}

export const lookupGiftCertificate = onCall(FUNCTION_OPTIONS, async (request) => {
  requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
  let codeHash: string;
  try {
    codeHash = hashSecret(normalizeRedemptionCode(request.data?.code));
  } catch (error) {
    throw new HttpsError("invalid-argument", cleanError(error));
  }
  const certificateSnapshot = await db.collection("giftCertificates").doc(codeHash).get();
  if (!certificateSnapshot.exists) throw new HttpsError("not-found", "No gift certificate matches that code.");
  const certificate = certificateSnapshot.data()!;
  const orderSnapshot = await db.collection("giftCardOrders").doc(certificate.orderId).get();
  if (!orderSnapshot.exists) throw new HttpsError("internal", "The linked order could not be found.");
  const order = orderSnapshot.data()!;
  const redemptions = await certificateSnapshot.ref.collection("redemptions")
    .orderBy("createdAt", "desc").limit(100).get();
  return {
    certificate: {
      orderRef: order.orderRef,
      amountCents: certificate.initialValueCents,
      balanceCents: certificate.balanceCents,
      status: certificate.status,
      recipientName: certificate.recipientName,
      recipientEmail: certificate.recipientEmail,
      issuedAt: millis(order.issuedAt)
    },
    redemptions: redemptions.docs.map((document) => {
      const redemption = document.data();
      return {
        amountCents: redemption.amountCents,
        note: redemption.note,
        createdAt: millis(redemption.createdAt)
      };
    })
  };
});

export const redeemGiftCertificate = onCall(FUNCTION_OPTIONS, async (request) => {
  const adminUid = requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
  let codeHash: string;
  let requestId: string;
  try {
    codeHash = hashSecret(normalizeRedemptionCode(request.data?.code));
    requestId = validateRequestId(request.data?.requestId);
  } catch (error) {
    throw new HttpsError("invalid-argument", cleanError(error));
  }
  const amountCents = request.data?.amountCents;
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
    throw new HttpsError("invalid-argument", "Enter a valid redemption amount greater than zero.");
  }
  const note = typeof request.data?.note === "string" ? request.data.note.trim() : "";
  if (note.length > 500) throw new HttpsError("invalid-argument", "The note must be 500 characters or fewer.");
  const certificateRef = db.collection("giftCertificates").doc(codeHash);
  const redemptionRef = certificateRef.collection("redemptions").doc(requestId);
  const result = await db.runTransaction(async (transaction) => {
    const certificateSnapshot = await transaction.get(certificateRef);
    if (!certificateSnapshot.exists) throw new HttpsError("not-found", "No gift certificate matches that code.");
    const certificate = certificateSnapshot.data()!;
    const redemptionSnapshot = await transaction.get(redemptionRef);
    const orderRef = db.collection("giftCardOrders").doc(certificate.orderId);
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists ||
        orderSnapshot.data()?.paymentStatus !== "paid" ||
        orderSnapshot.data()?.certificateHash !== codeHash) {
      throw new HttpsError("failed-precondition", "Payment must be confirmed before a certificate can be redeemed.");
    }
    if (redemptionSnapshot.exists) {
      try {
        isSameRedemption(redemptionSnapshot.data() as { amountCents: number; note: string }, amountCents, note);
      } catch (error) {
        throw new HttpsError("already-exists", cleanError(error));
      }
      return {
        alreadyRedeemed: true,
        balanceCents: redemptionSnapshot.data()?.balanceAfterCents
      };
    }
    const remaining = Number(certificate.balanceCents);
    let newBalance: number;
    try {
      newBalance = applyRedemption(remaining, amountCents);
    } catch (error) {
      throw new HttpsError("failed-precondition", cleanError(error));
    }
    transaction.update(certificateRef, {
      balanceCents: newBalance,
      status: newBalance === 0 ? "redeemed" : "partially_redeemed",
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(redemptionRef, {
      amountCents,
      balanceAfterCents: newBalance,
      note,
      redeemedBy: adminUid,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.update(orderRef, {
      certificateStatus: newBalance === 0 ? "redeemed" : "partially_redeemed",
      remainingBalanceCents: newBalance,
      updatedAt: FieldValue.serverTimestamp()
    });
    return { alreadyRedeemed: false, balanceCents: newBalance };
  });
  return { redeemed: true, ...result };
});

export const resendGiftCertificate = onCall(
  { ...FUNCTION_OPTIONS, secrets: [resendApiKey, certificateEncryptionKey, rateLimitHmacKey] },
  async (request) => {
    requireAdmin(request.auth?.uid, request.auth?.token.admin as boolean | undefined);
    const orderId = requiredOrderId(request.data?.orderId);
    let requestId: string;
    try {
      requestId = validateRequestId(request.data?.requestId);
    } catch (error) {
      throw new HttpsError("invalid-argument", cleanError(error));
    }
    const snapshot = await db.collection("giftCardOrders").doc(orderId).get();
    if (!snapshot.exists || snapshot.data()?.certificateStatus === "not_issued") {
      throw new HttpsError("failed-precondition", "Issue the paid certificate before resending it.");
    }
    return issueCertificate(orderId, requestId);
  }
);

function requiredOrderId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(value)) {
    throw new HttpsError("invalid-argument", "Order ID is not valid.");
  }
  return value;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
}
