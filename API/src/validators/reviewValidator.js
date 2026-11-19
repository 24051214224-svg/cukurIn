const { z } = require("zod");

const reviewIdSchema = z.string().uuid();
const barberIdSchema = z.string().uuid();
const createReviewSchema = z
  .object({
    booking_id: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

module.exports = {
  reviewIdSchema,
  barberIdSchema,
  createReviewSchema,
};
