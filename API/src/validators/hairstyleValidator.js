const { z } = require("zod");

const hairstyleRecommendationQuerySchema = z
  .object({
    face_shape: z.enum([
      "oval",
      "round",
      "square",
      "heart",
      "oblong",
      "diamond",
    ]),
    hair_type: z.enum(["straight", "wavy", "curly", "coily"]),
  })
  .strict();

module.exports = { hairstyleRecommendationQuerySchema };
