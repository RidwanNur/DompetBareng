"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { subscribeToWorkspaceRefresh, transactionRefreshChannel } from "@/lib/transaction-refresh";
import styles from "./report.module.css";

export function ReportControls({ month, workspaceId }: { month: string; workspaceId?: string }) {
  const router = useRouter();
  const [pending, navigate] = useTransition();

  useEffect(() => {
    function refreshReport() {
      if (document.visibilityState === "visible") router.refresh();
    }

    const unsubscribe = subscribeToWorkspaceRefresh(workspaceId, refreshReport);
    window.addEventListener("focus", refreshReport);
    document.addEventListener("visibilitychange", refreshReport);
    let channel: BroadcastChannel | undefined;
    try {
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel(transactionRefreshChannel);
        channel.addEventListener("message", refreshReport);
      }
    } catch {
      // Laporan tetap menyegarkan data saat jendela kembali aktif.
    }
    return () => {
      window.removeEventListener("focus", refreshReport);
      document.removeEventListener("visibilitychange", refreshReport);
      unsubscribe();
      channel?.close();
    };
  }, [router, workspaceId]);

  return (
    <label className={styles.period}>
      Bulan
      <input key={month} name="month" type="month" defaultValue={month} aria-busy={pending} onChange={(event) => {
        const selected = event.target.value;
        if (/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(selected)) {
          navigate(() => router.replace("/laporan?month=" + selected, { scroll: false }));
        }
      }} />
    </label>
  );
}
