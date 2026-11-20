import { rateLimitIpHash } from "./crypto.js";
import type { Env } from "./types.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

export async function verifyTurnstile(
  token: unknown,
  env: Env,
  fetcher: typeof fetch = fetch
): Promise<void> {
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    throw new HttpError(400, "Complete the anti-spam check and try again.", "turnstile-token");
  }
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new HttpError(503, "Staging anti-spam protection is not configured.", "turnstile-not-configured");
  }
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token
  });
  let response: Response;
  try {
    response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new HttpError(503, "The anti-spam check is temporarily unavailable.", "turnstile-unavailable");
  }
  if (!response.ok) {
    throw new HttpError(503, "The anti-spam check is temporarily unavailable.", "turnstile-unavailable");
  }
  const result = await response.json() as {
    success?: boolean;
    hostname?: string;
    action?: string;
  };
  if (!result.success ||
      result.hostname !== env.TURNSTILE_EXPECTED_HOSTNAME ||
      result.action !== "gift_card_order") {
    throw new HttpError(400, "The anti-spam check failed. Please try again.", "turnstile-rejected");
  }
}

export async function enforceOrderRateLimit(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new HttpError(400, "Unable to validate this request. Please try again.", "ip-unavailable");

  const ipHash = await rateLimitIpHash(ip, env);
  const edgeLimit = await env.ORDER_RATE_LIMIT.limit({ key: ipHash });
  if (!edgeLimit.success) {
    throw new HttpError(429, "Too many order attempts. Please try again later.", "rate-limited");
  }
}

export async function enforceNewOrderIpLimit(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new HttpError(400, "Unable to validate this request. Please try again.", "ip-unavailable");
  const ipHash = await rateLimitIpHash(ip, env);
  const now = new Date();
  const minuteWindow = Math.floor(now.getTime() / 60_000);
  const dayWindow = now.toISOString().slice(0, 10);
  const ipLimit = await env.DB.prepare(`
    INSERT INTO gift_card_ip_limits
      (ip_hash, minute_window, minute_count, day_window, day_count, updated_at)
    VALUES (?, ?, 1, ?, 1, ?)
    ON CONFLICT(ip_hash) DO UPDATE SET
      minute_count = CASE
        WHEN gift_card_ip_limits.minute_window = excluded.minute_window
        THEN gift_card_ip_limits.minute_count + 1
        ELSE 1
      END,
      minute_window = excluded.minute_window,
      day_count = CASE
        WHEN gift_card_ip_limits.day_window = excluded.day_window
        THEN gift_card_ip_limits.day_count + 1
        ELSE 1
      END,
      day_window = excluded.day_window,
      updated_at = excluded.updated_at
    RETURNING minute_count, day_count
  `).bind(ipHash, minuteWindow, dayWindow, now.toISOString())
    .first<{ minute_count: number; day_count: number }>();
  if (!ipLimit || ipLimit.minute_count > 2 || ipLimit.day_count > 20) {
    throw new HttpError(429, "Too many order attempts. Please try again later.", "rate-limited");
  }
}

export async function enforceCertificateDownloadRateLimit(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new HttpError(400, "Unable to validate this request. Please try again.", "ip-unavailable");
  const ipHash = await rateLimitIpHash(ip, env);
  const limit = await env.ORDER_RATE_LIMIT.limit({ key: `certificate:${ipHash}` });
  if (!limit.success) {
    throw new HttpError(429, "Too many certificate download attempts. Please try again later.", "rate-limited");
  }
}

export async function enforceGlobalDailyOrderLimit(env: Env): Promise<void> {
  const dayWindow = new Date().toISOString().slice(0, 10);
  const globalLimit = await env.DB.prepare(`
    UPDATE gift_card_global_limits
    SET order_count = CASE WHEN order_day = ? THEN order_count + 1 ELSE 1 END,
        order_day = ?
    WHERE id = 1
    RETURNING order_count
  `).bind(dayWindow, dayWindow).first<{ order_count: number }>();
  if (!globalLimit || globalLimit.order_count > 20) {
    throw new HttpError(429, "Today's test order limit has been reached.", "daily-limit");
  }
}

export async function allowlistedRecipients(
  recipientEmails: string[],
  allowlist: string
): Promise<void> {
  const allowed = new Set(allowlist.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size || recipientEmails.some((email) => !allowed.has(email.toLowerCase()))) {
    throw new HttpError(400, "Staging email is limited to configured test inboxes.", "email-not-allowlisted");
  }
}
