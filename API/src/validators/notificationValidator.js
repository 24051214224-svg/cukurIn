const { z } = require("zod");

const notificationIdSchema = z.string().uuid();

const notificationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

module.exports = {
  notificationIdSchema,
  notificationListQuerySchema,
};
