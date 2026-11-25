import { redirect } from "next/navigation";
import { TransactionHistoryView } from "@/components/transactions/history";
import styles from "@/components/transactions/history.module.css";
import { getCurrentUser } from "@/lib/auth";
import { getTransactionHistory } from "@/lib/history";
import { getWorkspaceState } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

async function historyData() {
  const spaces = await getWorkspaceState();
  return {
    history: await getTransactionHistory(spaces.active_workspace_id),
    sharedRoom: spaces.household?.id === spaces.active_workspace_id,
  };
}

export default async function HistoryPage() {
  if (!(await getCurrentUser())) redirect("/login");
  const data = await historyData().catch(() => null);

  return (
    <main className="app-main">
      <div className={styles.page}>
        <h1 data-reveal>Riwayat Transaksi</h1>
        {data ? (
          <TransactionHistoryView key={data.history.workspace_id} initialHistory={data.history} sharedRoom={data.sharedRoom} />
        ) : (
          <div className={styles.listCard} data-reveal data-lift>
            <p role="alert">Riwayat belum bisa dimuat.</p>
            <a href="/riwayat" className={styles.neutralButton} data-lift>Coba Lagi</a>
          </div>
        )}
      </div>
    </main>
  );
}
