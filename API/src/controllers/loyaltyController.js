const {
  LoyaltyError,
  getBalance,
  getHistory,
  redeemPoints,
} = require("../services/loyaltyService");
const {
  loyaltyHistoryQuerySchema,
  redeemPointsSchema,
} = require("../validators/loyaltyValidator");

const respondWithError = (res, error, operation, message) => {
  if (error instanceof LoyaltyError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  console.error(`${operation} error:`, error.message);
  return res.status(500).json({
    success: false,
    message,
  });
};

const getLoyaltyBalance = async (req, res) => {
  try {
    const balance = await getBalance(req.user.id);
    return res.status(200).json({
      success: true,
      message: "Saldo poin berhasil diambil",
      data: { balance },
    });
  } catch (error) {
    return respondWithError(
      res,
      error,
      "Get loyalty balance",
      "Gagal mengambil saldo poin"
    );
  }
};

const getLoyaltyHistory = async (req, res) => {
  const validation = loyaltyHistoryQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Parameter riwayat poin tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const { limit, offset } = validation.data;
    const transactions = await getHistory(req.user.id, limit, offset);
    return res.status(200).json({
      success: true,
      message: "Riwayat poin berhasil diambil",
      data: { transactions, pagination: { limit, offset } },
    });
  } catch (error) {
    return respondWithError(
      res,
      error,
      "Get loyalty history",
      "Gagal mengambil riwayat poin"
    );
  }
};

const redeemLoyaltyPoints = async (req, res) => {
  const validation = redeemPointsSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      success: false,
      message: "Jumlah poin penukaran tidak valid",
      errors: validation.error.issues,
    });
  }

  try {
    const result = await redeemPoints(req.user.id, validation.data.points);
    return res.status(201).json({
      success: true,
      message: "Poin berhasil ditukar",
      data: result,
    });
  } catch (error) {
    return respondWithError(
      res,
      error,
      "Redeem loyalty points",
      "Gagal menukar poin"
    );
  }
};

module.exports = {
  getLoyaltyBalance,
  getLoyaltyHistory,
  redeemLoyaltyPoints,
};
