
const { z } = require("zod");

const registerSchema = z.object({
  full_name: z.string().min(3, "Nama minimal 3 karakter"),
  email: z.string().email("Format email tidak valid"),
  phone_number: z.string().min(10).max(20),
  password: z.string().min(8, "Password minimal 8 karakter"),
});

const loginSchema = z.object({
  email: z.string().email("Format email tidak valid"),
  password: z.string().min(1, "Password wajib diisi"),
});

module.exports = { registerSchema, loginSchema };
