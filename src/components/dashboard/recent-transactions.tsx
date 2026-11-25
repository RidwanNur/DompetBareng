import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatDate } from "@/lib/format";
import type { DashboardTransaction } from "@/types/database";
import { DashboardAmount } from "./amount";
import styles from "./dashboard.module.css";

export function RecentTransactions({ transactions }: { transactions: DashboardTransaction[] }) {
  return (
    <section className={styles.recent} aria-labelledby="recent-title" data-reveal data-lift>
      <h2 id="recent-title">Transaksi Terakhir</h2>
      <ul id="transaction-list" className={styles.transactionList}>
        {transactions.length ? transactions.map((transaction) => {
          const incoming = transaction.type === "income";
          const EntryIcon = incoming ? ArrowDownLeft : ArrowUpRight;
          const directionStyle = incoming ? styles.incomeIcon : styles.expenseIcon;
          const nominal = BigInt(transaction.amount);

          return (
            <li key={transaction.id} data-transaction-id={transaction.id} className={styles.transaction}>
              <span className={directionStyle} aria-hidden="true"><EntryIcon size={19} strokeWidth={1.7} /></span>
              <div className={styles.transactionCopy}>
                <p className={styles.transactionName}>{transaction.item}</p>
                <p className={styles.transactionMeta}>{transaction.category} · {transaction.wallet_name}</p>
                <p className={styles.transactionMeta}>
                  <time dateTime={transaction.occurred_at}>{formatDate(transaction.occurred_at)}</time>
                  {" · "}<span className={styles.recorder}>{transaction.recorded_by === "self" ? "Anda" : "Pasangan"}</span>
                </p>
              </div>
              <DashboardAmount className={styles.transactionAmount} value={incoming ? nominal : -nominal} showPlus={incoming} />
            </li>
          );
        }) : <li className={styles.empty}>Belum ada transaksi di ruang ini.</li>}
      </ul>
    </section>
  );
}
