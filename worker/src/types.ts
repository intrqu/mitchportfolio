export interface Env {
  DB: D1Database;
  ORDER_RATE_LIMIT: RateLimit;
  APP_ENV: string;
  FIREBASE_PROJECT_ID: string;
  PUBLIC_SITE_ORIGIN: string;
  PUBLIC_SITE_URL: string;
  TURNSTILE_EXPECTED_HOSTNAME: string;
  EMAIL_FROM: string;
  STAGING_ALLOWED_EMAILS: string;
  STAGING_ADMIN_EMAILS: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  CERTIFICATE_ENCRYPTION_KEY: string;
  RATE_LIMIT_HMAC_KEY: string;
}

export interface AdminIdentity {
  uid: string;
  admin: boolean;
  email?: string;
}

export interface NewOrder {
  amountCents: number;
  purchaserName: string;
  purchaserEmail: string;
  recipientName: string;
  recipientEmail: string;
  recipientType: "self" | "other";
  message: string;
}

export interface GiftCardOrder extends NewOrder {
  id: string;
  orderRef: string;
  paymentStatus: "pending_payment" | "paid";
  certificateStatus: "not_issued" | "issued" | "partially_redeemed" | "redeemed";
  remainingBalanceCents: number | null;
  testOnly: true;
  paymentVerifiedAt: string | null;
  paymentVerifiedBy: string | null;
  orderEmailSentAt: string | null;
  adminEmailSentAt: string | null;
  paymentEmailSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}
