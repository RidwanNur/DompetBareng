import { redirect } from "next/navigation";
import { DashboardOverview } from "@/components/dashboard/overview";
import { RecentTransactions } from "@/components/dashboard/recent-transactions";
import { DashboardWorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";
import styles from "@/components/dashboard/dashboard.module.css";
import { getCurrentUser } from "@/lib/auth";
import { getDashboardSummary } from "@/lib/dashboard";
import { getWorkspaceState } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

async function getDashboardData() {
  const spaces = await getWorkspaceState();
  const summary = await getDashboardSummary(spaces.active_workspace_id);
  const workspaceName = spaces.household?.id === summary.workspace_id ? spaces.household.name : spaces.personal.name;
  return { spaces, summary, workspaceName };
}

export default async function HomePage({ searchParams }: { searchParams: Promise<{ shared?: string | string[] }> }) {
  if (!(await getCurrentUser())) redirect("/login");

  const [dashboard, { shared }] = await Promise.all([getDashboardData().catch(() => null), searchParams]);
  const shareResult = shared === "success" || shared === "invalid" || shared === "failed" || shared === "limited" ? shared : undefined;

  return (
    <main className="app-main">
      <div className={styles.page}>
        <div className={styles.heading} data-reveal>
          <h1>Beranda</h1>
          {dashboard && (
            <DashboardWorkspaceSwitcher
              activeWorkspaceId={dashboard.spaces.active_workspace_id}
              personalId={dashboard.spaces.personal.id}
              householdId={dashboard.spaces.household?.id ?? null}
            />
          )}
        </div>
        {dashboard ? (
          <>
            <DashboardOverview summary={dashboard.summary} workspaceName={dashboard.workspaceName} shared={shareResult} />
            <RecentTransactions key={dashboard.summary.workspace_id} workspaceId={dashboard.summary.workspace_id} transactions={dashboard.summary.transactions} />
          </>
        ) : (
          <div className={styles.unavailable} data-reveal data-lift>
            <p role="alert">Beranda belum bisa dimuat.</p>
            <a className={styles.retry} href="/" data-lift>Coba Lagi</a>
          </div>
        )}
      </div>
    </main>
  );
}
