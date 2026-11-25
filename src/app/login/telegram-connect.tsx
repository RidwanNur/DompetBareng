"use client";

import { CircleCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { issueTelegramLink } from "./telegram-actions";
import styles from "./login.module.css";

export function TelegramConnect({ status }: { status: boolean | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof issueTelegramLink>> | null>(null);
  const url = result && "url" in result ? result.url : null;

  useEffect(() => {
    if (status === true || !url) return;

    function refreshWhenVisible() {
      if (document.visibilityState === "visible") router.refresh();
    }

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 5000);
    const stopPolling = window.setTimeout(() => window.clearInterval(interval), 120_000);

    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      window.clearInterval(interval);
      window.clearTimeout(stopPolling);
    };
  }, [router, status, url]);

  function requestLink() {
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await issueTelegramLink());
        router.refresh();
      } catch {
        setResult({ error: "Tautan Telegram belum bisa dibuat. Coba lagi." });
      }
    });
  }

  if (status === true) {
    return (
      <p className={styles.connected} role="status">
        <CircleCheck aria-hidden="true" size={19} />
        Telegram Terhubung
      </p>
    );
  }

  return (
    <div className={styles.telegramActions}>
      {status === null && <p role="status">Status Telegram belum bisa diperiksa.</p>}
      {url ? (
        <>
          <p>Tekan Mulai di bot Telegram, lalu kembali ke halaman ini.</p>
          <a className={styles.primaryButton} href={url} target="_blank" rel="noopener noreferrer" data-lift>
            Buka Telegram
          </a>
        </>
      ) : <p>Gunakan tautan sekali pakai untuk menghubungkan akun.</p>}
      <button
        id="telegram-connect-btn"
        className={url ? styles.secondaryButton : styles.primaryButton}
        disabled={pending}
        onClick={requestLink}
        type="button"
      >
        Hubungkan Telegram
      </button>
      {result && "error" in result && <p className={styles.error} role="alert">{result.error}</p>}
    </div>
  );
}
