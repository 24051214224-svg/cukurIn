const HttpError = require("../utils/HttpError");

const normalizeVoucherCode = (code) => code.trim().toUpperCase();

const decimalToCents = (value) => {
  const [whole, fraction = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
};

const loadVoucher = async (client, code, { forUpdate = false } = {}) => {
  const result = await client.query(
    `SELECT id, code, description, discount_type, discount_value,
            minimum_transaction, max_discount, usage_limit, used_count,
            start_at, end_at, is_active, CURRENT_TIMESTAMP AS evaluated_at
     FROM vouchers
     WHERE code = $1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [normalizeVoucherCode(code)]
  );

  if (result.rows.length === 0) {
    throw new HttpError(404, "Voucher tidak ditemukan");
  }

  return result.rows[0];
};

const calculateVoucherPrice = (voucher, subtotalCents) => {
  if (!voucher.is_active) {
    throw new HttpError(409, "Voucher tidak aktif");
  }

  const now = new Date(voucher.evaluated_at || Date.now()).getTime();
  if (
    now < new Date(voucher.start_at).getTime() ||
    now >= new Date(voucher.end_at).getTime()
  ) {
    throw new HttpError(409, "Voucher berada di luar periode berlaku");
  }

  if (Number(voucher.used_count) >= Number(voucher.usage_limit)) {
    throw new HttpError(409, "Kuota voucher telah habis");
  }

  if (subtotalCents < decimalToCents(voucher.minimum_transaction)) {
    throw new HttpError(409, "Transaksi belum memenuhi minimum voucher");
  }

  let discountCents;
  if (voucher.discount_type === "percentage") {
    const percentageBasisPoints = decimalToCents(voucher.discount_value);
    discountCents = Number(
      (BigInt(subtotalCents) * BigInt(percentageBasisPoints) + 5000n) / 10000n
    );
    if (voucher.max_discount !== null) {
      discountCents = Math.min(
        discountCents,
        decimalToCents(voucher.max_discount)
      );
    }
  } else {
    discountCents = decimalToCents(voucher.discount_value);
  }

  discountCents = Math.min(subtotalCents, Math.max(0, discountCents));
  return {
    discountCents,
    discountAmount: (discountCents / 100).toFixed(2),
    totalPriceCents: subtotalCents - discountCents,
    totalPrice: ((subtotalCents - discountCents) / 100).toFixed(2),
  };
};

const previewVoucher = async (client, code, subtotalCents) => {
  const voucher = await loadVoucher(client, code);
  return {
    voucher,
    ...calculateVoucherPrice(voucher, subtotalCents),
  };
};

const reserveVoucher = async (client, code, subtotalCents) => {
  const voucher = await loadVoucher(client, code, { forUpdate: true });
  const price = calculateVoucherPrice(voucher, subtotalCents);
  const result = await client.query(
    `UPDATE vouchers
     SET used_count = used_count + 1
     WHERE id = $1 AND used_count < usage_limit
     RETURNING used_count`,
    [voucher.id]
  );

  if (result.rows.length === 0) {
    throw new HttpError(409, "Kuota voucher telah habis");
  }

  return { voucher, ...price };
};

const releaseVoucherUsage = async (client, voucherId) => {
  const result = await client.query(
    `UPDATE vouchers
     SET used_count = used_count - 1
     WHERE id = $1 AND used_count > 0
     RETURNING id`,
    [voucherId]
  );

  if (result.rows.length === 0) {
    throw new Error("Voucher usage counter is inconsistent");
  }
};

module.exports = {
  normalizeVoucherCode,
  calculateVoucherPrice,
  previewVoucher,
  reserveVoucher,
  releaseVoucherUsage,
};
