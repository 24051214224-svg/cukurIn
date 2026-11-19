
CREATE TABLE IF NOT EXISTS queues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL UNIQUE,
    barber_id UUID NOT NULL,

    queue_date DATE NOT NULL,
    queue_number INTEGER NOT NULL
        CHECK (queue_number > 0),

    status VARCHAR(20) NOT NULL DEFAULT 'waiting'
        CHECK (status IN (
            'waiting',
            'called',
            'serving',
            'completed',
            'cancelled'
        )),

    estimated_start_at TIMESTAMPTZ,
    estimated_end_at TIMESTAMPTZ,

    qr_token UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    checked_in_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_queues_booking
        FOREIGN KEY (booking_id)
        REFERENCES bookings(id) ON DELETE CASCADE,

    CONSTRAINT fk_queues_barber
        FOREIGN KEY (barber_id)
        REFERENCES barbers(id),

    CONSTRAINT uq_barber_queue_number
        UNIQUE (barber_id, queue_date, queue_number)
);

CREATE INDEX idx_queues_barber_date
ON queues(barber_id, queue_date);

CREATE INDEX idx_queues_status
ON queues(status);

