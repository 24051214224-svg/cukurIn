
CREATE TABLE IF NOT EXISTS schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    barber_id UUID NOT NULL,

    day_of_week SMALLINT NOT NULL
        CHECK (day_of_week BETWEEN 0 AND 6),

    start_time TIME NOT NULL,
    end_time TIME NOT NULL,

    is_available BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_schedules_barber
        FOREIGN KEY (barber_id)
        REFERENCES barbers(id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_schedule_time
        CHECK (end_time > start_time),

    CONSTRAINT uq_barber_schedule
        UNIQUE (barber_id, day_of_week, start_time)
);

CREATE INDEX idx_schedules_barber_day
ON schedules(barber_id, day_of_week);

CREATE INDEX idx_schedules_availability
ON schedules(is_available);
