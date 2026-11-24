import type { ProductionEnv } from "./types.js";

const studioTimeZone = "America/Vancouver";
const studioMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: studioTimeZone,
  year: "numeric",
  month: "2-digit"
});
const studioOffset = new Intl.DateTimeFormat("en-CA", {
  timeZone: studioTimeZone,
  timeZoneName: "longOffset"
});

interface SalesTotals {
  confirmedRevenueCents: number;
  outstandingBalanceCents: number;
  totalRedeemedCents: number;
}

interface MonthlyRevenue {
  month: string;
  revenueCents: number;
}

function monthStart(year: number, month: number): string {
  const utc = new Date(Date.UTC(year, month, 1));
  // UTC midnight precedes Vancouver midnight and sees the same offset.
  const offset = studioOffset.formatToParts(utc).find((part) => part.type === "timeZoneName")!.value;
  return new Date(`${utc.toISOString().slice(0, 10)}T00:00:00${offset.slice(3)}`).toISOString();
}

export async function getSales(env: ProductionEnv, now = new Date()) {
  const parts = studioMonth.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value) - 1;
  const starts = Array.from({ length: 13 }, (_, index) => monthStart(year, month - 11 + index));
  const monthRanges = starts.slice(0, -1).flatMap((start, index) => [
    new Date(Date.UTC(year, month - 11 + index, 1)).toISOString().slice(0, 7),
    start,
    starts[index + 1]
  ]);

  const [totals, history] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        (SELECT COALESCE(SUM(amount_cents), 0) FROM gift_card_orders
         WHERE payment_status = 'paid' AND payment_verified_at IS NOT NULL
           AND payment_verified_by IS NOT NULL AND environment = 'production'
           AND test_only = 0) AS confirmedRevenueCents,
        (SELECT COALESCE(SUM(balance_cents), 0) FROM gift_certificates
         WHERE environment = 'production' AND test_only = 0) AS outstandingBalanceCents,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM gift_card_redemptions
         WHERE deduction_applied = 1 AND environment = 'production'
           AND test_only = 0) AS totalRedeemedCents
    `),
    env.DB.prepare(`
      WITH months(month, starts_at, ends_at) AS
        (VALUES ${starts.slice(0, -1).map(() => "(?, ?, ?)").join(", ")})
      SELECT month, (
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM gift_card_orders
        WHERE payment_status = 'paid' AND payment_verified_by IS NOT NULL
          AND environment = 'production' AND test_only = 0
          AND payment_verified_at >= starts_at AND payment_verified_at < ends_at
      ) AS revenueCents
      FROM months ORDER BY month
    `).bind(...monthRanges)
  ]);
  const monthlyRevenue = history.results as MonthlyRevenue[];
  return {
    ...totals.results[0] as SalesTotals,
    thisMonthRevenueCents: monthlyRevenue.at(-1)?.revenueCents ?? 0,
    monthlyRevenue
  };
}
