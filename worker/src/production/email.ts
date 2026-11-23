import { bytesToBase64 } from "../crypto.js";
import { parseEmailAllowlist } from "../validation.js";
import type { ProductionEnv, ProductionOrder } from "./types.js";

export type ProductionEmailType =
  | "order_confirmation"
  | "admin_new_order"
  | "payment_reported"
  | "payment_confirmation"
  | "certificate_delivery";

export interface ProductionEmailInput {
  orderId: string;
  emailType: ProductionEmailType;
  idempotencyKey: string;
  to: string[];
  subject: string;
  html: string;
  attachment?: { filename: string; content: Uint8Array };
}

interface DeliveryRow {
  delivery_status: "sending" | "sent" | "failed";
}

const emailDailyLimit = 80;

export async function sendProductionEmail(
  env: ProductionEnv,
  input: ProductionEmailInput,
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!input.to.length || input.to.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
    await markDeliveryFailed(env, input, "invalid-recipient");
    return false;
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    await markDeliveryFailed(env, input, "email-not-configured");
    return false;
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO gift_card_email_deliveries
      (idempotency_key, order_id, email_type, recipient_email, delivery_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'sending', ?, ?)
  `).bind(input.idempotencyKey, input.orderId, input.emailType, input.to.join(","), now, now).run();
  const existing = await env.DB.prepare(`
    SELECT delivery_status FROM gift_card_email_deliveries WHERE idempotency_key = ?
  `).bind(input.idempotencyKey).first<DeliveryRow>();
  if (existing?.delivery_status === "sent") return true;

  const dailyLimit = Math.min(emailDailyLimit, Number(env.EMAIL_DAILY_LIMIT));
  const today = now.slice(0, 10);
  const quota = await env.DB.prepare(`
    UPDATE gift_card_global_limits
    SET email_count = CASE WHEN email_day = ? THEN email_count + 1 ELSE 1 END,
        email_day = ?
    WHERE id = 1
    RETURNING email_count
  `).bind(today, today).first<{ email_count: number }>();
  if (!quota || quota.email_count > dailyLimit) {
    await markDeliveryFailed(env, input, "daily-email-limit");
    return false;
  }

  await env.DB.prepare(`
    UPDATE gift_card_email_deliveries
    SET delivery_status = 'sending', last_error = NULL, updated_at = ?
    WHERE idempotency_key = ? AND delivery_status != 'sent'
  `).bind(now, input.idempotencyKey).run();

  const body: Record<string, unknown> = {
    from: env.EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    html: input.html
  };
  if (input.attachment) {
    body.attachments = [{
      filename: input.attachment.filename,
      content: bytesToBase64(input.attachment.content)
    }];
  }

  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey
      },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      await markDeliveryFailed(env, input, `provider-http-${response.status}`);
      console.error("Production email delivery failed.", { status: response.status, type: input.emailType });
      return false;
    }
    const result = await response.json() as { id?: string };
    const sentAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE gift_card_email_deliveries
      SET delivery_status = 'sent', provider_message_id = ?, last_error = NULL, updated_at = ?
      WHERE idempotency_key = ?
    `).bind(result.id ?? null, sentAt, input.idempotencyKey).run();
    const timestampColumn = {
      order_confirmation: "order_email_sent_at",
      admin_new_order: "admin_email_sent_at",
      payment_reported: null,
      payment_confirmation: "payment_email_sent_at",
      certificate_delivery: null
    }[input.emailType];
    if (timestampColumn) {
      await env.DB.prepare(
        `UPDATE gift_card_orders SET ${timestampColumn} = ?, updated_at = ? WHERE id = ?`
      ).bind(sentAt, sentAt, input.orderId).run();
    } else if (input.emailType === "certificate_delivery") {
      await env.DB.prepare(`
        UPDATE gift_certificates SET email_sent_at = ?, updated_at = ? WHERE order_id = ?
      `).bind(sentAt, sentAt, input.orderId).run();
    }
    return true;
  } catch {
    await markDeliveryFailed(env, input, "provider-request-failed");
    console.error("Production email delivery failed.", { type: input.emailType });
    return false;
  }
}

async function markDeliveryFailed(
  env: ProductionEnv,
  input: ProductionEmailInput,
  reason: string
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO gift_card_email_deliveries
      (idempotency_key, order_id, email_type, recipient_email, delivery_status, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)
    ON CONFLICT(idempotency_key) DO UPDATE SET
      delivery_status = CASE
        WHEN gift_card_email_deliveries.delivery_status = 'sent' THEN 'sent'
        ELSE 'failed'
      END,
      last_error = CASE
        WHEN gift_card_email_deliveries.delivery_status = 'sent' THEN NULL
        ELSE excluded.last_error
      END,
      updated_at = excluded.updated_at
  `).bind(input.idempotencyKey, input.orderId, input.emailType, input.to.join(","), reason, now, now).run();
}

export async function sendOrderEmails(
  order: ProductionOrder,
  env: ProductionEnv,
  fetcher: typeof fetch = fetch
): Promise<{ confirmationEmailSent: boolean; adminEmailSent: boolean }> {
  const orderRef = escapeHtml(order.order_ref);
  const amount = (order.amount_cents / 100).toFixed(2);
  const interacEmail = escapeHtml(env.PRODUCTION_INTERAC_EMAIL);
  const confirmationEmailSent = await sendProductionEmail(env, {
    orderId: order.id,
    emailType: "order_confirmation",
    idempotencyKey: `production-order-confirmation-${order.id}`,
    to: [order.purchaser_email],
    subject: `Gift card order ${order.order_ref} — payment instructions`,
    html: `<p>Your Mitch Harsch Tattoo gift certificate order was received.</p>
      <p>Order reference: <strong>${orderRef}</strong><br>Amount to transfer: <strong>$${amount} CAD</strong></p>
      <p>Send an Interac e-Transfer to <strong>${interacEmail}</strong> for exactly <strong>$${amount} CAD</strong>.
      Include order reference <strong>${orderRef}</strong> in the transfer message.</p>
      <p>Your certificate will be issued only after Mitch confirms receipt of the payment.</p>`
  }, fetcher);

  const adminEmailSent = await sendProductionEmail(env, {
    orderId: order.id,
    emailType: "admin_new_order",
    idempotencyKey: `production-admin-new-order-${order.id}`,
    to: [...parseEmailAllowlist(env.PRODUCTION_ADMIN_EMAILS)],
    subject: `New gift card order ${order.order_ref}`,
    html: `<p>A gift card order is awaiting payment.</p>
      <p>Reference: ${orderRef}<br>Value: $${amount} CAD<br>
      Purchaser: ${escapeHtml(order.purchaser_name)} (${escapeHtml(order.purchaser_email)})</p>`
  }, fetcher);
  return { confirmationEmailSent, adminEmailSent };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
