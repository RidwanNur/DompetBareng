import { redirect } from "next/navigation";
import { TransactionHistoryView } from "@/components/transactions/history";
import styles from "@/components/transactions/history.module.css";
import { getCurrentUser } from "@/lib/auth";
import { getTransactionHistory } from "@/lib/history";
import { readHistoryPageFilters, serializeHistoryFilters } from "@/lib/history-filters";
import { getWorkspaceState } from "@/lib/workspaces";
import type { TransactionHistoryFilters } from "@/types/database";

export const dynamic = "force-dynamic";

async function historyData(filters: TransactionHistoryFilters) {
  const spaces = await getWorkspaceState();
  return {
    history: await getTransactionHistory(spaces.active_workspace_id, filters),
    sharedRoom: spaces.household?.id === spaces.active_workspace_id,
  };
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filters = readHistoryPageFilters((name) => params[name]);
  const filterQuery = serializeHistoryFilters(filters).toString();
  const historyHref = filterQuery ? `/riwayat?${filterQuery}` : "/riwayat";
  if (!(await getCurrentUser())) {
    redirect(filterQuery ? `/login?${new URLSearchParams({ next: historyHref })}` : "/login");
  }

  const data = await historyData(filters).catch(() => null);

  return (
    <main className="app-main">
      <div className={styles.page}>
        <h1 data-reveal>Riwayat Transaksi</h1>
        {data ? (
          <TransactionHistoryView
            key={`${data.history.workspace_id}:${filterQuery}`}
            initialHistory={data.history}
            initialFilters={filters}
            sharedRoom={data.sharedRoom}
          />
        ) : (
          <div className={styles.listCard} data-reveal data-lift>
            <p role="alert">Riwayat belum bisa dimuat.</p>
            <a href={historyHref} className={styles.neutralButton} data-lift>Coba Lagi</a>
          </div>
        )}
      </div>
    </main>
  );
}
