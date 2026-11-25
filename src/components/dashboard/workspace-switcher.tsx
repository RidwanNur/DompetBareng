"use client";

import { House, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useEffectEvent, useRef, useTransition } from "react";
import { selectDashboardWorkspace } from "@/app/dashboard-actions";
import { subscribeToWorkspaceRefresh, transactionRefreshChannel } from "@/lib/transaction-refresh";
import styles from "./dashboard.module.css";

type WorkspaceOptions = {
  activeWorkspaceId: string;
  personalId: string;
  householdId: string | null;
};

export function DashboardWorkspaceSwitcher({ activeWorkspaceId, personalId, householdId }: WorkspaceOptions) {
  const [state, selectWorkspace, selecting] = useActionState(selectDashboardWorkspace, {});
  const [refreshing, startRefreshing] = useTransition();
  const deferredRefresh = useRef(false);
  const router = useRouter();

  const refreshVisibleDashboard = useEffectEvent(() => {
    if (document.visibilityState !== "visible") return;
    if (selecting || refreshing) {
      deferredRefresh.current = true;
      return;
    }
    startRefreshing(() => router.refresh());
  });

  useEffect(() => {
    if (selecting || refreshing || !deferredRefresh.current) return;
    deferredRefresh.current = false;
    refreshVisibleDashboard();
  }, [refreshing, selecting]);

  useEffect(() => {
    const refresh = () => refreshVisibleDashboard();
    const unsubscribe = subscribeToWorkspaceRefresh(activeWorkspaceId, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 10_000);
    let channel: BroadcastChannel | undefined;
    try {
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel(transactionRefreshChannel);
        channel.addEventListener("message", refresh);
      }
    } catch {
      // Penyegaran berkala tetap aktif.
    }

    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
      channel?.close();
    };
  }, [activeWorkspaceId]);

  return (
    <div className={styles.workspaceControl}>
      <form id="workspace-switcher" className={styles.workspaceOptions} action={selectWorkspace} aria-label="Pilih ruang" aria-busy={selecting}>
        <button type="submit" name="workspaceId" value={personalId} aria-pressed={personalId === activeWorkspaceId} disabled={selecting}>
          <LockKeyhole aria-hidden="true" size={17} /> Pribadi
        </button>
        {householdId ? (
          <button type="submit" name="workspaceId" value={householdId} aria-pressed={householdId === activeWorkspaceId} disabled={selecting}>
            <House aria-hidden="true" size={17} /> Rumah Tangga
          </button>
        ) : (
          <Link href="/ruang" data-lift><House aria-hidden="true" size={17} /> Rumah Tangga</Link>
        )}
      </form>
      {state.error && <p className={styles.selectionError} role="alert">{state.error}</p>}
    </div>
  );
}
