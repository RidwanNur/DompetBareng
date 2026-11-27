import { formatRupiah } from "@/lib/format";
import type { ExpenseCategory, MonthlyAnalysis, MonthlyReport } from "@/types/database";

const wholeFormatter = new Intl.NumberFormat("id-ID");

export function expenseRatioLabel(report: MonthlyReport) {
  if (report.expense_ratio_percent === null) return report.total_expense === "0" ? "-" : "Belum ada pemasukan";
  const [whole, fraction] = report.expense_ratio_percent.split(".");
  const decimals = fraction?.replace(/0+$/, "");
  return wholeFormatter.format(BigInt(whole)) + (decimals ? "," + decimals : "") + "%";
}

const categorySuggestions: Record<ExpenseCategory, string> = {
  "Makan & Minum": "Tetapkan batas belanja makan per minggu dan rencanakan bekal untuk hari kerja.",
  "Belanja Harian": "Gunakan daftar belanja dan cek persediaan sebelum membeli kebutuhan berikutnya.",
  Transportasi: "Gabungkan perjalanan yang searah dan bandingkan biaya setiap rute rutin.",
  "Tagihan & Utilitas": "Periksa tagihan rutin dan hentikan langganan yang sudah jarang dipakai.",
  "Rumah Tangga": "Urutkan kebutuhan rumah berdasarkan urgensi dan jadwalkan belanja yang bisa ditunda.",
  Kesehatan: "Pisahkan kebutuhan kesehatan rutin dalam anggaran dan catat biaya satu kali secara terpisah.",
  "Hiburan & Gaya Hidup": "Tetapkan batas hiburan mingguan dan pilih kegiatan gratis saat mendekati batas.",
  Pendidikan: "Jadwalkan pembelian perlengkapan belajar dan cek bahan yang sudah tersedia.",
  "Sosial & Hadiah": "Sisihkan batas belanja hadiah per acara sebelum memilih barang.",
  Lainnya: "Tinjau transaksi berulang di Lainnya dan tentukan pengeluaran mana yang bisa dihentikan.",
};

export function buildFinancialHealthFallback(report: MonthlyReport): MonthlyAnalysis {
  const { total_income: income, total_expense: expense, net_cash_flow: net, largest_expense: largest } = report;
  const flow = BigInt(net);
  const balance = flow > 0n ? "surplus" : flow < 0n ? "defisit" : "seimbang";
  const comparison = income === "0"
    ? `Pemasukan belum tercatat (${formatRupiah(income)}), dengan pengeluaran ${formatRupiah(expense)}.`
    : `Pengeluaran ${formatRupiah(expense)} adalah ${expenseRatioLabel(report)} dari pemasukan ${formatRupiah(income)}.`;
  const biggest = largest ? ` Pos pengeluaran terbesar adalah ${largest.category} (${formatRupiah(largest.total)}).` : "";
  const suggestions = [
    largest ? categorySuggestions[largest.category] : "Tetapkan batas pengeluaran mingguan dan catat belanja saat terjadi.",
    income === "0" ? "Catat pemasukan yang sudah diterima agar perbandingan bulan ini bisa dihitung."
      : flow < 0n ? "Pisahkan kebutuhan wajib dari belanja fleksibel, lalu tunda belanja fleksibel yang belum diperlukan."
        : "Periksa sisa anggaran setiap akhir minggu sebelum membuat belanja tambahan.",
  ];

  return { narrative: `Arus kas bulan ini ${balance}. ${comparison}${biggest}`, suggestions };
}

export function withFinancialHealthFallback(report: MonthlyReport): MonthlyReport {
  if (!report.transaction_count || (report.analysis && !report.analysis_stale)) return report;
  return {
    ...report, analysis: buildFinancialHealthFallback(report), analysis_stale: false,
    analysis_source: "fallback", analysis_updated_at: null, analysis_retry_at: null,
  };
}
