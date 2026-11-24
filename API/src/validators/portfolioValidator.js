const { z } = require("zod");

const barberIdSchema = z.string().uuid();
const portfolioIdSchema = z.string().uuid();

const barberPortfolioParamsSchema = z
  .object({
    barberId: barberIdSchema,
  })
  .strict();

const portfolioParamsSchema = z
  .object({
    barberId: barberIdSchema,
    portfolioId: portfolioIdSchema,
  })
  .strict();

const portfolioIdParamsSchema = z
  .object({
    id: portfolioIdSchema,
  })
  .strict();

const portfolioWriteSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    description: z.string().trim().nullable().optional(),
    image_url: z.string().url({ protocol: /^https?$/i }),
  })
  .strict();

module.exports = {
  barberPortfolioParamsSchema,
  portfolioParamsSchema,
  portfolioIdParamsSchema,
  portfolioWriteSchema,
};
