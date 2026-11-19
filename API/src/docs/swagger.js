const swaggerJsdoc = require("swagger-jsdoc");

const response = (description) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiResponse" },
    },
  },
});

const jsonRequestBody = (schema) => ({
  required: true,
  content: {
    "application/json": { schema },
  },
});

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "CukurIn API",
      version: "1.0.0",
      description: "REST API untuk reservasi dan pengelolaan barbershop CukurIn.",
    },
    servers: [
      {
        url: process.env.API_BASE_URL || "http://localhost:3000",
      },
    ],
    tags: [
      { name: "Health" },
      { name: "Authentication" },
      { name: "Services" },
      { name: "Barbers" },
      { name: "Bookings" },
      { name: "Queues" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        ApiResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            message: { type: "string" },
            data: {},
          },
        },
        RegisterRequest: {
          type: "object",
          required: ["full_name", "email", "phone_number", "password"],
          properties: {
            full_name: { type: "string", minLength: 3 },
            email: { type: "string", format: "email" },
            phone_number: { type: "string", minLength: 10, maxLength: 20 },
            password: { type: "string", minLength: 8 },
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        ServiceRequest: {
          type: "object",
          required: ["service_name", "price", "duration_minutes"],
          properties: {
            service_name: { type: "string" },
            description: { type: "string", nullable: true },
            price: { type: "number", minimum: 0 },
            duration_minutes: { type: "integer", minimum: 1 },
          },
        },
        BarberRequest: {
          type: "object",
          required: ["full_name", "email", "phone_number", "password"],
          properties: {
            full_name: { type: "string", minLength: 3, maxLength: 100 },
            email: { type: "string", format: "email", maxLength: 150 },
            phone_number: { type: "string", minLength: 10, maxLength: 20 },
            password: {
              type: "string",
              minLength: 8,
              maxLength: 72,
              description: "Maksimal 72 byte sebelum di-hash dengan bcrypt.",
            },
            profile_photo_url: { type: "string", format: "uri", nullable: true },
            bio: { type: "string", maxLength: 2000, nullable: true },
            experience_years: { type: "integer", minimum: 0, default: 0 },
            is_available: { type: "boolean", default: true },
          },
        },
        BarberUpdateRequest: {
          type: "object",
          minProperties: 1,
          properties: {
            full_name: { type: "string", minLength: 3, maxLength: 100 },
            email: { type: "string", format: "email", maxLength: 150 },
            phone_number: { type: "string", minLength: 10, maxLength: 20 },
            password: { type: "string", minLength: 8, maxLength: 72 },
            profile_photo_url: { type: "string", format: "uri", nullable: true },
            bio: { type: "string", maxLength: 2000, nullable: true },
            experience_years: { type: "integer", minimum: 0 },
            is_available: { type: "boolean" },
            is_active: { type: "boolean" },
          },
        },
        ScheduleRequest: {
          type: "object",
          required: ["day_of_week", "start_time", "end_time"],
          properties: {
            day_of_week: {
              type: "integer",
              minimum: 0,
              maximum: 6,
              description: "0 = Minggu, 6 = Sabtu.",
            },
            start_time: {
              type: "string",
              pattern: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$",
            },
            end_time: {
              type: "string",
              pattern: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$",
            },
            is_available: { type: "boolean", default: true },
          },
        },
        ScheduleUpdateRequest: {
          type: "object",
          minProperties: 1,
          properties: {
            day_of_week: { type: "integer", minimum: 0, maximum: 6 },
            start_time: {
              type: "string",
              pattern: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$",
            },
            end_time: {
              type: "string",
              pattern: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$",
            },
            is_available: { type: "boolean" },
          },
        },
        BookingItemRequest: {
          type: "object",
          required: ["service_id"],
          properties: {
            service_id: { type: "string", format: "uuid" },
            quantity: { type: "integer", minimum: 1, maximum: 10, default: 1 },
          },
        },
        CreateBookingRequest: {
          type: "object",
          required: ["barber_id", "start_at", "items"],
          properties: {
            barber_id: { type: "string", format: "uuid" },
            start_at: {
              type: "string",
              format: "date-time",
              description:
                "Timestamp ISO-8601 dengan zona waktu; waktu harus tepat pada menit.",
            },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: { $ref: "#/components/schemas/BookingItemRequest" },
            },
            notes: { type: "string", maxLength: 1000, nullable: true },
          },
        },
        BookingStatusRequest: {
          type: "object",
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: [
                "pending",
                "confirmed",
                "in_progress",
                "completed",
                "cancelled",
                "no_show",
              ],
            },
          },
        },
      },
    },
    paths: {
      "/": {
        get: {
          tags: ["Health"],
          summary: "Status singkat API",
          responses: { 200: response("API berjalan.") },
        },
      },
      "/api/health": {
        get: {
          tags: ["Health"],
          summary: "Periksa koneksi API dan PostgreSQL",
          responses: {
            200: response("API dan database terhubung."),
            503: response("Database tidak tersedia."),
          },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Authentication"],
          summary: "Daftarkan akun customer",
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/RegisterRequest",
          }),
          responses: {
            201: response("Registrasi berhasil."),
            400: response("Input tidak valid."),
            409: response("Email atau nomor telepon sudah digunakan."),
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Authentication"],
          summary: "Login dan dapatkan JWT",
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/LoginRequest",
          }),
          responses: {
            200: response("Login berhasil."),
            400: response("Input tidak valid."),
            401: response("Kredensial tidak valid."),
          },
        },
      },
      "/api/auth/me": {
        get: {
          tags: ["Authentication"],
          summary: "Ambil profil pengguna aktif",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Profil berhasil diambil."),
            401: response("JWT tidak valid atau tidak tersedia."),
          },
        },
      },
      "/api/services": {
        get: {
          tags: ["Services"],
          summary: "Daftar layanan aktif",
          responses: { 200: response("Daftar layanan.") },
        },
        post: {
          tags: ["Services"],
          summary: "Tambah layanan (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/ServiceRequest",
          }),
          responses: {
            201: response("Layanan berhasil ditambahkan."),
            400: response("Input tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola layanan."),
          },
        },
      },
      "/api/services/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        get: {
          tags: ["Services"],
          summary: "Detail layanan aktif",
          responses: {
            200: response("Detail layanan."),
            404: response("Layanan tidak ditemukan."),
          },
        },
        put: {
          tags: ["Services"],
          summary: "Ubah layanan (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/ServiceRequest",
          }),
          responses: {
            200: response("Layanan berhasil diperbarui."),
            400: response("Input tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola layanan."),
            404: response("Layanan tidak ditemukan."),
          },
        },
        delete: {
          tags: ["Services"],
          summary: "Nonaktifkan layanan (admin)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Layanan berhasil dinonaktifkan."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola layanan."),
            404: response("Layanan tidak ditemukan."),
          },
        },
      },
      "/api/barbers": {
        get: {
          tags: ["Barbers"],
          summary: "Daftar profil barber aktif",
          parameters: [
            {
              name: "is_available",
              in: "query",
              required: false,
              schema: { type: "boolean" },
            },
          ],
          responses: { 200: response("Daftar barber.") },
        },
        post: {
          tags: ["Barbers"],
          summary: "Buat akun dan profil barber (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/BarberRequest",
          }),
          responses: {
            201: response("Barber berhasil ditambahkan."),
            400: response("Input tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola barber."),
            409: response("Email atau nomor telepon sudah digunakan."),
          },
        },
      },
      "/api/barbers/admin": {
        get: {
          tags: ["Barbers"],
          summary: "Daftar semua barber termasuk akun nonaktif (admin)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Daftar barber untuk pengelolaan admin."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat melihat daftar ini."),
          },
        },
      },
      "/api/barbers/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        get: {
          tags: ["Barbers"],
          summary: "Detail barber aktif dan portofolionya",
          responses: {
            200: response("Detail barber."),
            404: response("Barber tidak ditemukan."),
          },
        },
        put: {
          tags: ["Barbers"],
          summary: "Perbarui akun atau profil barber (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/BarberUpdateRequest",
          }),
          responses: {
            200: response("Barber berhasil diperbarui."),
            400: response("ID atau input tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola barber."),
            404: response("Barber tidak ditemukan."),
            409: response("Email atau nomor telepon sudah digunakan."),
          },
        },
        delete: {
          tags: ["Barbers"],
          summary: "Nonaktifkan akun barber tanpa menghapus riwayat (admin)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Barber berhasil dinonaktifkan."),
            400: response("ID tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola barber."),
            404: response("Barber tidak ditemukan."),
          },
        },
      },
      "/api/barbers/{barberId}/schedules": {
        parameters: [
          {
            name: "barberId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        get: {
          tags: ["Barbers"],
          summary: "Lihat jadwal barber",
          responses: {
            200: response("Jadwal barber berhasil diambil."),
            404: response("Barber tidak ditemukan atau tidak aktif."),
          },
        },
        post: {
          tags: ["Barbers"],
          summary: "Tambah jadwal barber (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/ScheduleRequest",
          }),
          responses: {
            201: response("Jadwal barber berhasil ditambahkan."),
            400: response("ID atau data jadwal tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola jadwal."),
            404: response("Barber tidak ditemukan."),
            409: response("Barber tidak tersedia atau jadwal bertabrakan."),
          },
        },
      },
      "/api/barbers/{barberId}/schedules/{scheduleId}": {
        parameters: [
          {
            name: "barberId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "scheduleId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        patch: {
          tags: ["Barbers"],
          summary: "Ubah sebagian data jadwal barber (admin)",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/ScheduleUpdateRequest",
          }),
          responses: {
            200: response("Jadwal barber berhasil diperbarui."),
            400: response("ID atau data jadwal tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola jadwal."),
            404: response("Barber atau jadwal tidak ditemukan."),
            409: response("Barber tidak tersedia atau jadwal bertabrakan."),
          },
        },
        delete: {
          tags: ["Barbers"],
          summary: "Hapus jadwal barber (admin)",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Jadwal barber berhasil dihapus."),
            400: response("ID barber atau jadwal tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya admin yang dapat mengelola jadwal."),
            404: response("Barber atau jadwal tidak ditemukan."),
          },
        },
      },
      "/api/bookings": {
        get: {
          tags: ["Bookings"],
          summary: "Daftar reservasi sesuai role pengguna",
          description:
            "Customer hanya melihat miliknya, barber hanya reservasi yang ditugaskan kepadanya, admin melihat semua.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: [
                  "pending",
                  "confirmed",
                  "in_progress",
                  "completed",
                  "cancelled",
                  "no_show",
                ],
              },
            },
          ],
          responses: {
            200: response("Daftar reservasi."),
            400: response("Filter tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
          },
        },
        post: {
          tags: ["Bookings"],
          summary: "Buat reservasi customer",
          description:
            "Harga dan durasi dihitung dari layanan aktif di database. Pembuatan reservasi tidak membuat antrean.",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/CreateBookingRequest",
          }),
          responses: {
            201: response("Reservasi berhasil dibuat."),
            400: response("Input tidak valid atau waktu bukan di masa depan."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya customer aktif yang dapat membuat reservasi."),
            404: response("Barber tidak ditemukan."),
            409: response("Layanan tidak aktif, di luar jadwal, atau waktu terisi."),
          },
        },
      },
      "/api/bookings/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        get: {
          tags: ["Bookings"],
          summary: "Detail reservasi dan snapshot layanan",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Detail reservasi."),
            401: response("JWT tidak valid atau tidak tersedia."),
            404: response("Reservasi tidak ditemukan atau tidak dapat diakses."),
          },
        },
      },
      "/api/bookings/{id}/cancel": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        patch: {
          tags: ["Bookings"],
          summary: "Batalkan reservasi milik customer",
          description:
            "Hanya reservasi pending atau confirmed yang belum dimulai yang dapat dibatalkan.",
          security: [{ bearerAuth: [] }],
          responses: {
            200: response("Reservasi berhasil dibatalkan."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Hanya customer yang dapat membatalkan reservasi."),
            404: response("Reservasi tidak ditemukan."),
            409: response("Status tidak dapat dibatalkan atau reservasi telah dimulai."),
          },
        },
      },
      "/api/bookings/{id}/status": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        patch: {
          tags: ["Bookings"],
          summary: "Ubah status reservasi (barber yang ditugaskan atau admin)",
          description:
            "Transisi dibatasi: pending ke confirmed/cancelled; confirmed ke in_progress/cancelled/no_show oleh admin (in_progress oleh barber); in_progress ke completed. Status no_show hanya dapat diberikan admin setelah waktu mulai.",
          security: [{ bearerAuth: [] }],
          requestBody: jsonRequestBody({
            $ref: "#/components/schemas/BookingStatusRequest",
          }),
          responses: {
            200: response("Status reservasi berhasil diperbarui."),
            400: response("ID atau status tidak valid."),
            401: response("JWT tidak valid atau tidak tersedia."),
            403: response("Role tidak dapat mengubah status reservasi."),
            404: response("Reservasi tidak ditemukan atau bukan milik barber."),
            409: response("Transisi status tidak diizinkan."),
          },
        },
      },
    },
  },
  apis: [],
});

module.exports = swaggerSpec;
