const { z } = require("zod");
const { bookingItemsSchema } = require("./bookingValidator");

const voucherIdSchema = z.string().uuid();
const voucherCodeSchema = z.string().trim().toUpperCase().min(1).max(30);
const MAX_VOUCHER_AMOUNT = 9_999_999_999.99;
const MAX_USAGE_LIMIT = 2_147_483_647;

const voucherDefinitionSchema = z
  .object({
    code: voucherCodeSchema,
    description: z.string().trim().max(2000).nullable().optional(),
    discount_type: z.enum(["percentage", "fixed"]),
    discount_value: z
      .number()
      .positive()
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01),
    minimum_transaction: z
      .number()
      .min(0)
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01)
      .default(0),
    max_discount: z
      .number()
      .positive()
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01)
      .nullable()
      .optional(),
    usage_limit: z.number().int().min(1).max(MAX_USAGE_LIMIT),
    start_at: z.string().datetime({ offset: true }),
    end_at: z.string().datetime({ offset: true }),
    is_active: z.boolean().default(true),
  })
  .strict()
  .superRefine((voucher, context) => {
    if (
      voucher.discount_type === "percentage" &&
      voucher.discount_value > 100
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discount_value"],
        message: "Diskon persentase tidak boleh melebihi 100",
      });
    }
    if (
      voucher.discount_type === "fixed" &&
      voucher.max_discount !== undefined &&
      voucher.max_discount !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_discount"],
        message: "Maksimal diskon hanya berlaku untuk voucher percentage",
      });
    }
    if (new Date(voucher.end_at).getTime() <= new Date(voucher.start_at).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_at"],
        message: "Tanggal berakhir harus setelah tanggal mulai",
      });
    }
  });

const createVoucherSchema = voucherDefinitionSchema;
const updateVoucherSchema = z
  .object({
    code: voucherCodeSchema.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    discount_type: z.enum(["percentage", "fixed"]).optional(),
    discount_value: z
      .number()
      .positive()
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01)
      .optional(),
    minimum_transaction: z
      .number()
      .min(0)
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01)
      .optional(),
    max_discount: z
      .number()
      .positive()
      .max(MAX_VOUCHER_AMOUNT)
      .multipleOf(0.01)
      .nullable()
      .optional(),
    usage_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_USAGE_LIMIT)
      .optional(),
    start_at: z.string().datetime({ offset: true }).optional(),
    end_at: z.string().datetime({ offset: true }).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((voucher) => Object.keys(voucher).length > 0, {
    message: "Minimal satu field harus diubah",
  });

const validateVoucherSchema = z
  .object({
    code: voucherCodeSchema,
    items: bookingItemsSchema,
  })
  .strict()
  .refine(
    (voucher) =>
      new Set(voucher.items.map((item) => item.service_id)).size ===
      voucher.items.length,
    {
      message: "Layanan yang sama tidak boleh dikirim lebih dari satu kali",
      path: ["items"],
    }
  );

module.exports = {
  voucherIdSchema,
  createVoucherSchema,
  updateVoucherSchema,
  voucherDefinitionSchema,
  validateVoucherSchema,
};
