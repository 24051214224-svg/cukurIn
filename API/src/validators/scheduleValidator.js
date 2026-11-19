const { z } = require("zod");

const barberIdSchema = z.string().uuid();
const scheduleIdSchema = z.string().uuid();

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: "Format waktu harus HH:mm atau HH:mm:ss",
  })
  .transform((value) => (value.length === 5 ? `${value}:00` : value));

const dayOfWeekSchema = z.number().int().min(0).max(6);

const isValidTimeRange = (startTime, endTime) => {
  const toSeconds = (value) => {
    const [hours, minutes, seconds] = value.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  };

  return toSeconds(endTime) > toSeconds(startTime);
};

const createScheduleSchema = z
  .object({
    day_of_week: dayOfWeekSchema,
    start_time: timeSchema,
    end_time: timeSchema,
    is_available: z.boolean().default(true),
  })
  .strict()
  .refine(
    (schedule) => isValidTimeRange(schedule.start_time, schedule.end_time),
    {
      message: "Jam selesai harus setelah jam mulai pada hari yang sama",
      path: ["end_time"],
    }
  );

const updateScheduleSchema = z
  .object({
    day_of_week: dayOfWeekSchema.optional(),
    start_time: timeSchema.optional(),
    end_time: timeSchema.optional(),
    is_available: z.boolean().optional(),
  })
  .strict()
  .refine((schedule) => Object.keys(schedule).length > 0, {
    message: "Setidaknya satu field harus diperbarui",
  })
  .superRefine((schedule, context) => {
    if (
      schedule.start_time &&
      schedule.end_time &&
      !isValidTimeRange(schedule.start_time, schedule.end_time)
    ) {
      context.addIssue({
        code: "custom",
        message: "Jam selesai harus setelah jam mulai pada hari yang sama",
        path: ["end_time"],
      });
    }
  });

module.exports = {
  barberIdSchema,
  scheduleIdSchema,
  createScheduleSchema,
  updateScheduleSchema,
  isValidTimeRange,
};
