
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

- Authentication dengan JWT untuk registrasi, login, dan profil pengguna.
- Manajemen layanan dan barber, termasuk pengelolaan jadwal.
- Booking dengan validasi jadwal dan perubahan status.
- Manajemen antrean dengan estimasi waktu mulai/selesai (Smart ETA).
- QR check-in untuk antrean.
- Review dan rating barber.
- Voucher persentase atau potongan tetap dengan kuota global.
- Loyalty Points dihitung dari total booking setelah diskon.

## 5. Struktur Repository

- `API/` - REST API Node.js/Express, test, migration, seed, dan dokumentasi Swagger.
- `Frontend/` - Saat ini hanya berisi `.gitkeep`; source Flutter belum ada di repository.
- `Backend/` - Saat ini hanya berisi `.gitkeep`; source backend terpisah belum ada di repository.

## 6. API yang Tersedia

Daftar berikut mengikuti route yang terpasang di `API/src/app.js` dan spesifikasi Swagger. Endpoint yang diberi tanda **JWT** memerlukan `Authorization: Bearer <token>`; pembatasan role diterapkan sesuai route.

| Fitur | Method dan endpoint | Akses/catatan |
|---|---|---|
| Health | `GET /` | Status singkat API. |
| Health | `GET /api/health` | Memeriksa koneksi PostgreSQL. |
| Authentication | `POST /api/auth/register` | Registrasi customer. |
| Authentication | `POST /api/auth/login` | Login dan memperoleh JWT. |
| Authentication | `GET /api/auth/me` | JWT; profil pengguna aktif. |
| Services | `GET /api/services`, `GET /api/services/:id` | Membaca layanan aktif. |
| Services | `POST /api/services`, `PUT /api/services/:id`, `DELETE /api/services/:id` | JWT; admin. |
| Barber | `GET /api/barbers`, `GET /api/barbers/:id` | Membaca barber aktif dan detailnya. |
| Barber | `GET /api/barbers/admin` | JWT; admin, termasuk akun nonaktif. |
| Barber | `POST /api/barbers`, `PUT /api/barbers/:id`, `DELETE /api/barbers/:id` | JWT; admin. |
| Schedule | `GET /api/barbers/:barberId/schedules` | Membaca jadwal barber. |
| Schedule | `POST /api/barbers/:barberId/schedules`, `PATCH /api/barbers/:barberId/schedules/:scheduleId`, `DELETE /api/barbers/:barberId/schedules/:scheduleId` | JWT; admin. |
| Booking | `GET /api/bookings`, `POST /api/bookings`, `GET /api/bookings/:id` | JWT; akses dibatasi berdasarkan role dan kepemilikan. |
| Booking | `PATCH /api/bookings/:id/cancel` | JWT; customer, mengikuti aturan status booking. |
| Booking | `PATCH /api/bookings/:id/status` | JWT; barber atau admin, mengikuti aturan status booking. |
| Voucher | `GET /api/vouchers`, `GET /api/vouchers/:id`, `POST /api/vouchers`, `PATCH /api/vouchers/:id` | JWT; admin. PATCH mengubah detail atau mengaktifkan/menonaktifkan voucher. |
| Voucher | `POST /api/vouchers/validate` | JWT; customer mengirim `code` dan `items`; backend menghitung harga dari layanan aktif. Tidak memesan kuota. |
| Voucher | `POST /api/bookings` dengan `voucher_code` opsional | JWT; customer. Harga dan diskon dihitung backend; voucher divalidasi ulang serta kuota dikonsumsi dalam transaksi booking. |
| Queue / Smart ETA | `GET /api/queues/my`, `GET /api/queues/:id` | JWT; antrean customer/detail sesuai role dan kepemilikan. Detail antrean memuat estimasi waktu. |
| Queue | `GET /api/barbers/:barberId/queues/today` | JWT; barber yang ditugaskan atau admin. |
| QR check-in | `POST /api/queues/check-in` | JWT; customer mengirim QR token. |
| QR check-in | `PATCH /api/queues/:id/check-in` | JWT; customer check-in antrean berdasarkan ID dan QR token. |
| Queue lifecycle | `PATCH /api/queues/:id/call`, `PATCH /api/queues/:id/start`, `PATCH /api/queues/:id/complete`, `PATCH /api/queues/:id/cancel` | JWT; role dan transisi status mengikuti aturan masing-masing route. |
| Review & Rating | `POST /api/reviews` | JWT; customer dapat mengulas booking yang memenuhi syarat. |
| Review & Rating | `GET /api/reviews/barber/:barberId` | Daftar review dan rating barber. |
| Review & Rating | `GET /api/reviews/my` | JWT; review customer. |
| Review & Rating | `GET /api/reviews/:id` | JWT; detail sesuai role dan kepemilikan. |
| Loyalty Points | `GET /api/loyalty/balance` | JWT; saldo customer yang login. |
| Loyalty Points | `GET /api/loyalty/history?limit=50&offset=0` | JWT; riwayat customer yang login, `limit` maksimum 100. |
| Loyalty Points | `POST /api/loyalty/redeem` | JWT; body `{ "points": 10 }`, jumlah harus integer positif dan tidak boleh melebihi saldo. |

Smart ETA merupakan data pada respons antrean, bukan endpoint terpisah. Check-in memvalidasi QR token; route tidak mendokumentasikan pembuatan gambar QR. Tidak ada endpoint `GET /api/queues` umum pada route saat ini. Loyalty selalu mengambil `user_id` dari JWT, bukan dari request.

Poin diberikan satu kali ketika booking berstatus `completed`: `floor(total_price / LOYALTY_RUPIAH_PER_POINT)`. Default konfigurasi adalah `LOYALTY_RUPIAH_PER_POINT=10000`, sehingga satu poin diberikan per setiap Rp10.000 pada `bookings.total_price`; pecahan dibulatkan ke bawah dan hasil nol tidak dicatat. Transaksi earn menyimpan poin positif, sedangkan redeem menyimpan poin negatif pada ledger. `cancelled` dan `no_show` tidak memperoleh poin.

Kode voucher dipangkas spasi tepinya dan diubah menjadi uppercase. Voucher hanya berlaku pada periode mulai (inklusif) sampai waktu berakhir (eksklusif), dan minimum transaksi (jika tidak diisi, Rp0) dibandingkan dengan subtotal layanan sebelum diskon. Diskon percentage dibulatkan half-up ke dua desimal dan dapat dibatasi dengan `max_discount`; diskon fixed tidak dapat melebihi subtotal sehingga total tidak negatif. Batas penggunaan global wajib ditentukan saat voucher dibuat. Kuota dikonsumsi hanya ketika booking berhasil dibuat, bukan saat validasi; pembatalan booking mengembalikan satu kuota dalam transaksi yang sama, sedangkan `no_show` tidak. `bookings.total_price` menyimpan total setelah diskon, sehingga Loyalty Points tetap memakai nilai neto tersebut. Schema migration 011 sudah menyediakan kolom yang diperlukan; Stage E3 tidak menambahkan migration.

Dokumentasi Swagger tersedia setelah API berjalan di `http://localhost:3000/api-docs`.

### Menyiapkan dan menjalankan API

Gunakan Node.js/npm yang kompatibel dengan dependency project dan PostgreSQL yang dapat diakses dari mesin lokal.

```powershell
cd API
npm ci
Copy-Item .env.example .env
```

Edit `API/.env` secara lokal: isi konfigurasi PostgreSQL dan ganti `JWT_SECRET` dengan nilai acak yang kuat. Sesuaikan nilai contoh, termasuk port database, dengan lingkungan Anda. Jangan commit atau membagikan `.env`; file tersebut diabaikan Git.

Untuk database baru yang masih kosong, buat database terlebih dahulu, lalu jalankan semua file SQL secara berurutan. Contoh PowerShell berikut memakai nilai contoh `.env.example`; sesuaikan koneksi dengan database Anda. `psql` akan meminta password bila diperlukan.

```powershell
$dbHost = "127.0.0.1"
$dbPort = "5433"
$dbName = "cukurin_db"
$dbUser = "postgres"

Get-ChildItem .\database\migrations\*.sql |
  Sort-Object Name |
  ForEach-Object {
    psql -h $dbHost -p $dbPort -U $dbUser -d $dbName `
      -v ON_ERROR_STOP=1 -f $_.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "Migration gagal: $($_.Name)"
    }
  }
```

**Jangan jalankan ulang seluruh urutan tersebut pada database yang sudah berisi data.** Backup dahulu, periksa schema dan riwayat migration aktual, lalu terapkan hanya perubahan yang belum ada. Repository ini belum menyediakan migration runner/ledger umum; `API/scripts/applyQueueMigration015.js` hanya menangani migration 015 dan mengharapkan tabel `schema_migrations` sudah tersedia. Jangan jalankan helper itu sebelum memastikan prasyarat dan kondisi database.

Database Stage E2 yang sudah menerapkan migration 001–015 hanya memerlukan migration 016 berikut, bukan menjalankan ulang migration lama:

```powershell
psql -h 127.0.0.1 -p 5433 -U postgres -d cukurin_db `
  -v ON_ERROR_STOP=1 -f .\database\migrations\016_unique_loyalty_earn_per_booking.sql
```

Sesuaikan parameter koneksi dengan database lokal; `psql` dapat meminta password. Migration 016 menambahkan unique partial index agar satu booking hanya memiliki satu transaksi `earn`. Jika database mungkin sudah berisi transaksi poin, periksa duplikasi `earn` terlebih dahulu dan evaluasi secara manual sebelum membuat index; jangan menghapus atau menggabungkan data secara otomatis.

Voucher menggunakan schema yang telah dibuat migration 011; tidak ada migration tambahan untuk Stage E3.

Setelah database siap, jalankan API:

```powershell
npm start
```

Server memeriksa koneksi database saat startup. Mode pengembangan tersedia melalui `npm run dev`.

### Test

```powershell
npm test
```

Test PostgreSQL integration dilewati secara default. Untuk menjalankannya, gunakan database test terisolasi yang sudah dimigrasikan—jangan gunakan database produksi—dan set flag yang sesuai:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "1"
node --test test/queuePostgres.integration.test.js
Remove-Item Env:RUN_POSTGRES_INTEGRATION

$env:RUN_POSTGRES_REVIEW_INTEGRATION = "1"
node --test test/reviewPostgres.integration.test.js
Remove-Item Env:RUN_POSTGRES_REVIEW_INTEGRATION

$env:RUN_POSTGRES_LOYALTY_INTEGRATION = "1"
node --test test/loyaltyPostgres.integration.test.js
Remove-Item Env:RUN_POSTGRES_LOYALTY_INTEGRATION

$env:RUN_POSTGRES_VOUCHER_INTEGRATION = "1"
node --test test/voucherPostgres.integration.test.js
Remove-Item Env:RUN_POSTGRES_VOUCHER_INTEGRATION
```

Integration loyalty memerlukan migration 016; integration voucher memerlukan migration 011–016. Gunakan database test terisolasi yang sudah dimigrasikan. Test membuat fixture dengan identitas unik dan hanya membersihkan row fixture yang dibuatnya; jangan arahkan ke database produksi.

### Audit dependency

`API/audit-report.json` adalah laporan tersimpan dan tidak dihapus. Laporan tersebut mencatat 8 temuan pada saat dibuat (5 high dan 3 moderate); angka ini dapat kedaluwarsa. Jika memerlukan status terkini, jalankan `npm audit` dari folder `API` dan evaluasi hasilnya sebelum memperbarui dependency.

## 7. Status Pengembangan

Source API untuk authentication, barber dan schedule management, booking, voucher/discount, queue/Smart ETA, QR check-in, review dan rating, serta loyalty points tersedia di repository. Source Flutter dan backend terpisah belum tersedia pada folder `Frontend/` dan `Backend/` saat ini; keduanya hanya berisi `.gitkeep`.

Opsional, untuk membuat atau memperbarui satu akun barber seed, isi `SEED_BARBER_NAME`, `SEED_BARBER_EMAIL`, `SEED_BARBER_PHONE`, dan `SEED_BARBER_PASSWORD` di `API/.env`, lalu jalankan dari folder `API/`:

```powershell
npm run seed:barber
```

Seed meng-hash password dengan bcryptjs dan menggunakan transaksi. Jangan menyimpan credential seed di Git.
