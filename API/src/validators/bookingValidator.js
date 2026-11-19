const { z } = require("zod");

const bookingIdSchema = z.string().uuid();
const bookingStatusSchema = z.enum([
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
]);

const bookingItemSchema = z
  .object({
    service_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(10).default(1),
  })
  .strict();

const createBookingSchema = z
  .object({
    barber_id: z.string().uuid(),
    start_at: z
      .string()
      .datetime({ offset: true })
      .refine((value) => {
        const startAt = new Date(value);
        return startAt.getUTCSeconds() === 0 && startAt.getUTCMilliseconds() === 0;
      }, "Waktu reservasi harus tepat pada menit"),
    items: z.array(bookingItemSchema).min(1).max(10),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine(
    (booking) =>
      new Set(booking.items.map((item) => item.service_id)).size ===
      booking.items.length,
    {
      message: "Layanan yang sama tidak boleh dikirim lebih dari satu kali",
      path: ["items"],
    }
  );

const bookingListQuerySchema = z
  .object({
    status: bookingStatusSchema.optional(),
  })
  .strict();

const updateBookingStatusSchema = z
  .object({
    status: bookingStatusSchema,
  })
  .strict();

module.exports = {
  bookingIdSchema,
  bookingStatusSchema,
  createBookingSchema,
  bookingListQuerySchema,
  updateBookingStatusSchema,
};
