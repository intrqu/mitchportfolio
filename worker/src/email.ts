import { bytesToBase64 } from "./crypto.js";
import { assertAllowedRecipients } from "./validation.js";
import type { Env } from "./types.js";

export interface EmailInput {
  orderId: string;
  emailType: "order_confirmation" | "admin_new_order" | "payment_confirmation" | "certificate_delivery";
  idempotencyKey: string;
  to: string[];
  subject: string;
  html: string;
  attachment?: { filename: string; content: Uint8Array };
}

interface DeliveryRow {
  delivery_status: "sending" | "sent" | "failed";
}

const STAGING_EMAIL_WARNING = `<div style="background:#5b111b;border:3px solid #e11d48;color:#fff;padding:18px;text-align:center;margin:0 0 24px">
  <div style="font-size:24px;font-weight:800;letter-spacing:.04em">TEST ONLY — DO NOT SEND MONEY</div>
  <div style="font-size:16px;font-weight:700;margin-top:8px">Do not initiate an Interac e-Transfer or send funds. This staging system does not accept payments.</div>
</div>`;

export async function sendEmail(env: Env, input: EmailInput): Promise<boolean> {
  try {
    assertAllowedRecipients(input.to, env.STAGING_ALLOWED_EMAILS);
  } catch (error) {
    console.error("Email blocked by staging recipient allowlist.", error);
    await markDeliveryFailed(env, input, "recipient-not-allowlisted");
    return false;
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.error("Staging email is not configured.");
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
  await env.DB.prepare(`
    UPDATE gift_card_email_deliveries
    SET delivery_status = 'sending', last_error = NULL, updated_at = ?
    WHERE idempotency_key = ? AND delivery_status != 'sent'
  `).bind(now, input.idempotencyKey).run();

  const today = now.slice(0, 10);
  const quota = await env.DB.prepare(`
    UPDATE gift_card_global_limits
    SET email_count = CASE WHEN email_day = ? THEN email_count + 1 ELSE 1 END,
        email_day = ?
    WHERE id = 1
    RETURNING email_count
  `).bind(today, today).first<{ email_count: number }>();
  if (!quota || quota.email_count > 80) {
    await markDeliveryFailed(env, input, "daily-email-limit");
    return false;
  }

  const body: Record<string, unknown> = {
    from: env.EMAIL_FROM,
    to: input.to,
    subject: `TEST ONLY — DO NOT SEND MONEY: ${input.subject}`,
    html: `${STAGING_EMAIL_WARNING}${input.html}`
  };
  if (input.attachment) {
    body.attachments = [{
      filename: input.attachment.filename,
      content: bytesToBase64(input.attachment.content)
    }];
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
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
      console.error("Resend email request failed.", { status: response.status, type: input.emailType });
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
      payment_confirmation: "payment_email_sent_at",
      certificate_delivery: null
    }[input.emailType];
    if (timestampColumn) {
      await env.DB.prepare(
        `UPDATE gift_card_orders SET ${timestampColumn} = ?, updated_at = ? WHERE id = ?`
      ).bind(sentAt, sentAt, input.orderId).run();
    } else {
      await env.DB.prepare(`
        UPDATE gift_certificates SET email_sent_at = ?, updated_at = ? WHERE order_id = ?
      `).bind(sentAt, sentAt, input.orderId).run();
    }
    return true;
  } catch {
    await markDeliveryFailed(env, input, "provider-request-failed");
    console.error("Resend email request failed.", { type: input.emailType });
    return false;
  }
}

async function markDeliveryFailed(env: Env, input: EmailInput, reason: string): Promise<void> {
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
  `).bind(
    input.idempotencyKey,
    input.orderId,
    input.emailType,
    input.to.join(","),
    reason,
    now,
    now
  ).run();
}
