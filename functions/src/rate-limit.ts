import { createHmac } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type RateLimitRules = {
  perMinute?: number;
  perHour?: number;
  perDay: number;
};

export type RateLimitState = {
  minuteWindowStart: number;
  minuteCount: number;
  hourWindowStart: number;
  hourCount: number;
  dayWindowStart: number;
  dayCount: number;
};

export class RateLimitExceeded extends Error {
  constructor() {
    super("Too many requests. Please try again later.");
    this.name = "RateLimitExceeded";
  }
}

export function rateLimitDocumentId(scope: string, subject: string, key: string): string {
  if (Buffer.byteLength(key) < 32) {
    throw new Error("Rate-limit HMAC key must contain at least 32 bytes.");
  }
  return createHmac("sha256", key)
    .update(`${scope}\0${subject}`)
    .digest("hex");
}

export function nextRateLimitState(
  current: Partial<RateLimitState> | undefined,
  now: number,
  rules: RateLimitRules,
  weight = 1
): RateLimitState {
  const minuteWindowStart = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const hourWindowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const dayWindowStart = Math.floor(now / DAY_MS) * DAY_MS;
  const next = {
    minuteWindowStart,
    minuteCount: current?.minuteWindowStart === minuteWindowStart
      ? Number(current.minuteCount ?? 0) + weight
      : weight,
    hourWindowStart,
    hourCount: current?.hourWindowStart === hourWindowStart
      ? Number(current.hourCount ?? 0) + weight
      : weight,
    dayWindowStart,
    dayCount: current?.dayWindowStart === dayWindowStart
      ? Number(current.dayCount ?? 0) + weight
      : weight
  };
  if ((rules.perMinute !== undefined && next.minuteCount > rules.perMinute) ||
      (rules.perHour !== undefined && next.hourCount > rules.perHour) ||
      next.dayCount > rules.perDay) {
    throw new RateLimitExceeded();
  }
  return next;
}

export async function consumeRateLimit(
  db: Firestore,
  scope: string,
  subject: string,
  rules: RateLimitRules,
  key: string,
  weight = 1
): Promise<void> {
  if (!Number.isSafeInteger(weight) || weight < 1) {
    throw new Error("Rate limit weight must be a positive integer.");
  }
  const documentId = rateLimitDocumentId(scope, subject, key);
  const reference = db.collection("giftCardRateLimits").doc(documentId);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const state = nextRateLimitState(
      snapshot.exists ? snapshot.data() as Partial<RateLimitState> : undefined,
      now,
      rules,
      weight
    );
    transaction.set(reference, {
      ...state,
      expiresAt: Timestamp.fromMillis(state.dayWindowStart + 2 * DAY_MS)
    });
  });
}
