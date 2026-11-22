const pool = require("../config/database");
const HttpError = require("../utils/HttpError");
const { loadActiveServices } = require("../services/bookingPricingService");
const { previewVoucher } = require("../services/voucherService");
const {
  voucherIdSchema,
  createVoucherSchema,
  updateVoucherSchema,
  voucherDefinitionSchema,
  validateVoucherSchema,
} = require("../validators/voucherValidator");

const withTransaction = async (operation, label) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error(`${label} rollback error:`, rollbackError.message);
    }

    throw error;
  } finally {
    client.release();
  }
};

const respondError = (res, error, operation, message) => {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
    });
  }

  if (error.code === "23505") {
    return res.status(409).json({
      success: false,
      message: "Kode voucher sudah digunakan",
    });
  }

  console.error(`${operation} error:`, error.message);
  return res.status(500).json({ success: false, message });
};

const parseRequest = (schema, input, res, message) => {
  const validation = schema.safeParse(input);
  if (!validation.success) {
    res.status(400).json({
      success: false,
      message,
      errors: validation.error.issues,
    });
    return null;
  }
  return validation.data;
};

const getVouchers = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, description, discount_type, discount_value,
              minimum_transaction, max_discount, usage_limit, used_count,
              start_at, end_at, is_active, created_at
       FROM vouchers
       ORDER BY created_at DESC, id ASC`
    );
    return res.status(200).json({
      success: true,
      message: "Daftar voucher berhasil diambil",
      data: result.rows,
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Get vouchers",
      "Gagal mengambil daftar voucher"
    );
  }
};

const getVoucherById = async (req, res) => {
  const id = parseRequest(
    voucherIdSchema,
    req.params.id,
    res,
    "ID voucher tidak valid"
  );
  if (!id) return;

  try {
    const result = await pool.query(
      `SELECT id, code, description, discount_type, discount_value,
              minimum_transaction, max_discount, usage_limit, used_count,
              start_at, end_at, is_active, created_at
       FROM vouchers
       WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      throw new HttpError(404, "Voucher tidak ditemukan");
    }
    return res.status(200).json({
      success: true,
      message: "Detail voucher berhasil diambil",
      data: result.rows[0],
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Get voucher",
      "Gagal mengambil detail voucher"
    );
  }
};

const createVoucher = async (req, res) => {
  const voucher = parseRequest(
    createVoucherSchema,
    req.body,
    res,
    "Data voucher tidak valid"
  );
  if (!voucher) return;

  try {
    const result = await pool.query(
      `INSERT INTO vouchers (
         code, description, discount_type, discount_value,
         minimum_transaction, max_discount, usage_limit,
         start_at, end_at, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, code, description, discount_type, discount_value,
                 minimum_transaction, max_discount, usage_limit, used_count,
                 start_at, end_at, is_active, created_at`,
      [
        voucher.code,
        voucher.description ?? null,
        voucher.discount_type,
        voucher.discount_value,
        voucher.minimum_transaction,
        voucher.max_discount ?? null,
        voucher.usage_limit,
        voucher.start_at,
        voucher.end_at,
        voucher.is_active,
      ]
    );
    return res.status(201).json({
      success: true,
      message: "Voucher berhasil dibuat",
      data: result.rows[0],
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Create voucher",
      "Gagal membuat voucher"
    );
  }
};

const updateVoucher = async (req, res) => {
  const id = parseRequest(
    voucherIdSchema,
    req.params.id,
    res,
    "ID voucher tidak valid"
  );
  if (!id) return;
  const changes = parseRequest(
    updateVoucherSchema,
    req.body,
    res,
    "Data perubahan voucher tidak valid"
  );
  if (!changes) return;

  try {
    const voucher = await withTransaction(async (client) => {
      const currentResult = await client.query(
        `SELECT id, code, description, discount_type, discount_value,
                minimum_transaction, max_discount, usage_limit, used_count,
                start_at, end_at, is_active
         FROM vouchers
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (currentResult.rows.length === 0) {
        throw new HttpError(404, "Voucher tidak ditemukan");
      }

      const current = currentResult.rows[0];
      const merged = {
        code: current.code,
        description: current.description,
        discount_type: current.discount_type,
        discount_value: Number(current.discount_value),
        minimum_transaction: Number(current.minimum_transaction),
        max_discount:
          current.max_discount === null
            ? null
            : Number(current.max_discount),
        usage_limit: Number(current.usage_limit),
        start_at: new Date(current.start_at).toISOString(),
        end_at: new Date(current.end_at).toISOString(),
        is_active: current.is_active,
        ...changes,
      };

      if (
        changes.discount_type === "fixed" &&
        !Object.prototype.hasOwnProperty.call(changes, "max_discount")
      ) {
        merged.max_discount = null;
      }

      const definition = voucherDefinitionSchema.safeParse(merged);
      if (!definition.success) {
        throw new HttpError(400, definition.error.issues[0].message);
      }
      if (definition.data.usage_limit < Number(current.used_count)) {
        throw new HttpError(
          409,
          "Batas penggunaan tidak boleh lebih kecil dari pemakaian saat ini"
        );
      }

      const updatedResult = await client.query(
        `UPDATE vouchers
         SET code = $1,
             description = $2,
             discount_type = $3,
             discount_value = $4,
             minimum_transaction = $5,
             max_discount = $6,
             usage_limit = $7,
             start_at = $8,
             end_at = $9,
             is_active = $10
         WHERE id = $11
         RETURNING id, code, description, discount_type, discount_value,
                   minimum_transaction, max_discount, usage_limit, used_count,
                   start_at, end_at, is_active, created_at`,
        [
          definition.data.code,
          definition.data.description ?? null,
          definition.data.discount_type,
          definition.data.discount_value,
          definition.data.minimum_transaction,
          definition.data.max_discount ?? null,
          definition.data.usage_limit,
          definition.data.start_at,
          definition.data.end_at,
          definition.data.is_active,
          id,
        ]
      );
      return updatedResult.rows[0];
    }, "Update voucher");

    return res.status(200).json({
      success: true,
      message: "Voucher berhasil diperbarui",
      data: voucher,
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Update voucher",
      "Gagal memperbarui voucher"
    );
  }
};

const validateVoucher = async (req, res) => {
  const input = parseRequest(
    validateVoucherSchema,
    req.body,
    res,
    "Data validasi voucher tidak valid"
  );
  if (!input) return;

  try {
    const { totalPriceCents } = await loadActiveServices(pool, input.items);
    const result = await previewVoucher(pool, input.code, totalPriceCents);
    return res.status(200).json({
      success: true,
      message: "Voucher valid untuk transaksi ini",
      data: {
        valid: true,
        code: result.voucher.code,
        discount_type: result.voucher.discount_type,
        discount_value: result.voucher.discount_value,
        subtotal: (totalPriceCents / 100).toFixed(2),
        discount_amount: result.discountAmount,
        total_price: result.totalPrice,
      },
    });
  } catch (error) {
    return respondError(
      res,
      error,
      "Validate voucher",
      "Gagal memvalidasi voucher"
    );
  }
};

module.exports = {
  getVouchers,
  getVoucherById,
  createVoucher,
  updateVoucher,
  validateVoucher,
};
