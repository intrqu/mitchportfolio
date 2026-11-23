import type { AdminIdentity } from "../types.js";

export interface ProductionEnv {
  DB: D1Database;
  APP_ENV: string;
  FIREBASE_PROJECT_ID: string;
  PUBLIC_SITE_ORIGIN: string;
  PUBLIC_SITE_URL: string;
  TURNSTILE_EXPECTED_HOSTNAME: string;
  EMAIL_FROM: string;
  ORDERS_ENABLED: string;
  MAX_ORDERS_PER_DAY: string;
  MAX_ORDER_AMOUNT_CENTS: string;
  EMAIL_DAILY_LIMIT: string;
  PRODUCTION_ADMIN_EMAILS: string;
  PRODUCTION_INTERAC_EMAIL: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  CERTIFICATE_ENCRYPTION_KEY: string;
  RATE_LIMIT_HMAC_KEY: string;
}

export interface ProductionOrder {
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
  payment_method: "interac_transfer";
  payment_status: "pending_payment" | "payment_reported" | "paid";
  certificate_status: "not_issued" | "issued" | "partially_redeemed" | "redeemed";
  remaining_balance_cents: number | null;
  environment: "production";
  test_only: 0;
  payment_reported_at: string | null;
  payment_verified_at: string | null;
  payment_verified_by: string | null;
  payment_confirmation_note: string;
  order_email_sent_at: string | null;
  admin_email_sent_at: string | null;
  payment_email_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionCertificate {
  code_hash: string;
  order_id: string;
  encrypted_code: string;
  code_iv: string;
  code_auth_tag: string;
  encryption_key_version: number;
  recipient_name: string;
  recipient_email: string;
  initial_value_cents: number;
  balance_cents: number;
  status: "issued" | "partially_redeemed" | "redeemed";
  environment: "production";
  test_only: 0;
  email_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionDependencies {
  verifyAdminToken?: (token: string, projectId: string) => Promise<AdminIdentity>;
  fetcher?: typeof fetch;
}
