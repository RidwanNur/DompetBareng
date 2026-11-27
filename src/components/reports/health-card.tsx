"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { expenseRatioLabel, withFinancialHealthFallback } from "@/lib/financial-health";
import { formatMonth, formatRupiah } from "@/lib/format";
import type { MonthlyReport } from "@/types/database";
import styles from "./report.module.css";

const updatedDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "Asia/Jakarta" });
const updatedTime = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta",
});

function updatedLabel(timestamp: string) {
  const date = new Date(timestamp);
  return `${updatedDate.format(date)}, ${updatedTime.format(date)}`;
}

export function MonthlyHealthCard({ report }: { report: MonthlyReport }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const autoAttempted = useRef<string | null>(null);
  const [working, setWorking] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<MonthlyReport | null>(null);
  const [refreshing, refresh] = useTransition();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { workspace_id, month } = report;
  const hasData = report.transaction_count > 0 && report.health_status !== "Belum Ada Data";
  const readyReport = report.analysis && !report.analysis_stale;
  const resultIsNewer = latestResult?.analysis_updated_at && (!report.analysis_updated_at ||
    Date.parse(latestResult.analysis_updated_at) > Date.parse(report.analysis_updated_at));
  const displayed = latestResult && latestResult.analysis_fingerprint === report.analysis_fingerprint && (!readyReport || resultIsNewer)
    ? latestResult : report;
  const analysis = hasData && !displayed.analysis_stale ? displayed.analysis : null;
  const snapshot = JSON.stringify([report.analysis_fingerprint, report.analysis_updated_at, report.analysis]);
  const autoKey = report.analysis_fingerprint ?? `${month}:${report.transaction_count}:${report.total_income}:${report.total_expense}`;
  const validAi = readyReport && report.analysis_source === "ai";
  const retryAt = report.analysis_retry_at;

  const generate = useCallback(async (manual: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    function showFallback() {
      setLatestResult((current) => current?.analysis_fingerprint === report.analysis_fingerprint &&
        current.analysis && !current.analysis_stale ? current : withFinancialHealthFallback(report));
    }
    try {
      const response = await fetch("/api/reports/monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id, month, manual }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.report?.workspace_id !== workspace_id || result.report.month !== month) {
        showFallback();
        return;
      }
      setLatestResult(result.report);
      if (result.limited) setNotice("Batas pembaruan AI hari ini sudah tercapai. Ringkasan tetap tersedia.");
      if (result.busy) setWaiting(snapshot);
      else refresh(() => router.refresh());
    } catch {
      showFallback();
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }, [month, report, router, snapshot, workspace_id]);

  useEffect(() => {
    if (working || !hasData || validAi || autoAttempted.current === autoKey || (retryAt && Date.parse(retryAt) > Date.now())) return;
    autoAttempted.current = autoKey;
    void generate(false);
  }, [autoKey, generate, hasData, retryAt, validAi, working]);

  useEffect(() => {
    if (waiting === null) return;
    if (snapshot !== waiting) {
      setWaiting(null);
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 2500);
    const stop = window.setTimeout(() => setWaiting(null), 55_000);
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
      "Rasio pengeluaran " + expenseRatioLabel(report),
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
        <div><dt>Rasio pengeluaran</dt><dd data-health-ratio>{expenseRatioLabel(report)}</dd></div>
        <div>
          <dt>Pos pengeluaran terbesar</dt>
          <dd>{report.largest_expense ? report.largest_expense.category + " · " + formatRupiah(report.largest_expense.total) : "-"}</dd>
        </div>
      </dl>
      {analysis && (
        <div className={styles.analysis}>
          <p>{analysis.narrative}</p>
          <ul>{analysis.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul>
          {(displayed.analysis_source === "fallback" || displayed.analysis_updated_at) && (
            <p className={styles.analysisMeta}>
              {displayed.analysis_source === "fallback" && "Ringkasan cadangan"}
              {displayed.analysis_source === "fallback" && displayed.analysis_updated_at && " · "}
              {displayed.analysis_updated_at && (
                <time dateTime={displayed.analysis_updated_at}>Diperbarui {updatedLabel(displayed.analysis_updated_at)}</time>
              )}
            </p>
          )}
        </div>
      )}
      {hasData && report.analysis_stale && !analysis && <p className={styles.muted}>Transaksi sudah berubah. Ringkasan akan diperbarui.</p>}
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
