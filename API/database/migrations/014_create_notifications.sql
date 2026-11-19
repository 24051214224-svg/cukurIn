
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL,

    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,

    notification_type VARCHAR(30) NOT NULL
        CHECK (notification_type IN (
            'booking', 'queue', 'payment',
            'promotion', 'system'
        )),

    is_read BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_notifications_user_read
ON notifications(user_id, is_read);
