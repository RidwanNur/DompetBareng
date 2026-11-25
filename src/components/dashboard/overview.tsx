import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { QuickInput, type ShareResult } from "@/components/transactions/quick-input";
import type { DashboardSummary } from "@/types/database";
import { DashboardAmount } from "./amount";
import styles from "./dashboard.module.css";

export function DashboardOverview({ summary, workspaceName, shared }: {
  summary: DashboardSummary;
  workspaceName: string;
  shared?: ShareResult;
}) {
  return (
    <div className={styles.overview}>
      <section className={styles.balance} aria-labelledby="balance-title" data-reveal data-lift>
        <span className={styles.balanceIcon} aria-hidden="true"><Wallet size={25} strokeWidth={1.65} /></span>
        <h2 id="balance-title">Total Saldo</h2>
        <DashboardAmount className={styles.balanceAmount} value={summary.total_balance} />
        <QuickInput workspaceId={summary.workspace_id} workspaceName={workspaceName} recordClassName={styles.record} shared={shared} />
      </section>
      <section className={styles.cashFlow} aria-label="Arus kas bulan ini" data-reveal data-lift>
        <div className={styles.metric}>
          <span className={styles.incomeIcon} aria-hidden="true"><ArrowDownLeft size={21} strokeWidth={1.7} /></span>
          <dl className={styles.metricCopy}>
            <dt>Pemasukan Bulan Ini</dt>
            <DashboardAmount as="dd" className={styles.metricAmount} value={summary.total_income} />
          </dl>
        </div>
        <div className={styles.metric}>
          <span className={styles.expenseIcon} aria-hidden="true"><ArrowUpRight size={21} strokeWidth={1.7} /></span>
          <dl className={styles.metricCopy}>
            <dt>Pengeluaran Bulan Ini</dt>
            <DashboardAmount as="dd" className={styles.metricAmount} value={summary.total_expense} />
          </dl>
        </div>
      </section>
    </div>
  );
}
