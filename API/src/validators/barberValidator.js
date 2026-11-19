const { z } = require("zod");

const barberIdSchema = z.string().uuid();

const nameSchema = z.string().trim().min(3).max(100);
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(150)
  .transform((value) => value.toLowerCase());
const phoneNumberSchema = z.string().trim().min(10).max(20);
const passwordSchema = z
  .string()
  .min(8)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, {
    message: "Password tidak boleh lebih dari 72 byte",
  });
const bioSchema = z.string().trim().max(2000).nullable();
const profilePhotoUrlSchema = z.string().url().nullable();

const listBarbersQuerySchema = z
  .object({
    is_available: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

const createBarberSchema = z
  .object({
    full_name: nameSchema,
    email: emailSchema,
    phone_number: phoneNumberSchema,
    password: passwordSchema,
    profile_photo_url: profilePhotoUrlSchema.optional(),
    bio: bioSchema.optional(),
    experience_years: z.number().int().min(0).default(0),
    is_available: z.boolean().default(true),
  })
  .strict();

const updateBarberSchema = z
  .object({
    full_name: nameSchema.optional(),
    email: emailSchema.optional(),
    phone_number: phoneNumberSchema.optional(),
    password: passwordSchema.optional(),
    profile_photo_url: profilePhotoUrlSchema.optional(),
    bio: bioSchema.optional(),
    experience_years: z.number().int().min(0).optional(),
    is_available: z.boolean().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Setidaknya satu field harus diperbarui",
  });

module.exports = {
  barberIdSchema,
  listBarbersQuerySchema,
  createBarberSchema,
  updateBarberSchema,
};
