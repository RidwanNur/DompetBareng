"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type Transaction,
  type WalletOverview,
  type WalletType,
} from "@/types/database";
import styles from "./quick-input.module.css";

export type ManualTransactionInput = {
  item: string;
  amount: string;
  type: Transaction["type"];
  category: string;
  wallet_id: string;
  wallet_type: WalletType;
};

type Wallets = { list: WalletOverview["wallets"] } | { error: string };

const unavailable = "Pilihan dompet belum bisa dimuat. Coba lagi.";

export function ManualInput({ workspaceId, pending, onSave }: {
  workspaceId: string;
  pending: boolean;
  onSave: (input: ManualTransactionInput) => void;
}) {
  const [type, setType] = useState<Transaction["type"]>("expense");
  const [wallets, setWallets] = useState<Wallets | null>(null);
  const [reload, setReload] = useState(0);
  const categories = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const list = wallets && "list" in wallets ? wallets.list : [];

  useEffect(() => {
    const request = new AbortController();
    const query = new URLSearchParams({ workspace_id: workspaceId });

    async function loadWallets() {
      try {
        const response = await fetch(`/api/wallets?${query}`, { cache: "no-store", signal: request.signal });
        const result = await response.json();
        if (!response.ok || result?.overview?.workspace_id !== workspaceId) throw new Error(unavailable);
        const overview = result.overview as WalletOverview;
        if (!request.signal.aborted) setWallets({ list: overview.wallets.filter((wallet) => !wallet.archived) });
      } catch {
        if (!request.signal.aborted) setWallets({ error: unavailable });
      }
    }

    void loadWallets();
    return () => request.abort();
  }, [workspaceId, reload]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const wallet = list.find(({ id }) => id === fields.get("wallet_id"));
    if (!wallet) return;
    onSave({
      item: String(fields.get("item") ?? "").trim(),
      amount: String(fields.get("amount") ?? ""),
      type,
      category: String(fields.get("category") ?? ""),
      wallet_id: wallet.id,
      wallet_type: wallet.type,
    });
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-busy={pending}>
      <label className={styles.field}>
        Nama transaksi
        <input name="item" required maxLength={120} disabled={pending} />
      </label>
      <div className={styles.manualFields}>
        <label className={styles.field}>
          Tipe
          <select name="type" value={type} onChange={(event) => setType(event.target.value === "income" ? "income" : "expense")} disabled={pending}>
            <option value="expense">Pengeluaran</option>
            <option value="income">Pemasukan</option>
          </select>
        </label>
        <label className={styles.field}>
          Nominal (Rp)
          <input name="amount" inputMode="numeric" pattern="[1-9][0-9]*" maxLength={19} required disabled={pending} />
        </label>
        <label className={styles.field}>
          Kategori
          <select name="category" key={type} defaultValue="" required disabled={pending}>
            <option value="" disabled>Pilih kategori</option>
            {categories.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Dompet
          <select name="wallet_id" defaultValue="" required disabled={pending || !list.length}>
            <option value="" disabled>Pilih dompet</option>
            {list.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>
      {!wallets && <p className={styles.progress} role="status">Memuat dompet…</p>}
      {wallets && "error" in wallets && (
        <div className={styles.failure}>
          <p className={styles.error} role="alert">{wallets.error}</p>
          <button type="button" className={styles.secondary} onClick={() => { setWallets(null); setReload((version) => version + 1); }}>Coba Lagi</button>
        </div>
      )}
      {wallets && "list" in wallets && !list.length && <p className={styles.error} role="status">Belum ada dompet aktif di ruang ini.</p>}
      <button className={styles.submit} type="submit" disabled={pending || !list.length}>Simpan Transaksi</button>
    </form>
  );
}
