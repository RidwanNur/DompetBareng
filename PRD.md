# PRD · Aplikasi kecil "DompetBareng"

Versi 1 · 25 Nov 2026 · Dibuat dengan Pembuat PRD (malikisaputra.biz.id/prd)

## 1. Ringkasan

Aplikasi pencatat keuangan berbasis AI (PWA mobile-first dan Bot Telegram) yang mendukung banyak pengguna secara mandiri maupun mode bersama untuk pasangan suami-istri. Pengguna cukup mengirim teks singkat atau foto struk/QRIS untuk mencatat arus kas harian, lalu mendapatkan laporan keuangan bulanan otomatis beserta kesimpulan AI terkait tingkat kesehatan pemasukan dan pengeluarannya.

## 2. Tujuan & ukuran berhasil

| # | Tujuan | Ukuran berhasil (bisa dicek) |
|---|---|---|
| T1 | Pengguna baru dapat mendaftar akun, masuk ke aplikasi PWA, dan menautkan akun Telegram-nya secara mandiri | Pengguna berhasil mendaftar/login via email atau Google di PWA lalu menautkan Bot Telegram lewat kode aktivasi unik hingga status di aplikasi tampil "Telegram Terhubung" |
| T2 | Pasangan suami-istri dapat bergabung ke satu ruang keuangan rumah tangga bersama untuk mencatat dan memantau pemasukan serta pengeluaran secara transparan | Pengguna A dapat membuat kode undangan ruang rumah tangga, Pengguna B bergabung lewat kode tersebut, dan transaksi keduanya langsung masuk ke satu dashboard dengan label pencatat masing-masing |
| T3 | Pengguna dapat mencatat transaksi harian tepat lewat ketikan teks singkat maupun foto struk/screenshot QRIS melalui Bot Telegram atau PWA | Input teks seperti "belanja sayur 45rb cash, kopi 25rb qris" atau foto struk/QRIS otomatis tersimpan menjadi data nominal, kategori, dan dompet yang sesuai dalam waktu kurang dari 5 detik |
| T4 | Pengguna dapat melihat laporan keuangan bulanan lengkap berisi total pemasukan, total pengeluaran, arus kas bersih, dan rincian per kategori serta dompet | Halaman Laporan Bulanan menampilkan total pemasukan, total pengeluaran, selisih (surplus/defisit), dan grafik kategori yang cocok 100% dengan transaksi bulan yang dipilih, serta saldo tiap dompet yang cocok 100% dengan saldo akhir kumulatif hingga akhir bulan tersebut |
| T5 | Sistem menghasilkan kesimpulan otomatis dari AI mengenai tingkat kesehatan perbandingan pemasukan dan pengeluaran setiap bulan | Halaman Laporan Bulanan menampilkan kartu "Kesehatan Keuangan AI" berisi rasio pengeluaran terhadap pemasukan, status kesehatan (Sehat/Waspada/Defisit), pos pengeluaran terbesar, serta 2–3 saran penghematan spesifik berdasarkan data bulan tersebut |
| T6 | Pengguna dapat mengedit atau menghapus transaksi yang keliru serta mengakses PWA dengan nyaman dari smartphone | Perubahan atau penghapusan transaksi langsung memperbarui saldo dompet dan laporan bulanan secara real-time, serta PWA bisa diinstal ke homescreen Android dan dibuka dari tombol Menu Bot Telegram |

## 3. Pengguna

1. **Pengguna Individu**: Pekerja atau anak muda yang ingin mencatat pengeluaran harian lewat smartphone tanpa repot mengisi form panjang, lalu memantau sisa cashflow bulanan.
2. **Pasangan / Suami-Istri**: Dua pengguna dengan akun dan smartphone masing-masing yang ingin menggabungkan pencatatan pemasukan dan pengeluaran rumah tangga di satu tempat, mengetahui siapa mencatat apa, serta mengevaluasi kesehatan keuangan keluarga tiap bulan.

## 4. Lingkup

**Masuk:**

- Bahasa Indonesia dan mata uang Rupiah (IDR), autentikasi multi-user (Email/Google), penautan akun Bot Telegram per pengguna, mode ruang Pribadi dan Ruang Rumah Tangga (2 anggota/pasangan via kode undangan), pencatatan transaksi teks singkat & scan foto struk/QRIS via Bot Telegram maupun PWA, manajemen dompet (Tunai, Bank, E-Wallet), riwayat transaksi dengan filter & edit/hapus, laporan keuangan bulanan (pemasukan, pengeluaran, surplus/defisit, grafik kategori), ringkasan kesehatan keuangan bulanan berbasis AI, PWA installable di Android (manifest & Web Share Target), serta integrasi tombol Menu Telegram Mini App.
- Manajemen dompet mencakup tambah dompet baru, ubah nama/tipe dompet, sesuaikan saldo awal (*balance adjustment*), dan transfer antar-dompet. Transfer adalah mutasi internal dan tidak dihitung sebagai pemasukan/pengeluaran di laporan bulanan. Dompet dapat langsung dihapus jika belum ada transaksi dan diarsipkan jika sudah memiliki riwayat transaksi.

**Tidak masuk (jangan dibuat):**

- Pembukuan usaha/UMKM (stok barang, kasir/POS, faktur, laporan laba-rugi bisnis), grup lebih dari 2 anggota atau split-bill komunitas, koneksi otomatis/scraping ke mutasi rekening bank dan e-wallet, fitur multi-bahasa atau multi-mata uang, rekomendasi produk investasi (saham/kripto/reksa dana), aplikasi Android native (APK/Play Store), dan bot WhatsApp.

## 5. Fitur / layar (urut dari awal)

| # | Fitur | Yang bisa dilakukan pengguna | Teks persis |
|---|---|---|---|
| 1 | Daftar / Masuk & Tautkan Telegram | Mendaftar atau masuk dengan email/Google, lalu menghubungkan akun ke Bot Telegram memakai tautan/kode unik agar bot mengenali pemilik akun. | Judul: "Masuk ke SakuBareng" \| Tombol: "Masuk dengan Google", "Hubungkan Telegram" \| Status: "Telegram Terhubung" |
| 2 | Pengaturan Ruang (Pribadi & Pasangan) | Memilih ruang pribadi atau membuat ruang rumah tangga bersama pasangan, membuat kode undangan, atau memasukkan kode undangan pasangan untuk bergabung. | Tab: "Pribadi", "Rumah Tangga" \| Tombol: "Buat Kode Undangan", "Gabung Ruang Pasangan" \| Input: "Masukkan 6 digit kode undangan" |
| 3 | Bot Telegram (Input Utama) | Mengirim teks transaksi singkat atau foto struk/QRIS ke bot, lalu menerima balasan ringkasan transaksi lengkap dengan tombol untuk edit atau hapus. | Balasan: "Tercatat! [Item] - Rp[Nominal] ([Kategori])" \| Tombol: "Edit", "Hapus" \| Tombol menu: "Buka Dashboard" |
| 4 | Beranda / Dashboard PWA | Melihat total saldo dompet, ringkasan pemasukan dan pengeluaran bulan berjalan, berganti ruang (Pribadi/Rumah Tangga), serta melihat 5 transaksi terakhir beserta label pencatatnya. | Label: "Total Saldo", "Pemasukan Bulan Ini", "Pengeluaran Bulan Ini", "Transaksi Terakhir" \| Tombol utama: "+ Catat" |
| 5 | Input (Teks & Scan Struk) | Mengetik satu atau beberapa transaksi sekaligus dengan bahasa sehari-hari, memotret struk, atau memilih gambar/screenshot QRIS dari galeri untuk diproses AI. | Placeholder: "Contoh: belanja sayur 45rb cash, kopi 25rb qris" \| Tombol: "Scan Struk / QRIS", "Catat Sekarang" \| Notifikasi: "Transaksi berhasil disimpan" |
| 6 | Riwayat & Filter Transaksi | Riwayat & Filter Transaksi | Placeholder: "Cari transaksi..." \| Filter: "Bulan", "Dompet", "Kategori", "Pencatat" \| Tombol: "Simpan Perubahan", "Hapus Transaksi" |
| 7 | Laporan Bulanan & Analisis AI | Melihat rekap total masuk, total keluar, selisih (surplus/defisit), grafik per kategori, dan membaca kesimpulan AI terkait tingkat kesehatan keuangan bulan tersebut. | Judul: "Laporan Bulanan" \| Kartu: "Kesehatan Keuangan AI" \| Status: "Sehat" / "Waspada" / "Defisit" / "Belum Ada Data" \| Rasio saat pemasukan Rp0: "-" / "Belum ada pemasukan" \| Tombol: "Buat Ringkasan AI", "Bagikan Ringkasan" |

Teks di kolom **Teks persis** wajib dipakai kata per kata, tanpa diubah. Bagian 5 menjadi acuan tunggal untuk seluruh tampilan UI dan pemeriksaan akhir, termasuk "Telegram Terhubung" dan "Kesehatan Keuangan AI".

## 6. Arah desain

- **Pola tata letak (Modern terang):** kartu putih radius 16 px di atas latar abu terang, tombol utama satu warna aksen, ikon garis, jarak lega.
- **Nuansa:** Mewah dengan teks gelap/netral, judul serif, jarak lega, dan aksen tipis. Gunakan *light mode* sebagai tampilan utama dengan latar abu terang dan kartu putih.
- **Tata letak:** Tab bawah seperti aplikasi HP.
- **Palet warna:**
  - Latar halaman `#F8FAFC`.
  - Kartu/permukaan `#FFFFFF` dengan border halus `#E2E8F0`.
  - Teks utama `#0F172A` dan teks sekunder `#64748B`.
  - Warna utama (Teal gelap) `#0F766E`.
  - Warna aksen (Indigo untuk badge/kartu AI) `#4F46E5`.
  - Pemasukan/Sehat `#16A34A`, Pengeluaran/Defisit `#DC2626`, dan Waspada `#D97706`.
- **Tipografi:** maksimal 2 keluarga font dari Google Fonts. Judul memakai Lora (serif, bobot 600–700). Isi dan UI memakai Plus Jakarta Sans (sans-serif, bobot 400–700). Aktifkan `tabular-nums` untuk seluruh tampilan nominal angka.
- **Animasi:**
  - Elemen muncul (fade + naik 16 px, 400–600 ms) saat masuk layar, pakai IntersectionObserver.
  - Kartu & tombol terangkat 2–4 px dengan bayangan saat disentuh kursor (200 ms).
  - Visual latar bergerak lebih lambat dari isi saat digulir (maks. 40 px).
  - Semua animasi mati bila pengguna memilih `prefers-reduced-motion`.
- **Hindari tampilan template:** jangan semua bagian rata tengah, jangan tiga kartu kembar tanpa variasi, jangan gradien ungu-biru acak, jangan emoji sebagai ikon, beri jarak antarbagian yang lega (minimal 96 px di laptop).

## 7. Persyaratan

- R1. Menggunakan Next.js (App Router) + Tailwind CSS yang di-deploy di Vercel, Supabase (PostgreSQL, Supabase Auth, dan Row Level Security untuk isolasi data antar-pengguna/ruang), Google Gemini API (@google/genai), serta Telegram Bot API (Webhook). Pemilihan model AI wajib dikonfigurasi melalui environment variable (tidak di-hardcode) dengan skema hybrid: model seri Flash (mis. Gemini 2.5 Flash atau versi terbaru) dengan Structured Output JSON untuk parsing teks & OCR struk berkecepatan tinggi, serta opsi model seri Pro (mis. Gemini 2.5 Pro atau versi terbaru) untuk menghasilkan analisis kesehatan keuangan bulanan yang lebih mendalam. Semua nominal disimpan sebagai bilangan bulat (BIGINT), total laporan bulanan wajib dihitung oleh SQL/backend (bukan AI), dan webhook wajib menangani idempotency via telegram_message_id agar tidak ada pencatatan ganda.

**Wajib dipertahankan (jangan dihapus, diganti nama, atau dipindah ke elemen lain):**

1. Berkas inti dengan struktur modular dan sederhana (standar Next.js App Router)
   - `public/manifest.json` (konfigurasi PWA & Web Share Target)
   - `supabase/schema.sql` (skema tabel database + kebijakan RLS)
   - `.env.example` (daftar variabel environment: Supabase, Gemini model Flash/Pro, Telegram)
   - `src/types/database.ts` (tipe TypeScript untuk transaksi, dompet, ruang, laporan)
   - `src/lib/supabase/client.ts` & `src/lib/supabase/server.ts` (koneksi database & auth)
   - `src/lib/gemini.ts` (parser transaksi teks/foto & generator analisis bulanan)
   - `src/lib/telegram.ts` (helper kirim pesan & verifikasi webhook)
   - `src/lib/format.ts` (format Rupiah & tanggal Indonesia)
   - `src/app/page.tsx` (Beranda), `src/app/login/page.tsx`, `src/app/riwayat/page.tsx`, `src/app/laporan/page.tsx`, `src/app/ruang/page.tsx`
   - `src/app/api/webhook/telegram/route.ts`
   - `src/app/api/transactions/route.ts` & `src/app/api/transactions/[id]/route.ts`
   - `src/app/api/reports/monthly/route.ts`
   - `src/app/api/workspaces/route.ts`
   - `src/components/` (folder `layout/`, `dashboard/`, `transactions/`, `reports/`)
2. Selector & atribut wajib (konsisten untuk navigasi, interaksi, dan pengujian)
   - `#bottom-nav` (navigasi bawah mobile)
   - `#workspace-switcher` (pemilih ruang Pribadi / Rumah Tangga)
   - `#quick-input-btn`, `#quick-input-modal`, `#receipt-upload-input`
   - `#transaction-list`, `[data-transaction-id]`
   - `#monthly-report-summary`, `#ai-health-card`
   - `#telegram-connect-btn`
3. Aturan kerapian
   - Pisahkan logika AI, query database, dan Telegram di `src/lib/` (jangan ditulis langsung di komponen UI).
   - Jangan mengubah nama berkas API, skema SQL, atau selector di atas saat iterasi fitur.
   - Kelas yang dibuat oleh JavaScript tetap harus punya gaya di CSS.

## 8. Fakta yang boleh dipakai

- Mata uang tunggal Rupiah (IDR). Seluruh nominal disimpan sebagai bilangan bulat (BIGINT) tanpa desimal dengan zona waktu default WIB (Asia/Jakarta).
- Setiap pengguna yang mendaftar otomatis mendapatkan 1 ruang "Pribadi" dan 3 dompet bawaan (Tunai, Bank, E-Wallet).
- Ruang "Rumah Tangga" berkapasitas 2 anggota (pasangan). Kode undangan terdiri dari 6 digit angka (`000000`–`999999`) dan berlaku 24 jam. Kode hanya bisa dipakai sekali, otomatis nonaktif setelah pasangan bergabung, dan bisa dibuat ulang kapan saja. Setiap transaksi wajib menyimpan identitas pencatat (`created_by`).
- Penautan Bot Telegram dilakukan per pengguna memakai token sekali pakai (`/start <token>`) dari halaman PWA. Jika pengguna memiliki ruang Pribadi dan Rumah Tangga, input dari Telegram otomatis masuk ke ruang aktif (default) yang dipilih pengguna.
- Isolasi data wajib ditegakkan di level database menggunakan Supabase Row Level Security (RLS) sehingga pengguna hanya bisa mengakses data ruang miliknya atau ruang tempat ia bergabung.
- Kategori Gemini memakai daftar tetap berikut.
  - Pengeluaran: `Makan & Minum`, `Belanja Harian`, `Transportasi`, `Tagihan & Utilitas`, `Rumah Tangga`, `Kesehatan`, `Hiburan & Gaya Hidup`, `Pendidikan`, `Sosial & Hadiah`, `Lainnya`.
  - Pemasukan: `Gaji`, `Bonus & Tunjangan`, `Usaha / Sampingan`, `Hadiah / Transfer Masuk`, `Lainnya`.
- Bukti QRIS tanpa sumber dana otomatis memakai dompet bertipe `ewallet` (default `E-Wallet`). Bukti transfer bank tanpa keterangan spesifik memakai `Bank`. Teks tanpa metode bayar memakai `Tunai`.
- Pemilihan model AI diatur lewat environment variable (`GEMINI_MODEL_FAST` untuk parsing teks & OCR struk dengan Structured Output JSON, `GEMINI_MODEL_ANALYSIS` untuk analisis kesehatan bulanan).
- Webhook Telegram wajib mengecek secret token dan menerapkan idempotency berbasis `telegram_message_id` agar tidak ada pencatatan ganda. Batasi maksimal 30 pesan/proses AI per akun per hari dan reset pukul 00.00 WIB. Bila kuota habis, beri notifikasi sopan yang menyarankan input lewat PWA atau coba lagi besok.
- Pencatatan transaksi menggunakan mekanisme auto-save (langsung tersimpan dan memperbarui saldo dompet terkait) disertai aksi Edit/Hapus jika hasil pembacaan AI meleset.
- Semua angka pada Laporan Bulanan (total pemasukan, total pengeluaran, surplus/defisit, rasio, dan total per kategori) dihitung terlebih dahulu oleh SQL/backend. Ringkasan pemasukan, pengeluaran, dan surplus/defisit hanya mencakup transaksi di bulan yang dipilih dan mengecualikan transfer antar-dompet. Saldo per dompet bersifat kumulatif hingga akhir bulan yang dipilih, termasuk saldo dari bulan sebelumnya dan transaksi masuk, keluar, serta transfer sampai akhir bulan tersebut.
- Ringkasan AI dibuat otomatis secara *on-demand* saat pengguna pertama kali membuka Laporan Bulanan untuk bulan yang sudah memiliki minimal 1 transaksi dan belum memiliki ringkasan tersimpan. Simpan hasilnya di database. Tombol "Buat Ringkasan AI" dapat memicu pembuatan atau pembaruan ringkasan, misalnya setelah pengguna menambah atau mengedit transaksi, dengan batas 5 kali *regenerate* per hari per ruang.
- Backend/SQL menentukan status kesehatan secara deterministik dari rasio `pengeluaran / pemasukan × 100%`.
  - `Sehat` jika pengeluaran ≤ 70% dari pemasukan (surplus ≥ 30%).
  - `Waspada` jika pengeluaran > 70% hingga ≤ 100% dari pemasukan.
  - `Defisit` jika pengeluaran > 100% dari pemasukan.
  - Jika pemasukan dan pengeluaran sama-sama Rp0, tampilkan rasio `"-"` serta status `"Belum Ada Data"` dan jangan panggil Gemini.
  - Jika pemasukan Rp0 dan pengeluaran lebih dari Rp0, tampilkan rasio `"Belum ada pemasukan"`, tetapkan status `"Defisit"`, dan izinkan ringkasan AI yang mencatat bahwa pemasukan bulan tersebut belum tercatat.
- Gemini hanya menerima status dan angka agregat yang sudah ditentukan untuk menyusun narasi evaluasi, pos pengeluaran terbesar, dan 2–3 saran penghematan spesifik.

Hanya fakta di atas yang boleh muncul. Selain itu tulis tanda `[ISI: …]`.

## 9. Larangan (penting)

- Jangan menambah angka (jumlah klien, tahun, rating, statistik) yang tidak tertulis di PRD.
- Jangan menulis harga atau promo yang tidak tertulis di PRD.
- Jangan membuat testimoni, ulasan, atau logo klien.
- Jangan menambah janji atau garansi ("24 jam", "pasti laku").
- Jangan mengarang nama orang, alamat, atau kontak.
- Jangan menambah fitur atau bagian di luar lingkup.
- Dilarang menampilkan, menggabungkan, atau membocorkan data transaksi dan saldo antar-pengguna atau antar-pasangan yang tidak berada dalam satu ruang bersama.
- Dilarang melakukan hardcode API key, token bot Telegram, `telegram_user_id`, maupun nama model Gemini di dalam kode sumber (wajib melalui environment variable).
- Dilarang meminta AI menjumlahkan ratusan baris transaksi mentah secara langsung untuk menghitung total laporan bulanan.
- Dilarang membiarkan AI memberikan saran investasi spesifik (saham, kripto, reksa dana, pinjaman) atau nasihat keuangan berlisensi. Kesimpulan AI hanya boleh membahas perbandingan pemasukan-pengeluaran, pos belanja terbesar, dan langkah penghematan arus kas.
- Dilarang memaksa pengguna melewati form konfirmasi berlapis saat input transaksi harian via Telegram maupun Input PWA.
- Dilarang menyimpan file gambar struk mentah secara permanen jika tidak diperlukan. Cukup simpan hasil ekstraksi terstruktur dan catatan input mentah (`raw_input`).
- Dilarang mengubah nama endpoint API, struktur folder inti, skema SQL, maupun selector wajib yang sudah ditetapkan pada Langkah 6 saat iterasi pengembangan.
- Dilarang menambahkan fitur di luar lingkup (pembukuan UMKM, stok/kasir, grup lebih dari 2 anggota, multi-bahasa/multi-mata uang, scraping mutasi bank, atau integrasi WhatsApp).

## 10. Kriteria selesai

1. Ketika hasil dicek untuk tujuan T1, maka pengguna berhasil mendaftar/login via email atau Google di PWA lalu menautkan Bot Telegram lewat kode aktivasi unik hingga status di aplikasi tampil "Telegram Terhubung".
2. Ketika hasil dicek untuk tujuan T2, maka pengguna A dapat membuat kode undangan ruang rumah tangga, Pengguna B bergabung lewat kode tersebut, dan transaksi keduanya langsung masuk ke satu dashboard dengan label pencatat masing-masing.
3. Ketika hasil dicek untuk tujuan T3, maka input teks seperti "belanja sayur 45rb cash, kopi 25rb qris" atau foto struk/QRIS otomatis tersimpan menjadi data nominal, kategori, dan dompet yang sesuai dalam waktu kurang dari 5 detik.
4. Ketika hasil dicek untuk tujuan T4, maka halaman Laporan Bulanan menampilkan total pemasukan, total pengeluaran, selisih (surplus/defisit), dan grafik kategori yang cocok 100% dengan transaksi bulan yang dipilih, serta saldo tiap dompet yang cocok 100% dengan saldo akhir kumulatif hingga akhir bulan tersebut.
5. Ketika hasil dicek untuk tujuan T5, maka halaman Laporan Bulanan menampilkan kartu "Kesehatan Keuangan AI" berisi rasio pengeluaran terhadap pemasukan, status kesehatan (Sehat/Waspada/Defisit), pos pengeluaran terbesar, serta 2–3 saran penghematan spesifik berdasarkan data bulan tersebut.
6. Ketika hasil dicek untuk tujuan T6, maka perubahan atau penghapusan transaksi langsung memperbarui saldo dompet dan laporan bulanan secara real-time, serta PWA bisa diinstal ke homescreen Android dan dibuka dari tombol Menu Bot Telegram.
7. Ketika pengguna menjalankan setiap fitur di tabel, maka fitur itu bekerja tanpa error di Console.
8. Ketika halaman dimuat ulang, maka data yang sudah dimasukkan tetap ada.
9. Ketika dibuka di HP lebar 375 px, maka semua tombol bisa ditekan dan tidak ada yang terpotong.
10. Ketika hasil dilihat sekilas, maka nuansa "Mewah" terasa (sesuai ciri di bagian 6), bukan tampilan template umum.
11. Ketika seluruh hasil dibaca, maka tidak ada yang melanggar bagian 9 (Larangan).

## 11. Langkah kerja (ikuti berurutan, jangan berhenti di tengah)

Kerjakan TASKS dari T0 sampai T9, satu task per giliran. Periksa bagian "Selesai bila" untuk setiap task.

1. Baca seluruh PRD. Bila ada `[ISI: …]` atau yang tidak jelas, tanyakan dulu. Jangan menebak.
2. Tulis rencana singkat (daftar file, struktur data, dan daftar fitur).
3. Bangun fitur satu per satu sesuai tabel. Uji tiap fitur sebelum lanjut.
4. Cek setiap kriteria selesai, perbaiki yang belum lolos.
5. Kirim semua file secara utuh dan cara menjalankannya.
