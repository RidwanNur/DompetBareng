"use client";

import { ArrowDownLeft, ArrowUpRight, Search } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { DashboardAmount } from "@/components/dashboard/amount";
import { formatDate } from "@/lib/format";
import { historyCategories, historyFilterNames, isHistoryType, readHistoryPageFilters, serializeHistoryFilters } from "@/lib/history-filters";
import { signalTransactionRefresh, subscribeToWorkspaceRefresh } from "@/lib/transaction-refresh";
import type { HistoryTransaction, TransactionHistory, TransactionHistoryFilters } from "@/types/database";
import { TransactionEditor } from "./transaction-editor";
import styles from "./history.module.css";

const historyUnavailable = "Riwayat belum bisa dimuat. Coba lagi.";

async function fetchHistory(workspaceId: string, filters: TransactionHistoryFilters, signal: AbortSignal) {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  const response = await fetch("/api/transactions?" + params, { signal, cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.history?.workspace_id !== workspaceId) throw new Error(historyUnavailable);
  return body.history as TransactionHistory;
}

export function TransactionHistoryView({ initialHistory, initialFilters, sharedRoom }: {
  initialHistory: TransactionHistory;
  initialFilters: TransactionHistoryFilters;
  sharedRoom: boolean;
}) {
  const workspaceId = initialHistory.workspace_id;
  const [history, setHistory] = useState(initialHistory);
  const [query, setQuery] = useState<TransactionHistoryFilters | null>(null);
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<HistoryTransaction | null>(null);
  const filterRequest = useRef<AbortController | null>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const filters = query ?? initialFilters;
  const categories = historyCategories(filters.type);

  useEffect(() => {
    if (!query) return;

    const request = new AbortController();
    filterRequest.current = request;
    setLoading(true);
    setError("");

    const delay = window.setTimeout(async () => {
      try {
        const result = await fetchHistory(workspaceId, query, request.signal);
        if (!request.signal.aborted) setHistory(result);
      } catch {
        if (!request.signal.aborted) setError(historyUnavailable);
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(delay);
      request.abort();
      if (filterRequest.current === request) filterRequest.current = null;
    };
  }, [query, workspaceId]);

  useEffect(() => () => pageRequest.current?.abort(), []);

  const restoreUrlFilters = useEffectEvent(() => {
    const { pathname, search } = window.location;
    if (pathname !== "/riwayat" && pathname !== "/riwayat/") return;
    const params = new URLSearchParams(search);
    const requestedFilters = readHistoryPageFilters((name) => {
      const values = params.getAll(name);
      return values.length === 1 ? values[0] : undefined;
    });
    if (serializeHistoryFilters(requestedFilters).toString() !== serializeHistoryFilters(filters).toString()) {
      requestHistory(requestedFilters);
    }
  });

  useEffect(() => {
    const restore = () => restoreUrlFilters();
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const refreshVisibleHistory = useEffectEvent(() => {
    if (document.visibilityState === "visible") requestHistory({ ...filters });
  });

  useEffect(() => {
    const refresh = () => refreshVisibleHistory();
    const unsubscribe = subscribeToWorkspaceRefresh(workspaceId, refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspaceId]);

  function requestHistory(nextFilters: TransactionHistoryFilters) {
    filterRequest.current?.abort();
    pageRequest.current?.abort();
    pageRequest.current = null;
    setPaging(false);
    setLoading(true);
    setQuery(nextFilters);
  }

  function replaceFilters(nextFilters: TransactionHistoryFilters) {
    const params = serializeHistoryFilters(nextFilters);
    const current = new URL(window.location.href);
    const url = new URL(current);
    for (const name of historyFilterNames) url.searchParams.delete(name);
    for (const [name, value] of params) url.searchParams.set(name, value);
    if (url.href !== current.href) window.history.replaceState(null, "", url);
    if (params.toString() !== serializeHistoryFilters(filters).toString()) requestHistory(nextFilters);
  }

  function applyFilters(changes: TransactionHistoryFilters) {
    replaceFilters({ ...filters, ...changes });
  }

  async function loadMore() {
    const cursor = history.next_cursor;
    if (!cursor || loading || pageRequest.current) return;

    const request = new AbortController();
    pageRequest.current = request;
    setPaging(true);
    setError("");
    try {
      const result = await fetchHistory(workspaceId, {
        ...filters,
        before_at: cursor.occurred_at,
        before_id: cursor.id,
      }, request.signal);

      if (!request.signal.aborted) {
        setHistory((current) => {
          const seen = new Set(current.transactions.map((transaction) => transaction.id));
          return { ...result, transactions: [...current.transactions, ...result.transactions.filter((transaction) => !seen.has(transaction.id))] };
        });
      }
    } catch {
      if (!request.signal.aborted) setError(historyUnavailable);
    } finally {
      if (pageRequest.current === request) {
        pageRequest.current = null;
        setPaging(false);
      }
    }
  }

  function committed(message: string) {
    setEditing(null);
    setNotice(message);
    requestHistory({ ...filters });
    signalTransactionRefresh();
  }

  return (
    <>
      <section className={styles.filters} aria-label="Filter transaksi" data-reveal data-lift>
        <label className={styles.search}>
          <span className="sr-only">Cari transaksi</span>
          <Search size={19} aria-hidden="true" />
          <input name="search" type="search" value={filters.search ?? ""} maxLength={120} placeholder="Cari transaksi..." onChange={(event) => applyFilters({ search: event.target.value })} />
        </label>
        <div className={styles.filterGrid}>
          <label className={styles.field}>
            Bulan
            <input name="month" type="month" value={filters.month ?? ""} onChange={(event) => applyFilters({ month: event.target.value })} />
          </label>
          <label className={styles.field}>
            Tipe
            <select name="type" value={filters.type ?? ""} onChange={(event) => {
              const choice = event.target.value;
              const type = isHistoryType(choice) ? choice : undefined;
              const category = historyCategories(type).find((name) => name === filters.category);
              applyFilters({ type, category });
            }}>
              <option value="">Semua tipe</option>
              <option value="income">Pemasukan</option>
              <option value="expense">Pengeluaran</option>
            </select>
          </label>
          <label className={styles.field}>
            Dompet
            <select name="wallet_id" value={filters.wallet_id ?? ""} onChange={(event) => applyFilters({ wallet_id: event.target.value })}>
              <option value="">Semua dompet</option>
              {history.wallets.map((wallet) => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            Kategori
            <select name="category" value={filters.category ?? ""} onChange={(event) => applyFilters({ category: categories.find((category) => category === event.target.value) })}>
              <option value="">Semua kategori</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            Pencatat
            <select name="recorder" value={filters.recorder ?? ""} onChange={(event) => {
              const choice = event.target.value;
              applyFilters({ recorder: choice === "self" || choice === "partner" ? choice : undefined });
            }}>
              <option value="">Semua pencatat</option>
              <option value="self">Anda</option>
              {sharedRoom && <option value="partner">Pasangan</option>}
            </select>
          </label>
        </div>
        <div className={styles.filterActions}>
          {filters.month && <button className={styles.filterAction} type="button" onClick={() => applyFilters({ month: "" })}>Semua bulan</button>}
          <button className={styles.filterAction} type="button" onClick={() => replaceFilters({})}>Reset Filter</button>
        </div>
      </section>
      <section className={styles.listCard} aria-label="Daftar transaksi" data-reveal data-lift>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {loading && <p className={styles.muted} role="status">Memuat riwayat…</p>}
        <ul id="transaction-list" className={styles.list} aria-busy={loading || paging}>
          {history.transactions.length ? history.transactions.map((transaction) => {
            const incoming = transaction.type === "income";
            const DirectionIcon = incoming ? ArrowDownLeft : ArrowUpRight;
            const amount = BigInt(transaction.amount);
            return (
              <li key={transaction.id} className={styles.row} data-transaction-id={transaction.id}>
                <span className={incoming ? styles.incomeIcon : styles.expenseIcon} aria-hidden="true"><DirectionIcon size={20} strokeWidth={1.7} /></span>
                <div className={styles.rowCopy}>
                  <p className={styles.item}>{transaction.item}</p>
                  <p className={styles.meta}>{transaction.wallet_name} · {transaction.category}</p>
                  <p className={styles.meta}>
                    <time dateTime={transaction.occurred_at}>{formatDate(transaction.occurred_at)}</time>
                    {" · "}<span className={styles.recorder}>{transaction.recorded_by === "self" ? "Anda" : "Pasangan"}</span>
                  </p>
                </div>
                <div className={styles.rowActions}>
                  <DashboardAmount className={styles.amount} value={incoming ? amount : -amount} showPlus={incoming} />
                  {transaction.recorded_by === "self" && (
                    <button className={styles.neutralButton} type="button" disabled={loading} onClick={() => setEditing(transaction)}>Edit</button>
                  )}
                </div>
              </li>
            );
          }) : !loading && <li className={styles.empty}>Tidak ada transaksi yang ditemukan.</li>}
        </ul>
        {history.next_cursor && <button className={styles.neutralButton} type="button" disabled={loading || paging} onClick={() => void loadMore()}>Muat Lagi</button>}
      </section>
      {editing && (
        <TransactionEditor
          key={editing.id}
          transaction={editing}
          workspaceId={workspaceId}
          onDismiss={() => setEditing(null)}
          onCommitted={committed}
        />
      )}
    </>
  );
}
