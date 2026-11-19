
CREATE TABLE IF NOT EXISTS loyalty_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,
    booking_id UUID,

    transaction_type VARCHAR(20) NOT NULL
        CHECK (transaction_type IN ('earn', 'redeem', 'adjustment')),

    points INTEGER NOT NULL
        CHECK (points <> 0),

    description TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_loyalty_user
        FOREIGN KEY (user_id)
        REFERENCES users(id),

    CONSTRAINT fk_loyalty_booking
        FOREIGN KEY (booking_id)
        REFERENCES bookings(id)
);

CREATE INDEX idx_loyalty_user ON loyalty_points(user_id);
CREATE INDEX idx_loyalty_booking ON loyalty_points(booking_id);
