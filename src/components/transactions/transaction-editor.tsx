"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type DashboardTransaction,
  type TransactionEditorContext,
} from "@/types/database";
import styles from "./history.module.css";

const maximumAmount = 9223372036854775807n;
const workspaceLabels = { personal: "Pribadi", household: "Rumah Tangga" };
const unavailable = "Pilihan dompet belum bisa dimuat. Coba lagi.";

function wibDateTime(value: string) {
  const instant = Date.parse(value);
  return new Date(instant + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

type EditorProps = {
  transaction: DashboardTransaction;
  workspaceId: string;
  onDismiss: () => void;
  onCommitted: (message: string) => void;
};

export function TransactionEditor({ transaction, workspaceId, onDismiss, onCommitted }: EditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const moveAttempt = useRef<{ body: string; id: string } | null>(null);
  const originalDate = wibDateTime(transaction.occurred_at);
  const [draft, setDraft] = useState({
    item: transaction.item,
    amount: String(transaction.amount),
    type: transaction.type,
    category: transaction.category,
    workspaceId,
    walletId: "",
    date: originalDate,
  });
  const [context, setContext] = useState<TransactionEditorContext | null>(null);
  const [contextError, setContextError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  useEffect(() => {
    const request = new AbortController();
    async function loadEditor() {
      setContextError("");
      try {
        const query = new URLSearchParams({ workspace_id: workspaceId });
        const response = await fetch(`/api/transactions/${encodeURIComponent(transaction.id)}?${query}`, {
          cache: "no-store", signal: request.signal,
        });
        const result = await response.json().catch(() => null);
        if (request.signal.aborted) return;
        if (!response.ok || !result?.editor) {
          setContextError(typeof result?.error === "string" ? result.error : unavailable);
          return;
        }
        const editor = result.editor as TransactionEditorContext;
        setContext(editor);
        setDraft((current) => ({ ...current, workspaceId, walletId: editor.wallet_id }));
      } catch {
        if (!request.signal.aborted) setContextError(unavailable);
      }
    }
    void loadEditor();
    return () => request.abort();
  }, [loadVersion, transaction.id, workspaceId]);

  const wallets = context?.workspaces.find(({ id }) => id === draft.workspaceId)?.wallets ?? [];

  function selectWorkspace(id: string) {
    const selected = context?.workspaces.find((workspace) => workspace.id === id);
    if (!selected) return;
    const selectedType = wallets.find((wallet) => wallet.id === draft.walletId)?.type;
    const wallet = selected.wallets.find((entry) => entry.type === selectedType) ?? selected.wallets[0];
    setDraft({ ...draft, workspaceId: id, walletId: wallet?.id ?? "" });
    setError("");
  }

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
      const movedTo: unknown = payload.moved_to;
      if (movedTo === "personal" || movedTo === "household") {
        onCommitted(`Transaksi dipindahkan ke ${workspaceLabels[movedTo]}.`);
      } else {
        onCommitted(method === "PATCH" ? "Perubahan disimpan." : "Transaksi dihapus.");
      }
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
    if (!draft.item.trim() || !wallets.some(({ id }) => id === draft.walletId) || !draft.date) {
      setError("Lengkapi nama transaksi, dompet, dan tanggal.");
      return;
    }

    const changes = {
      workspace_id: workspaceId,
      item: draft.item.trim(),
      amount: BigInt(amountText).toString(),
      type: draft.type,
      category: draft.category,
      occurred_at: draft.date === originalDate ? transaction.occurred_at : draft.date + ":00+07:00",
    };
    if (draft.workspaceId === workspaceId) {
      void commit("PATCH", { ...changes, wallet_id: draft.walletId });
      return;
    }

    const move = { ...changes, target_workspace_id: draft.workspaceId, target_wallet_id: draft.walletId };
    const body = JSON.stringify(move);
    const operationId = moveAttempt.current?.body === body ? moveAttempt.current.id : crypto.randomUUID();
    moveAttempt.current = { body, id: operationId };
    void commit("PATCH", { ...move, operation_id: operationId });
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
      aria-busy={pending || (!context && !contextError)}
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
          <fieldset className={styles.editFields} disabled={pending || !context}>
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
              {context && context.workspaces.length > 1 && (
                <label className={styles.field}>
                  Ruang
                  <select name="target_workspace_id" value={draft.workspaceId} onChange={(event) => selectWorkspace(event.target.value)}>
                    {context.workspaces.map(({ id, type }) => <option key={id} value={id}>{workspaceLabels[type]}</option>)}
                  </select>
                </label>
              )}
              <label className={styles.field}>
                Dompet
                <select name="wallet_id" value={draft.walletId} onChange={(event) => setDraft({ ...draft, walletId: event.target.value })}>
                  {wallets.length === 0 && <option value="">{context ? "Tidak ada dompet aktif" : "Memuat dompet…"}</option>}
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
            <button className={styles.primaryButton} type="submit" disabled={pending || !draft.walletId}>Simpan Perubahan</button>
            <button className={styles.deleteOutline} type="button" disabled={pending} onClick={() => { setConfirmDelete(true); setError(""); }}>Hapus Transaksi</button>
          </div>
        </form>
      )}
      {pending && <p className={styles.muted} role="status">Memproses transaksi…</p>}
      {contextError && (
        <div>
          <p className={styles.error} role="alert">{contextError}</p>
          <button className={styles.neutralButton} type="button" onClick={() => setLoadVersion((version) => version + 1)}>Coba Lagi</button>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </dialog>
  );
}
