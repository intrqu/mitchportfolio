CREATE TABLE gift_card_orders (
  id TEXT PRIMARY KEY,
  order_ref TEXT NOT NULL UNIQUE,
  idempotency_hash TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL,
  purchaser_name TEXT NOT NULL,
  purchaser_email TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('self', 'other')),
  message TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_method TEXT NOT NULL CHECK (payment_method = 'interac_transfer'),
  payment_status TEXT NOT NULL CHECK (
    payment_status IN ('pending_payment', 'payment_reported', 'paid')
  ),
  certificate_status TEXT NOT NULL CHECK (
    certificate_status IN ('not_issued', 'issued', 'partially_redeemed', 'redeemed')
  ),
  remaining_balance_cents INTEGER,
  environment TEXT NOT NULL CHECK (environment = 'production'),
  test_only INTEGER NOT NULL DEFAULT 0 CHECK (test_only = 0),
  payment_reported_at TEXT,
  payment_verified_at TEXT,
  payment_verified_by TEXT,
  payment_confirmation_note TEXT NOT NULL DEFAULT '',
  order_email_sent_at TEXT,
  admin_email_sent_at TEXT,
  payment_email_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (payment_status = 'paid' AND payment_verified_at IS NOT NULL AND payment_verified_by IS NOT NULL)
    OR
    (payment_status != 'paid' AND payment_verified_at IS NULL AND payment_verified_by IS NULL)
  ),
  CHECK (
    (certificate_status = 'not_issued' AND remaining_balance_cents IS NULL)
    OR
    (certificate_status != 'not_issued' AND remaining_balance_cents IS NOT NULL)
  )
);

CREATE INDEX gift_card_orders_created_at ON gift_card_orders(created_at DESC, id DESC);
CREATE INDEX gift_card_orders_payment_status ON gift_card_orders(payment_status, certificate_status);

CREATE TABLE gift_certificates (
  code_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES gift_card_orders(id),
  encrypted_code TEXT NOT NULL,
  code_iv TEXT NOT NULL,
  code_auth_tag TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1 CHECK (encryption_key_version = 1),
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  initial_value_cents INTEGER NOT NULL CHECK (initial_value_cents > 0),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('issued', 'partially_redeemed', 'redeemed')),
  environment TEXT NOT NULL CHECK (environment = 'production'),
  test_only INTEGER NOT NULL DEFAULT 0 CHECK (test_only = 0),
  email_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE gift_card_redemptions (
  request_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL REFERENCES gift_certificates(code_hash),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),
  note TEXT NOT NULL DEFAULT '',
  redeemed_by TEXT NOT NULL,
  deduction_applied INTEGER NOT NULL DEFAULT 0 CHECK (deduction_applied IN (0, 1)),
  environment TEXT NOT NULL CHECK (environment = 'production'),
  test_only INTEGER NOT NULL DEFAULT 0 CHECK (test_only = 0),
  created_at TEXT NOT NULL
);

CREATE INDEX gift_card_redemptions_code_date
  ON gift_card_redemptions(code_hash, created_at DESC);

CREATE TABLE gift_card_ip_limits (
  ip_hash TEXT PRIMARY KEY,
  minute_window INTEGER NOT NULL,
  minute_count INTEGER NOT NULL,
  day_window TEXT NOT NULL,
  day_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE gift_card_global_limits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  order_day TEXT NOT NULL,
  order_count INTEGER NOT NULL,
  email_day TEXT NOT NULL,
  email_count INTEGER NOT NULL
);

INSERT INTO gift_card_global_limits (id, order_day, order_count, email_day, email_count)
VALUES (1, '', 0, '', 0);

CREATE TABLE gift_card_email_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES gift_card_orders(id),
  email_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('sending', 'sent', 'failed')),
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX gift_card_email_deliveries_order
  ON gift_card_email_deliveries(order_id, email_type);
