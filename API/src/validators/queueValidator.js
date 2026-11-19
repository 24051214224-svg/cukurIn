const { z } = require("zod");

const queueIdSchema = z.string().uuid();
const barberIdSchema = z.string().uuid();
const qrTokenSchema = z.string().uuid();

const checkInByTokenSchema = z
  .object({
    qr_token: qrTokenSchema,
  })
  .strict();

module.exports = {
  queueIdSchema,
  barberIdSchema,
  qrTokenSchema,
  checkInByTokenSchema,
};
