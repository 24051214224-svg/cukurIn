
# CukurIn

### Aplikasi Mobile Manajemen Reservasi dan Antrean Barbershop

## Identitas Mahasiswa

- Nama: Muhammad Rafi Ibrahim
- NIM: 24051214224
- Program Studi: S1 Sistem Informasi
- Universitas: Universitas Negeri Surabaya (UNESA)
- Mata Kuliah: Pemrograman Aplikasi Bergerak
- Jenis Tugas: Project Besar Individu

---

## 1. Judul Project

Perancangan Aplikasi Mobile Manajemen Reservasi dan Antrean Barbershop Berbasis Flutter dengan Estimasi Waktu Tunggu Otomatis.

## 2. Abstrak

CukurIn merupakan aplikasi mobile yang dirancang untuk membantu proses reservasi dan pengelolaan antrean pada layanan barbershop. Permasalahan antrean yang tidak terorganisasi dan ketidakpastian waktu tunggu menjadi latar belakang pengembangan aplikasi ini.

Aplikasi dikembangkan menggunakan Flutter sebagai teknologi frontend, Node.js dan Express.js sebagai API dan backend, serta PostgreSQL sebagai sistem manajemen basis data. Sistem menyediakan fitur reservasi layanan, pemilihan barber, pemantauan antrean, riwayat pemesanan, ulasan, dan pengelolaan layanan.

Fitur unggulan CukurIn adalah Smart Queue yang digunakan untuk memperkirakan waktu tunggu pelanggan berdasarkan durasi layanan dan jumlah antrean pada masing-masing barber. Selain itu, aplikasi dilengkapi dengan QR check-in, sistem poin loyalitas, voucher, serta rekomendasi gaya rambut berdasarkan bentuk wajah dan jenis rambut.

Pengembangan aplikasi ini diharapkan dapat meningkatkan efisiensi pengelolaan reservasi, membantu pelanggan memperoleh informasi antrean secara lebih jelas, serta mendukung digitalisasi operasional barbershop.

**Kata Kunci:** Barbershop, Flutter, Reservasi, Smart Queue, Estimasi Waktu Tunggu.

## 3. Teknologi yang Digunakan

| Komponen | Teknologi |
|---|---|
| Frontend | Flutter |
| State Management | Provider |
| HTTP Client | Dio |
| API | Node.js, Express.js |
| Authentication | JWT |
| API Documentation | Swagger |
| Backend | Node.js |
| Database | PostgreSQL |

## 4. Fitur Utama

- Registrasi dan login pengguna.
- Manajemen barber dan layanan.
- Reservasi dan pemilihan jadwal.
- Smart Queue dan estimasi waktu tunggu.
- QR Code check-in.
- Riwayat reservasi dan ulasan.
- Rekomendasi gaya rambut.
- Poin loyalitas dan voucher.
- Dashboard admin dan barber.
- Laporan dan grafik pendapatan.

## 5. Struktur Repository

- `Frontend/` - Aplikasi mobile Flutter.
- `API/` - REST API dan autentikasi.
- `Backend/` - Logika bisnis, model, migrasi, dan seed database.

## 6. API yang Sudah Tersedia

- `GET /api/health` - Memeriksa koneksi API dan PostgreSQL.
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` - Autentikasi dan profil.
- `GET /api/services`, `GET /api/services/:id` - Membaca layanan aktif.
- `POST /api/services`, `PUT /api/services/:id`, `DELETE /api/services/:id` - Mengelola layanan (admin).
- `GET /api/barbers`, `GET /api/barbers/:id` - Membaca barber aktif, rating, dan portofolio.
- `GET /api/barbers/admin` - Melihat seluruh barber termasuk akun nonaktif (admin).
- `POST /api/barbers`, `PUT /api/barbers/:id`, `DELETE /api/barbers/:id` - Mengelola akun dan profil barber (admin).
- `GET /api/barbers/:barberId/schedules` - Melihat jadwal barber aktif.
- `POST /api/barbers/:barberId/schedules`, `PATCH /api/barbers/:barberId/schedules/:scheduleId`, `DELETE /api/barbers/:barberId/schedules/:scheduleId` - Mengelola jadwal (admin).
- `POST /api/bookings`, `GET /api/bookings`, `GET /api/bookings/:id` - Membuat dan melihat reservasi sesuai role.
- `PATCH /api/bookings/:id/cancel` - Membatalkan reservasi customer yang masih dapat dibatalkan.
- `PATCH /api/bookings/:id/status` - Mengubah status reservasi oleh admin atau barber yang ditugaskan.
- `GET /api/queues/my` - Melihat antrean milik customer.
- `GET /api/queues/:id` - Melihat detail antrean sesuai kepemilikan dan role.
- `GET /api/barbers/:barberId/queues/today` - Melihat antrean harian oleh barber yang ditugaskan atau admin.
- `PATCH /api/queues/:id/call`, `/start`, `/complete`, `/cancel` - Mengelola siklus status antrean.
- `PATCH /api/queues/:id/check-in` atau `POST /api/queues/check-in` - Check-in dengan QR token milik antrean.

Dokumentasi Swagger tersedia di `http://localhost:3000/api-docs`.

Pembuatan reservasi memvalidasi jam kerja barber dan layanan aktif, menghitung harga serta durasi dari database, lalu menyimpan snapshot layanan dalam transaksi. Booking untuk barber yang sama diserialisasi dengan row lock barber sehingga permintaan bersamaan tidak dapat mengalokasikan waktu yang bertabrakan. Queue/antrean belum dibuat oleh endpoint booking.

Untuk menjalankan pengujian API:

```powershell
cd API
npm test
```

Untuk membuat atau memperbarui satu akun barber seed, isi `SEED_BARBER_NAME`, `SEED_BARBER_EMAIL`, `SEED_BARBER_PHONE`, dan `SEED_BARBER_PASSWORD` secara lokal pada `API/.env`, kemudian jalankan:

```powershell
npm run seed:barber
```

Password di-hash dengan bcryptjs. Seed menggunakan transaksi, tidak mempromosikan akun non-barber, dan tidak mengubah file `.env` atau migration.

## 7. Status Pengembangan

API autentikasi, layanan, barber, jadwal barber, dan reservasi memiliki implementasi dasar. Queue/antrean, QR check-in, dan dashboard role belum diimplementasikan; frontend Flutter masih perlu diintegrasikan dengan endpoint API.
