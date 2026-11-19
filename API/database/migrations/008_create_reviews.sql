
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL UNIQUE,
    customer_id UUID NOT NULL,
    barber_id UUID NOT NULL,

    rating SMALLINT NOT NULL
        CHECK (rating BETWEEN 1 AND 5),

    comment TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_reviews_booking
        FOREIGN KEY (booking_id) REFERENCES bookings(id),

    CONSTRAINT fk_reviews_customer
        FOREIGN KEY (customer_id) REFERENCES users(id),

    CONSTRAINT fk_reviews_barber
        FOREIGN KEY (barber_id) REFERENCES barbers(id)
);

CREATE INDEX idx_reviews_barber ON reviews(barber_id);

