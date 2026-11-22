const pool = require("../config/database");

const DEFAULT_RUPIAH_PER_POINT = 10_000;
const MAX_INTEGER_POINTS = 2_147_483_647;

class LoyaltyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const getRupiahPerPoint = () => {
  const configuredValue = process.env.LOYALTY_RUPIAH_PER_POINT;
  const rupiahPerPoint =
    configuredValue === undefined
      ? DEFAULT_RUPIAH_PER_POINT
      : Number(configuredValue);

  if (!Number.isSafeInteger(rupiahPerPoint) || rupiahPerPoint <= 0) {
    throw new Error("LOYALTY_RUPIAH_PER_POINT must be a positive integer");
  }

  return rupiahPerPoint;
};

const calculateEarnedPoints = (totalPrice, rupiahPerPoint) => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(totalPrice));
  if (!match) {
    throw new Error("Booking total_price is not a valid monetary amount");
  }

  const fractionalCents = (match[2] || "").padEnd(2, "0");
  const totalCents =
    BigInt(match[1]) * 100n + BigInt(fractionalCents || "0");
  const centsPerPoint = BigInt(rupiahPerPoint) * 100n;
  const points = totalCents / centsPerPoint;

  if (points > BigInt(MAX_INTEGER_POINTS)) {
    throw new Error("Earned loyalty points exceed the database integer range");
  }

  return Number(points);
};

const getSafeBalance = (value) => {
  const balance = Number(value);
  if (!Number.isSafeInteger(balance)) {
    throw new Error("Loyalty point balance exceeds the safe integer range");
  }
  return balance;
};

const getBalance = async (userId) => {
  const result = await pool.query(
    `SELECT COALESCE(SUM(points), 0)::bigint AS balance
     FROM loyalty_points
     WHERE user_id = $1`,
    [userId]
  );
  return getSafeBalance(result.rows[0].balance);
};

const getHistory = async (userId, limit, offset) => {
  const result = await pool.query(
    `SELECT id, booking_id, transaction_type, points, description, created_at
     FROM loyalty_points
     WHERE user_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return result.rows;
};

const awardCompletedBookingPoints = async (client, bookingId) => {
  const bookingResult = await client.query(
    `SELECT b.customer_id, b.total_price::text AS total_price
     FROM bookings b
     JOIN users u ON u.id = b.customer_id AND u.role = 'customer'
     WHERE b.id = $1
       AND b.status = 'completed'
     FOR UPDATE OF b`,
    [bookingId]
  );

  if (bookingResult.rows.length === 0) {
    return null;
  }

  const points = calculateEarnedPoints(
    bookingResult.rows[0].total_price,
    getRupiahPerPoint()
  );
  if (points === 0) {
    return null;
  }

  const result = await client.query(
    `INSERT INTO loyalty_points (
       user_id, booking_id, transaction_type, points, description
     )
     VALUES ($1, $2, 'earn', $3, 'Poin booking selesai')
     ON CONFLICT (booking_id)
       WHERE transaction_type = 'earn' AND booking_id IS NOT NULL
     DO NOTHING
     RETURNING id, booking_id, transaction_type, points, description, created_at`,
    [bookingResult.rows[0].customer_id, bookingId, points]
  );

  return result.rows[0] || null;
};

const redeemPoints = async (userId, pointsToRedeem) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const userResult = await client.query(
      `SELECT id
       FROM users
       WHERE id = $1 AND role = 'customer' AND is_active = TRUE
       FOR UPDATE`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      throw new LoyaltyError(403, "Akun customer tidak aktif");
    }

    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(points), 0)::bigint AS balance
       FROM loyalty_points
       WHERE user_id = $1`,
      [userId]
    );
    const balance = getSafeBalance(balanceResult.rows[0].balance);
    if (balance < 0) {
      throw new Error("Loyalty point balance cannot be negative");
    }
    if (pointsToRedeem > balance) {
      throw new LoyaltyError(409, "Saldo poin tidak mencukupi");
    }

    const transactionResult = await client.query(
      `INSERT INTO loyalty_points (
         user_id, transaction_type, points, description
       )
       VALUES ($1, 'redeem', $2, 'Penukaran poin')
       RETURNING id, booking_id, transaction_type, points, description, created_at`,
      [userId, -pointsToRedeem]
    );
    if (transactionResult.rows.length === 0) {
      throw new Error("Loyalty redemption was not recorded");
    }

    const newBalance = balance - pointsToRedeem;
    await client.query("COMMIT");
    transactionStarted = false;
    return {
      transaction: transactionResult.rows[0],
      balance: newBalance,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Redeem loyalty points rollback error:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  LoyaltyError,
  awardCompletedBookingPoints,
  calculateEarnedPoints,
  getBalance,
  getHistory,
  getRupiahPerPoint,
  redeemPoints,
};
