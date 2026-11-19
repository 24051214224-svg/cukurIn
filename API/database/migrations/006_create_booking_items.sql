
CREATE TABLE IF NOT EXISTS booking_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL,
    service_id UUID NOT NULL,

    service_name VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1
        CHECK (quantity > 0),

    unit_price NUMERIC(12,2) NOT NULL
        CHECK (unit_price >= 0),

    duration_minutes INTEGER NOT NULL
        CHECK (duration_minutes > 0),

    subtotal NUMERIC(12,2) GENERATED ALWAYS AS
        (quantity * unit_price) STORED,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_booking_items_booking
        FOREIGN KEY (booking_id)
        REFERENCES bookings(id) ON DELETE CASCADE,

    CONSTRAINT fk_booking_items_service
        FOREIGN KEY (service_id)
        REFERENCES services(id) ON DELETE RESTRICT
);

CREATE INDEX idx_booking_items_booking ON booking_items(booking_id);
