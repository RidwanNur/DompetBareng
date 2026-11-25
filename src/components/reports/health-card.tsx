"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { formatMonth, formatRupiah } from "@/lib/format";
import type { MonthlyReport } from "@/types/database";
import styles from "./report.module.css";

const wholeFormatter = new Intl.NumberFormat("id-ID");

function ratioLabel(report: MonthlyReport) {
  if (report.expense_ratio_percent === null) {
    return report.total_expense === "0" ? "-" : "Belum ada pemasukan";
  }
  const [whole, fraction] = report.expense_ratio_percent.split(".");
  const decimals = fraction?.replace(/0+$/, "");
  return wholeFormatter.format(BigInt(whole)) + (decimals ? "," + decimals : "") + "%";
}

export function MonthlyHealthCard({ report }: { report: MonthlyReport }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const autoAttempted = useRef(false);
  const [working, setWorking] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [refreshing, refresh] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { workspace_id, month } = report;
  const hasData = report.transaction_count > 0 && report.health_status !== "Belum Ada Data";
  const analysis = hasData && !report.analysis_stale ? report.analysis : null;
  const snapshot = JSON.stringify(report.analysis);

  const generate = useCallback(async (manual: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/reports/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id, month, manual }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.report?.workspace_id !== workspace_id || result.report.month !== month) {
        setError(typeof result?.error === "string" ? result.error : "Ringkasan AI belum bisa dibuat. Coba lagi.");
        return;
      }
      if (result.busy) setWaiting(JSON.stringify(result.report.analysis));
      else refresh(() => router.refresh());
    } catch {
      setError("Ringkasan AI belum bisa dibuat. Coba lagi.");
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }, [month, router, workspace_id]);

  useEffect(() => {
    if (!hasData || report.analysis || autoAttempted.current) return;
    autoAttempted.current = true;
    void generate(false);
  }, [generate, hasData, report.analysis]);

  useEffect(() => {
    if (waiting === null) return;
    if (snapshot !== waiting) {
      setWaiting(null);
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 2500);
    const stop = window.setTimeout(() => setWaiting(null), 30_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [router, snapshot, waiting]);

  async function shareReport() {
    setError("");
    setNotice("");
    const title = "Laporan Bulanan · " + formatMonth(month);
    const lines = [
      title,
      "Total Pemasukan " + formatRupiah(report.total_income),
      "Total Pengeluaran " + formatRupiah(report.total_expense),
      "Arus Kas Bersih " + formatRupiah(report.net_cash_flow),
      "Rasio pengeluaran " + ratioLabel(report),
      "Status " + report.health_status,
    ];
    if (report.largest_expense) lines.push("Pos pengeluaran terbesar " + report.largest_expense.category + " · " + formatRupiah(report.largest_expense.total));
    if (analysis) lines.push("", analysis.narrative, ...analysis.suggestions.map((suggestion) => "• " + suggestion));
    const text = lines.join("\n");

    try {
      if (typeof navigator.share === "function") await navigator.share({ title, text });
      else {
        await navigator.clipboard.writeText(text);
        setNotice("Ringkasan disalin.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setError("Ringkasan belum bisa dibagikan. Coba lagi.");
    }
  }

  const busy = working || refreshing || waiting !== null;
  const tone = report.health_status === "Sehat" ? "positive"
    : report.health_status === "Waspada" ? "warning"
      : report.health_status === "Defisit" ? "negative" : "neutral";

  return (
    <section id="ai-health-card" className={styles.health} aria-labelledby="ai-health-title" aria-busy={busy} data-reveal data-lift>
      <div className={styles.healthHeading}>
        <span className={styles.healthIcon} aria-hidden="true"><Sparkles size={21} strokeWidth={1.65} /></span>
        <h2 id="ai-health-title">Kesehatan Keuangan AI</h2>
      </div>
      <span className={styles.status} data-health-status data-tone={tone}>{report.health_status}</span>
      <dl className={styles.healthFacts}>
        <div><dt>Rasio pengeluaran</dt><dd data-health-ratio>{ratioLabel(report)}</dd></div>
        <div>
          <dt>Pos pengeluaran terbesar</dt>
          <dd>{report.largest_expense ? report.largest_expense.category + " · " + formatRupiah(report.largest_expense.total) : "-"}</dd>
        </div>
      </dl>
      {analysis && (
        <div className={styles.analysis}>
          <p>{analysis.narrative}</p>
          <ul>{analysis.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul>
        </div>
      )}
      {hasData && report.analysis_stale && <p className={styles.muted}>Transaksi sudah berubah. Buat ringkasan AI untuk memperbaruinya.</p>}
      {busy && <p className={styles.muted} role="status">Membuat ringkasan AI…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.actions}>
        <button className={styles.primaryButton} type="button" disabled={!hasData || busy} onClick={() => void generate(true)}>Buat Ringkasan AI</button>
        <button className={styles.secondaryButton} type="button" disabled={!hasData} onClick={() => void shareReport()}>Bagikan Ringkasan</button>
      </div>
    </section>
  );
}
