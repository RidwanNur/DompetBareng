import { redirect } from "next/navigation";
import { MonthlyHealthCard } from "@/components/reports/health-card";
import { CategoryChart, LargestExpenses, MonthlySummary, WalletBalances } from "@/components/reports/monthly-summary";
import { ReportControls } from "@/components/reports/report-controls";
import styles from "@/components/reports/report.module.css";
import { getCurrentUser } from "@/lib/auth";
import { getCurrentJakartaMonth, getMonthlyReportPageData } from "@/lib/monthly-report";
import { getWorkspaceState } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

async function readReport(month: string) {
  const spaces = await getWorkspaceState();
  const data = await getMonthlyReportPageData(spaces.active_workspace_id, month);
  const { household } = spaces;
  const sharedRoom = household !== null && household.id === data.report.workspace_id;
  const workspaceName = sharedRoom ? household.name : spaces.personal.name;
  return { ...data, workspaceName, sharedRoom };
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  if (!(await getCurrentUser())) redirect("/login");

  const { month: requestedMonth } = await searchParams;
  const month = typeof requestedMonth === "string" && /^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
    ? requestedMonth
    : getCurrentJakartaMonth();
  const data = await readReport(month).catch(() => null);

  return (
    <main className={`app-main ${styles.reportMain}`}>
      <div className={styles.page}>
        <header className={styles.heading} data-reveal>
          <div>
            <h1>Laporan Bulanan</h1>
            {data && <p className={styles.muted}>{data.workspaceName}</p>}
          </div>
          <ReportControls month={month} workspaceId={data?.report.workspace_id} />
        </header>
        {data ? (
          <>
            <MonthlySummary report={data.report} details={data.details} />
            <div className={styles.details}>
              <div className={styles.detailColumn}>
                <CategoryChart details={data.details} />
                <LargestExpenses expenses={data.details.largest_expenses} sharedRoom={data.sharedRoom} />
              </div>
              <div className={styles.detailColumn}>
                <MonthlyHealthCard key={data.report.workspace_id + "/" + month} report={data.report} />
                <WalletBalances report={data.report} />
              </div>
            </div>
          </>
        ) : (
          <div className={styles.unavailable} data-reveal data-lift>
            <p role="alert">Laporan belum bisa dimuat.</p>
            <a className={styles.secondaryButton} href={"/laporan?month=" + month} data-lift>Coba Lagi</a>
          </div>
        )}
      </div>
    </main>
  );
}
