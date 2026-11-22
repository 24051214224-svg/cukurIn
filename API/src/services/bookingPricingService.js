const HttpError = require("../utils/HttpError");

const loadActiveServices = async (client, items) => {
  const serviceIds = items.map((item) => item.service_id);
  const result = await client.query(
    `SELECT id, service_name, price, duration_minutes
     FROM services
     WHERE id = ANY($1::uuid[]) AND is_active = TRUE
     ORDER BY id
     FOR SHARE`,
    [serviceIds]
  );

  if (result.rows.length !== items.length) {
    throw new HttpError(409, "Satu atau lebih layanan tidak aktif");
  }

  const servicesById = new Map(
    result.rows.map((service) => [service.id, service])
  );
  const itemSnapshots = items.map((item) => {
    const service = servicesById.get(item.service_id);
    return { ...service, quantity: item.quantity };
  });

  const totalDuration = itemSnapshots.reduce(
    (total, item) => total + Number(item.duration_minutes) * item.quantity,
    0
  );

  if (!Number.isSafeInteger(totalDuration) || totalDuration <= 0) {
    throw new HttpError(409, "Durasi layanan tidak valid");
  }

  const totalPriceCents = itemSnapshots.reduce((total, item) => {
    const [whole, fraction = ""] = String(item.price).split(".");
    const unitPriceCents =
      Number(whole) * 100 +
      Number(fraction.padEnd(2, "0").slice(0, 2));
    return total + unitPriceCents * item.quantity;
  }, 0);

  if (!Number.isSafeInteger(totalPriceCents)) {
    throw new HttpError(409, "Total harga layanan di luar batas");
  }

  return {
    itemSnapshots,
    totalDuration,
    totalPriceCents,
    totalPrice: (totalPriceCents / 100).toFixed(2),
  };
};

module.exports = { loadActiveServices };
