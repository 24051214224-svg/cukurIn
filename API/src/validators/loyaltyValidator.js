const { z } = require("zod");

const MAX_INTEGER_POINTS = 2_147_483_647;

const loyaltyHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const redeemPointsSchema = z
  .object({
    points: z.number().int().min(1).max(MAX_INTEGER_POINTS),
  })
  .strict();

module.exports = {
  loyaltyHistoryQuerySchema,
  redeemPointsSchema,
};
