
CREATE TABLE IF NOT EXISTS hairstyles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hairstyle_name VARCHAR(100) NOT NULL,
    description TEXT,

    face_shape VARCHAR(30) NOT NULL
        CHECK (face_shape IN (
            'oval', 'round', 'square',
            'heart', 'oblong', 'diamond', 'all'
        )),

    hair_type VARCHAR(30) NOT NULL
        CHECK (hair_type IN (
            'straight', 'wavy', 'curly', 'coily', 'all'
        )),

    image_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_hairstyles_criteria
ON hairstyles(face_shape, hair_type);

