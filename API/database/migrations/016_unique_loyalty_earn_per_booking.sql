CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_points_earn_booking_unique
ON loyalty_points (booking_id)
WHERE transaction_type = 'earn'
  AND booking_id IS NOT NULL;
