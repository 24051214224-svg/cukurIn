
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id UUID NOT NULL,
    barber_id UUID NOT NULL,

    booking_code VARCHAR(30) NOT NULL UNIQUE,

    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'confirmed',
            'in_progress',
            'completed',
            'cancelled',
            'no_show'
        )),

    total_price NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (total_price >= 0),

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_bookings_customer
        FOREIGN KEY (customer_id) REFERENCES users(id),

    CONSTRAINT fk_bookings_barber
        FOREIGN KEY (barber_id) REFERENCES barbers(id),

    CONSTRAINT chk_booking_time
        CHECK (end_at > start_at)
);

CREATE INDEX idx_bookings_customer ON bookings(customer_id);
CREATE INDEX idx_bookings_barber_time ON bookings(barber_id, start_at);
CREATE INDEX idx_bookings_status ON bookings(status);
