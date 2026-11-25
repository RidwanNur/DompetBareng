import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getWorkspaceState } from "@/lib/workspaces";
import styles from "./ruang.module.css";
import { WorkspaceSettings } from "./workspace-settings";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const state = await getWorkspaceState().catch(() => null);

  return (
    <main className="app-main">
      <div className={styles.page}>
        <h1 data-reveal>Pengaturan Ruang</h1>
        {state ? (
          <WorkspaceSettings initialState={state} />
        ) : (
          <div className={styles.panel} data-reveal data-lift>
            <p role="alert">Pengaturan ruang belum bisa dimuat.</p>
            <a className={styles.secondaryButton} href="/ruang" data-lift>Coba Lagi</a>
          </div>
        )}
      </div>
    </main>
  );
}
