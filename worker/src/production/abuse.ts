import { hmacHex } from "../crypto.js";
import type { ProductionEnv } from "./types.js";

export class ProductionHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string
  ) {
    super(message);
  }
}

export async function verifyProductionTurnstile(
  token: unknown,
  env: ProductionEnv,
  fetcher: typeof fetch = fetch
): Promise<void> {
  if (typeof token !== "string" || token.length < 1 || token.length > 2048) {
    throw new ProductionHttpError(400, "Complete the anti-spam check and try again.", "turnstile-token");
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
    throw new ProductionHttpError(503, "The anti-spam check is temporarily unavailable.", "turnstile-unavailable");
  }
  if (!response.ok) {
    throw new ProductionHttpError(503, "The anti-spam check is temporarily unavailable.", "turnstile-unavailable");
  }
  const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
  if (!result.success ||
      result.hostname !== env.TURNSTILE_EXPECTED_HOSTNAME ||
      result.action !== "gift_card_order") {
    throw new ProductionHttpError(400, "The anti-spam check failed. Please try again.", "turnstile-rejected");
  }
}

export async function enforceIpRateLimit(
  request: Request,
  env: ProductionEnv,
  purpose: "orders" | "certificate-download",
  perMinute: number,
  perDay: number
): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new ProductionHttpError(400, "Unable to validate this request. Please try again.", "ip-unavailable");

  const ipHash = await hmacHex(`production:${purpose}:${ip}`, env.RATE_LIMIT_HMAC_KEY);
  const now = new Date();
  const minuteWindow = Math.floor(now.getTime() / 60_000);
  const dayWindow = now.toISOString().slice(0, 10);
  const limit = await env.DB.prepare(`
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
  if (!limit || limit.minute_count > perMinute || limit.day_count > perDay) {
    throw new ProductionHttpError(429, "Too many attempts. Please try again later.", "rate-limited");
  }
}

export async function enforceDailyOrderLimit(env: ProductionEnv): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const limit = Number(env.MAX_ORDERS_PER_DAY);
  const result = await env.DB.prepare(`
    UPDATE gift_card_global_limits
    SET order_count = CASE WHEN order_day = ? THEN order_count + 1 ELSE 1 END,
        order_day = ?
    WHERE id = 1
    RETURNING order_count
  `).bind(day, day).first<{ order_count: number }>();
  if (!result || result.order_count > limit) {
    throw new ProductionHttpError(429, "Today's order limit has been reached.", "daily-limit");
  }
}
