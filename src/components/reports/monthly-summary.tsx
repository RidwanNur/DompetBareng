import Link from "next/link";
import { DashboardAmount } from "@/components/dashboard/amount";
import { formatRupiah } from "@/lib/format";
import type { MonthlyReport, MonthlyReportDetails, Rupiah } from "@/types/database";
import styles from "./report.module.css";

const shortMonth = new Intl.DateTimeFormat("id-ID", { month: "short", timeZone: "Asia/Jakarta" });
const shortDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
const number = new Intl.NumberFormat("id-ID");

function compactRupiah(amount: Rupiah | bigint) {
  return formatRupiah(amount).replace(/\s/g, "");
}

function comparisonPercent(delta: bigint, base: bigint) {
  const absoluteDelta = delta < 0n ? -delta : delta;
  const absoluteBase = base < 0n ? -base : base;
  const hundredths = (absoluteDelta * 10_000n + absoluteBase / 2n) / absoluteBase;
  if (hundredths === 0n) return "<0,01%";
  const whole = number.format(hundredths / 100n);
  const fraction = String(hundredths % 100n).padStart(2, "0").replace(/0+$/, "");
  return whole + (fraction ? "," + fraction : "") + "%";
}

type Metric = "income" | "expense" | "net";

function Comparison({ metric, current, previous, month }: { metric: Metric; current: Rupiah; previous: Rupiah; month: string }) {
  const before = BigInt(previous);
  const now = BigInt(current);
  const delta = now - before;
  const comparedMonth = shortMonth.format(new Date(month + "-01T12:00:00+07:00"));
  const tone = delta === 0n ? "neutral" : (metric === "expense" ? delta < 0n : delta > 0n) ? "positive" : "negative";
  const crossedZero = (before < 0n && now > 0n) || (before > 0n && now < 0n);
  let text: string;
  if (delta === 0n) text = before === 0n ? `Belum ada data ${comparedMonth}` : `0% vs ${comparedMonth}`;
  else if (before === 0n || crossedZero) text = `${delta > 0n ? "+" : ""}${compactRupiah(delta)} vs ${comparedMonth}`;
  else text = `${delta > 0n ? "▲" : "▼"} ${comparisonPercent(delta, before)} vs ${comparedMonth}`;

  return <dd className={styles.comparison} data-comparison={metric} data-tone={tone}>{text}</dd>;
}

export function MonthlySummary({ report, details }: { report: MonthlyReport; details: MonthlyReportDetails }) {
  const net = BigInt(report.net_cash_flow);
  const previous = details.previous_month;

  return (
    <section id="monthly-report-summary" className={styles.summary} aria-label="Ringkasan arus kas" data-reveal data-lift>
      <dl className={styles.metrics}>
        <div className={styles.metric}>
          <dt>Total Pemasukan</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={report.total_income} />
          {previous && <Comparison metric="income" current={report.total_income} previous={previous.total_income} month={previous.month} />}
        </div>
        <div className={styles.metric}>
          <dt>Total Pengeluaran</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={report.total_expense} />
          {previous && <Comparison metric="expense" current={report.total_expense} previous={previous.total_expense} month={previous.month} />}
        </div>
        <div className={styles.netMetric}>
          <dt>Arus Kas Bersih</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={net} />
          {previous && <Comparison metric="net" current={report.net_cash_flow} previous={previous.net_cash_flow} month={previous.month} />}
          {net !== 0n && <dd className={styles.netStatus} data-direction={net > 0n ? "positive" : "negative"}>{net > 0n ? "Surplus" : "Defisit"}</dd>}
        </div>
      </dl>
      <dl className={styles.dailyAverage}>
        <dt>Rata-rata Pengeluaran Harian</dt>
        <dd>{compactRupiah(details.average_daily_expense)}/hari</dd>
      </dl>
    </section>
  );
}

export function CategoryChart({ details }: { details: MonthlyReportDetails }) {
  const groups = [
    { type: "expense", label: "Pengeluaran" },
    { type: "income", label: "Pemasukan" },
  ] as const;

  return (
    <section id="monthly-category-chart" className={styles.panel} aria-labelledby="category-chart-title" data-reveal data-lift>
      <h2 id="category-chart-title">Grafik Kategori</h2>
      {groups.map(({ type, label }) => {
        const entries = details.category_stats.filter((entry) => entry.type === type);
        return (
          <div key={type} className={styles.chartGroup}>
            <h3>{label}</h3>
            {entries.length ? (
              <ul className={styles.bars}>
                {entries.map((entry) => {
                  const filters = new URLSearchParams({ month: details.month, type, category: entry.category });
                  return (
                    <li key={entry.category}>
                      <Link className={styles.categoryLink} href={`/riwayat?${filters}`}>
                        <div className={styles.categoryDetails}>
                          <div className={styles.barLabel}>
                            <span>{entry.category}</span>
                            <DashboardAmount className={styles.barAmount} value={entry.total} />
                          </div>
                          <p className={styles.categoryStats}>{entry.percent.replace(".", ",")}% · {number.format(entry.transaction_count)} transaksi</p>
                          <div className={styles.track} aria-hidden="true">
                            <span data-direction={type} style={{ inlineSize: entry.percent + "%" }} />
                          </div>
                        </div>
                        <span className={styles.categoryArrow} aria-hidden="true">›</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.muted}>Belum ada {label.toLowerCase()}.</p>}
          </div>
        );
      })}
    </section>
  );
}

export function LargestExpenses({ expenses, sharedRoom }: { expenses: MonthlyReportDetails["largest_expenses"]; sharedRoom: boolean }) {
  return (
    <section id="largest-expenses" className={styles.panel} aria-labelledby="largest-expenses-title" data-reveal data-lift>
      <h2 id="largest-expenses-title">3 Transaksi Terbesar</h2>
      {expenses.length ? (
        <ol className={styles.largestExpenses}>
          {expenses.map(({ id, item, occurred_at, category, wallet_name, amount, creator_name }) => (
            <li key={id} data-transaction-id={id}>
              <div className={styles.expenseDetails}>
                <p>{item}</p>
                <p className={styles.categoryStats}>
                  <time dateTime={occurred_at}>{shortDate.format(new Date(occurred_at))}</time> · {category} · {wallet_name}
                  {sharedRoom && creator_name && <> · <span className={styles.expenseRecorder}>{creator_name}</span></>}
                </p>
              </div>
              <DashboardAmount className={styles.largestAmount} value={amount} />
            </li>
          ))}
        </ol>
      ) : <p className={styles.muted}>Belum ada pengeluaran di bulan ini.</p>}
    </section>
  );
}

export function WalletBalances({ report }: { report: MonthlyReport }) {
  return (
    <section id="monthly-wallet-balances" className={styles.panel} aria-labelledby="wallet-balances-title" data-reveal data-lift>
      <h2 id="wallet-balances-title">Saldo Akhir Dompet</h2>
      {report.wallet_balances.length ? (
        <dl className={styles.wallets}>
          {report.wallet_balances.map((wallet) => (
            <div key={wallet.wallet_id}>
              <dt>{wallet.wallet_name}</dt>
              <DashboardAmount as="dd" className={styles.walletAmount} value={wallet.balance} />
            </div>
          ))}
        </dl>
      ) : <p className={styles.muted}>Belum ada dompet.</p>}
    </section>
  );
}
