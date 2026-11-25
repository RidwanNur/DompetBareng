"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type HistoryTransaction,
  type TransactionHistory,
} from "@/types/database";
import styles from "./history.module.css";

const maximumAmount = 9223372036854775807n;

function wibDateTime(value: string) {
  const instant = Date.parse(value);
  return new Date(instant + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

type EditorProps = {
  transaction: HistoryTransaction;
  workspaceId: string;
  wallets: TransactionHistory["wallets"];
  onDismiss: () => void;
  onCommitted: (action: "edit" | "delete") => void;
};

export function TransactionEditor({ transaction, workspaceId, wallets, onDismiss, onCommitted }: EditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const originalDate = wibDateTime(transaction.occurred_at);
  const [draft, setDraft] = useState({
    item: transaction.item,
    amount: String(transaction.amount),
    type: transaction.type,
    category: transaction.category,
    walletId: transaction.wallet_id,
    date: originalDate,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function commit(method: "PATCH" | "DELETE", body: object) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/transactions/" + encodeURIComponent(transaction.id), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        setError(typeof payload?.error === "string" ? payload.error : "Perubahan belum bisa disimpan. Coba lagi.");
        return;
      }

      dialog.current?.close();
      onCommitted(method === "PATCH" ? "edit" : "delete");
    } catch {
      setError("Perubahan belum bisa disimpan. Coba lagi.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountText = draft.amount.trim();
    if (!/^[0-9]{1,19}$/.test(amountText) || BigInt(amountText) < 1n || BigInt(amountText) > maximumAmount) {
      setError("Masukkan nominal Rupiah berupa bilangan bulat positif.");
      return;
    }
    if (!draft.item.trim() || !draft.walletId || !draft.date) {
      setError("Lengkapi nama transaksi, dompet, dan tanggal.");
      return;
    }

    void commit("PATCH", {
      workspace_id: workspaceId,
      item: draft.item.trim(),
      amount: BigInt(amountText).toString(),
      type: draft.type,
      category: draft.category,
      wallet_id: draft.walletId,
      occurred_at: draft.date === originalDate ? transaction.occurred_at : draft.date + ":00+07:00",
    });
  }

  function selectType(type: "income" | "expense") {
    const choices = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    setDraft((current) => ({
      ...current,
      type,
      category: choices.some((category) => category === current.category) ? current.category : "Lainnya",
    }));
  }

  const categories = draft.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  return (
    <dialog
      id="transaction-edit-modal"
      ref={dialog}
      className={styles.dialog}
      data-reveal
      aria-labelledby="transaction-edit-title"
      aria-busy={pending}
      onCancel={(event) => { if (inFlight.current) event.preventDefault(); }}
      onClose={onDismiss}
    >
      <div className={styles.dialogHeading}>
        <h2 id="transaction-edit-title">{confirmDelete ? "Hapus transaksi?" : "Edit transaksi"}</h2>
        <button className={styles.neutralButton} type="button" aria-label="Tutup" onClick={() => dialog.current?.close()} disabled={pending}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {confirmDelete ? (
        <>
          <p className={styles.deleteItem}>{transaction.item}</p>
          <div className={styles.dialogActions}>
            <button className={styles.neutralButton} type="button" disabled={pending} onClick={() => { setConfirmDelete(false); setError(""); }}>Batal</button>
            <button className={styles.deleteButton} type="button" disabled={pending} onClick={() => void commit("DELETE", { workspace_id: workspaceId })}>
              Hapus Transaksi
            </button>
          </div>
        </>
      ) : (
        <form className={styles.editForm} onSubmit={submit} noValidate>
          <fieldset className={styles.editFields} disabled={pending}>
            <label className={styles.field}>
              Nama transaksi
              <input name="item" value={draft.item} maxLength={120} onChange={(event) => setDraft({ ...draft, item: event.target.value })} />
            </label>
            <label className={styles.field}>
              Nominal (Rp)
              <input name="amount" inputMode="numeric" value={draft.amount} maxLength={19} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} />
            </label>
            <div className={styles.editGrid}>
              <label className={styles.field}>
                Jenis
                <select name="type" value={draft.type} onChange={(event) => selectType(event.target.value === "income" ? "income" : "expense")}>
                  <option value="income">Pemasukan</option>
                  <option value="expense">Pengeluaran</option>
                </select>
              </label>
              <label className={styles.field}>
                Kategori
                <select name="category" value={draft.category} onChange={(event) => {
                  const category = categories.find((choice) => choice === event.target.value);
                  if (category) setDraft({ ...draft, category });
                }}>
                  {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                Dompet
                <select name="wallet_id" value={draft.walletId} onChange={(event) => setDraft({ ...draft, walletId: event.target.value })}>
                  {wallets.map((wallet) => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                Tanggal dan waktu WIB
                <input name="occurred_at" type="datetime-local" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
              </label>
            </div>
          </fieldset>
          <div className={styles.dialogActions}>
            <button className={styles.primaryButton} type="submit" disabled={pending}>Simpan Perubahan</button>
            <button className={styles.deleteOutline} type="button" disabled={pending} onClick={() => { setConfirmDelete(true); setError(""); }}>Hapus Transaksi</button>
          </div>
        </form>
      )}
      {pending && <p className={styles.muted} role="status">Memproses transaksi…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </dialog>
  );
}
