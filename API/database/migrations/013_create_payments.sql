
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL UNIQUE,

    amount NUMERIC(12,2) NOT NULL
        CHECK (amount >= 0),

    payment_method VARCHAR(30) NOT NULL
        CHECK (payment_method IN (
            'cash', 'transfer', 'qris', 'other'
        )),

    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (payment_status IN (
            'pending', 'paid', 'failed', 'refunded'
        )),

    transaction_reference VARCHAR(150),

    paid_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_payments_booking
        FOREIGN KEY (booking_id)
        REFERENCES bookings(id)
);

CREATE INDEX idx_payments_status ON payments(payment_status);
