
CREATE TABLE IF NOT EXISTS portfolios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    barber_id UUID NOT NULL,

    title VARCHAR(150) NOT NULL,
    description TEXT,
    image_url TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_portfolios_barber
        FOREIGN KEY (barber_id)
        REFERENCES barbers(id) ON DELETE CASCADE
);

CREATE INDEX idx_portfolios_barber ON portfolios(barber_id);
