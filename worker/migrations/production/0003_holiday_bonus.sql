ALTER TABLE gift_card_orders ADD COLUMN bonus_cents INTEGER NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0);
