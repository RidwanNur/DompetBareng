import { DashboardAmount } from "@/components/dashboard/amount";
import type { MonthlyReport, Rupiah } from "@/types/database";
import styles from "./report.module.css";

export function MonthlySummary({ report }: { report: MonthlyReport }) {
  const net = BigInt(report.net_cash_flow);

  return (
    <section id="monthly-report-summary" className={styles.summary} aria-label="Ringkasan arus kas" data-reveal data-lift>
      <dl className={styles.metrics}>
        <div className={styles.metric}>
          <dt>Total Pemasukan</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={report.total_income} />
        </div>
        <div className={styles.metric}>
          <dt>Total Pengeluaran</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={report.total_expense} />
        </div>
        <div className={styles.netMetric}>
          <dt>Arus Kas Bersih</dt>
          <DashboardAmount as="dd" className={styles.metricAmount} value={net} />
          {net !== 0n && <dd className={styles.netStatus} data-direction={net > 0n ? "positive" : "negative"}>{net > 0n ? "Surplus" : "Defisit"}</dd>}
        </div>
      </dl>
    </section>
  );
}

function barWidth(value: Rupiah, total: Rupiah) {
  const base = BigInt(total);
  return base === 0n ? "0%" : String(Number(BigInt(value) * 10_000n / base) / 100) + "%";
}

export function CategoryChart({ report }: { report: MonthlyReport }) {
  const groups = [
    { type: "expense", label: "Pengeluaran", total: report.total_expense },
    { type: "income", label: "Pemasukan", total: report.total_income },
  ] as const;

  return (
    <section id="monthly-category-chart" className={styles.panel} aria-labelledby="category-chart-title" data-reveal data-lift>
      <h2 id="category-chart-title">Grafik Kategori</h2>
      {groups.map(({ type, label, total }) => {
        const entries = report.category_totals.filter((entry) => entry.type === type);
        return (
          <div key={type} className={styles.chartGroup}>
            <h3>{label}</h3>
            {entries.length ? (
              <ul className={styles.bars}>
                {entries.map((entry) => (
                  <li key={entry.category}>
                    <div className={styles.barLabel}>
                      <span>{entry.category}</span>
                      <DashboardAmount className={styles.barAmount} value={entry.total} />
                    </div>
                    <div className={styles.track} aria-hidden="true">
                      <span data-direction={type} style={{ inlineSize: barWidth(entry.total, total) }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className={styles.muted}>Belum ada {label.toLowerCase()}.</p>}
          </div>
        );
      })}
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
