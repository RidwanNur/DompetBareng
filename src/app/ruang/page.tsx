import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { invitationPath, isInvitationCode, loginPath } from "@/lib/navigation";
import { getWorkspaceState } from "@/lib/workspaces";
import styles from "./ruang.module.css";
import { WorkspaceSettings } from "./workspace-settings";

export const dynamic = "force-dynamic";

type WorkspacesPageProps = {
  searchParams: Promise<{ invite?: string | string[] }>;
};

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps) {
  const [user, { invite }] = await Promise.all([getCurrentUser(), searchParams]);
  const code = isInvitationCode(invite) ? invite : undefined;
  if (!user) redirect(loginPath(code ? invitationPath(code) : undefined));

  const state = await getWorkspaceState().catch(() => null);

  return (
    <main className="app-main">
      <div className={styles.page}>
        <h1 data-reveal>Pengaturan Ruang</h1>
        {state ? (
          <WorkspaceSettings key={code} initialState={state} inviteCode={code} />
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
