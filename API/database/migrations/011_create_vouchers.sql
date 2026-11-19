
CREATE TABLE IF NOT EXISTS vouchers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    code VARCHAR(30) NOT NULL UNIQUE,
    description TEXT,

    discount_type VARCHAR(20) NOT NULL
        CHECK (discount_type IN ('percentage', 'fixed')),

    discount_value NUMERIC(12,2) NOT NULL
        CHECK (discount_value > 0),

    minimum_transaction NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (minimum_transaction >= 0),

    max_discount NUMERIC(12,2),

    usage_limit INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,

    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_voucher_period CHECK (end_at > start_at),
    CONSTRAINT chk_voucher_usage CHECK (
        usage_limit IS NULL OR usage_limit >= 0
    ),
    CONSTRAINT chk_voucher_used CHECK (used_count >= 0)
);

ALTER TABLE bookings
ADD COLUMN voucher_id UUID;

ALTER TABLE bookings
ADD CONSTRAINT fk_bookings_voucher
FOREIGN KEY (voucher_id)
REFERENCES vouchers(id) ON DELETE SET NULL;

CREATE INDEX idx_vouchers_active ON vouchers(is_active);
