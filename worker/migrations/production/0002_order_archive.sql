ALTER TABLE gift_card_orders ADD COLUMN archived_at TEXT;
ALTER TABLE gift_card_orders ADD COLUMN archived_by TEXT;

CREATE INDEX gift_card_orders_verified_at ON gift_card_orders(payment_verified_at)
  WHERE payment_status = 'paid';
CREATE INDEX gift_card_orders_archive_created_at
  ON gift_card_orders((archived_at IS NOT NULL), created_at DESC, id DESC);
