# DompetBareng

## Jalankan secara lokal

Gunakan Node.js 22 atau lebih baru. Di PowerShell, jalankan perintah berikut.

```powershell
npm.cmd ci
if (-not (Test-Path -LiteralPath .env.local)) {
  Copy-Item -LiteralPath .env.example -Destination .env.local
}
```

Setelah mengisi konfigurasi layanan di bawah, jalankan `npm.cmd run dev` dan buka `http://localhost:3000/login`.

## Database Supabase

Terapkan migrasi dari folder `supabase/migrations` ke proyek Supabase khusus DompetBareng. Ganti `PROJECT_REF` dengan ref proyek tujuan dan periksa hasil dry-run sebelum push. [Panduan migrasi Supabase](https://supabase.com/docs/guides/deployment/database-migrations)

```powershell
npx.cmd supabase@3.4.0 login
npx.cmd supabase@3.4.0 db push --remote=PROJECT_REF --dry-run --skip-vault
npx.cmd supabase@3.4.0 db push --remote=PROJECT_REF --skip-vault
```

[`supabase/schema.sql`](supabase/schema.sql) memuat skema lengkap. Untuk perubahan database berikutnya, buat migrasi baru dan perbarui skema lengkap agar keduanya sesuai.

Migrasi dompet juga menyiapkan Supabase Realtime untuk ruang pribadi dan rumah tangga. Perubahan mengirim sinyal privat agar aplikasi memuat ulang saldo dan transaksi dari database.

## Supabase Auth

1. Isi `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, dan `SUPABASE_SECRET_KEY` di `.env.local`. Isi `NEXT_PUBLIC_APP_URL` dengan `http://localhost:3000` untuk pengujian lokal atau origin HTTPS aplikasi di Vercel. Simpan secret key hanya di environment sisi server.
2. Di Supabase Authentication, aktifkan Email dan Google. Atur Site URL ke `NEXT_PUBLIC_APP_URL` dan masukkan URL lengkap `/auth/callback` dan `/auth/confirm` dari origin aplikasi ke daftar Redirect URLs. Di Google Cloud, gunakan URL callback Supabase berakhiran `/auth/v1/callback` sebagai *authorized redirect URI*, lalu masukkan client ID dan secret Google di pengaturan provider Google pada Supabase. [Panduan email](https://supabase.com/docs/guides/auth/passwords) · [Panduan Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
3. Jika konfirmasi email diaktifkan, gunakan tautan berikut sebagai `href` di template **Confirm signup**. Siapkan SMTP Supabase untuk alamat pengguna yang akan menerima konfirmasi. [Panduan template email](https://supabase.com/docs/guides/auth/auth-email-templates)

   ```text
   {{ .RedirectTo }}?token_hash={{ .TokenHash }}
   ```

## Hubungkan Bot Telegram

1. Isi `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`, dan `TELEGRAM_WEBHOOK_SECRET` di environment. Gunakan URL aplikasi HTTPS yang dapat dijangkau Telegram.
2. Panggil `setWebhook` melalui Bot API dengan token bot, `url` yang mengarah ke `/api/webhook/telegram` pada origin aplikasi, dan `secret_token` yang sama dengan `TELEGRAM_WEBHOOK_SECRET`. Atur `allowed_updates` ke `["message", "callback_query"]` agar bot menerima pesan dan aksi **Edit** atau **Hapus**. [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook)
3. Masuk di PWA, pilih **Hubungkan Telegram**, lalu **Buka Telegram**. Tekan **Mulai** di bot dan kembali ke PWA sampai status **Telegram Terhubung** muncul.

## Gabung Ruang Rumah Tangga

1. Dari akun pertama, buka **Ruang**, pilih **Rumah Tangga**, lalu **Buat Kode Undangan**. Salin kode untuk pasangan.
2. Dari akun pasangan, buka **Ruang** dan pilih **Rumah Tangga**. Masukkan kode undangan dan pilih **Gabung Ruang Pasangan**.
3. Pembuatan undangan dan penerimaan kode mengaktifkan ruang Rumah Tangga untuk akun masing-masing. Pilih **Pribadi** atau **Rumah Tangga** kapan saja untuk mengganti ruang aktif.

## Catat lewat Telegram

1. Isi `GEMINI_API_KEY` dan `GEMINI_MODEL_FAST` dengan model Flash yang mendukung gambar dan keluaran JSON terstruktur. [Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)
2. Untuk menetapkan menu untuk semua chat pribadi, panggil `setChatMenuButton` melalui Bot API dengan `menu_button.type` bernilai `web_app`, `menu_button.text` bernilai `Buka Dashboard`, dan `menu_button.web_app.url` berisi `NEXT_PUBLIC_APP_URL` HTTPS. [Telegram Bot API](https://core.telegram.org/bots/api#setchatmenubutton)
3. Kirim `belanja sayur 45rb cash, kopi 25rb qris` atau foto struk/QRIS ke bot yang sudah ditautkan. Bot menyimpan hasilnya ke ruang aktif dan menampilkan **Edit** serta **Hapus** untuk setiap transaksi. Untuk mengedit, tekan **Edit** lalu balas pesan koreksi dari bot.

## Kelola dompet

Buka **Ruang**, pilih ruang yang ingin dikelola, lalu gunakan **Dompet** untuk menambah, mengubah, atau menghapus dompet. Dompet dengan riwayat diarsipkan. Penyesuaian saldo awal berlaku sejak dicatat. Transfer antar-dompet mengubah saldo kedua dompet tanpa mengubah pemasukan atau pengeluaran.

## Catat lewat PWA

Buka Beranda dan pilih **+ Catat**. Tulis transaksi lalu tekan **Catat Sekarang**, atau gunakan **Scan Struk / QRIS** untuk memilih gambar dan **Ambil Foto** untuk memakai kamera. Foto langsung diproses setelah dipilih. Setelah transaksi tersimpan, Beranda memuat saldo dan daftar terbaru.

Di Android yang mendukung Web Share Target, pengguna yang sudah masuk dapat membagikan foto dari aplikasi lain ke DompetBareng yang telah dipasang. Foto diproses di memori.

## Riwayat transaksi

Buka **Riwayat** untuk mencari transaksi di ruang aktif atau memfilter menurut **Bulan**, **Dompet**, **Kategori**, dan **Pencatat**. Pencatat dapat membuka **Edit**, lalu memilih **Simpan Perubahan** atau **Hapus Transaksi**.

## Laporan bulanan

Buka **Laporan** dan pilih bulan dalam WIB. Isi `GEMINI_MODEL_ANALYSIS` dengan model analisis yang mendukung JSON terstruktur dan tersedia untuk API key Anda. Ringkasan pertama dibuat otomatis dari angka agregat untuk bulan yang berisi transaksi. Gunakan **Buat Ringkasan AI** untuk memperbaruinya dan **Bagikan Ringkasan** untuk membagikan atau menyalin laporan.

## Jalankan di Vercel

Hubungkan proyek Next.js ke Vercel. Isi variabel dari `.env.example` di pengaturan environment Vercel dan gunakan origin HTTPS deployment sebagai `NEXT_PUBLIC_APP_URL`. Atur URL callback Supabase dan webhook Telegram ke origin tersebut. [Panduan deploy Vercel](https://vercel.com/docs/projects/deploy-from-cli)

Jalankan `npm.cmd run typecheck` dan `npm.cmd run build` untuk memeriksa aplikasi.
