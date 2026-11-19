
CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    service_name VARCHAR(100) NOT NULL,
    description TEXT,

    price NUMERIC(12, 2) NOT NULL
        CHECK (price >= 0),

    duration_minutes INTEGER NOT NULL
        CHECK (duration_minutes > 0),

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_services_active
ON services(is_active);

CREATE INDEX idx_services_name
ON services(service_name);
