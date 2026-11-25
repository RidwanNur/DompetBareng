"use client";

import { ArrowLeftRight, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DashboardAmount } from "@/components/dashboard/amount";
import { signalTransactionRefresh, subscribeToWorkspaceRefresh } from "@/lib/transaction-refresh";
import { WALLET_TYPES, type ManagedWallet, type WalletAction, type WalletOverview, type WalletType } from "@/types/database";
import formStyles from "./history.module.css";
import styles from "./wallet-management.module.css";

type Mode = { action: "create" } | { action: "transfer" } | { action: "update" | "adjust" | "delete"; wallet: ManagedWallet };

const walletTypeLabels: Record<WalletType, string> = { cash: "Tunai", bank: "Bank", ewallet: "E-Wallet" };
const titles = { create: "Tambah Dompet", update: "Ubah Dompet", adjust: "Sesuaikan Saldo Awal", transfer: "Transfer Antar-Dompet", delete: "Hapus Dompet?" };
const outcomes: Record<string, string> = {
  created: "Dompet ditambahkan.",
  updated: "Perubahan dompet disimpan.",
  adjusted: "Saldo awal disimpan.",
  transferred: "Transfer antar-dompet disimpan.",
  deleted: "Dompet dihapus.",
  archived: "Dompet diarsipkan.",
};

function integer(value: FormDataEntryValue | null, signed = false) {
  if (typeof value !== "string" || !/^-?[0-9]{1,19}$/.test(value.trim())) return null;
  const parsed = BigInt(value.trim());
  if (parsed > 9223372036854775807n || parsed < -9223372036854775808n || (!signed && parsed <= 0n)) return null;
  return parsed.toString() as `${bigint}`;
}

function actionFromForm(mode: Mode, fields: FormData): WalletAction | null {
  if (mode.action === "transfer") {
    const from = fields.get("from_wallet_id");
    const to = fields.get("to_wallet_id");
    const amount = integer(fields.get("amount"));
    return typeof from === "string" && typeof to === "string" && from && to && from !== to && amount
      ? { action: "transfer", from_wallet_id: from, to_wallet_id: to, amount }
      : null;
  }
  if (mode.action === "create" || mode.action === "update") {
    const name = fields.get("name");
    const type = WALLET_TYPES.find((entry) => entry === fields.get("type"));
    if (typeof name !== "string" || !name.trim() || !type) return null;
    return mode.action === "create"
      ? { action: "create", name: name.trim(), type }
      : { action: "update", wallet_id: mode.wallet.id, name: name.trim(), type };
  }
  if (!("wallet" in mode)) return null;
  if (mode.action === "delete") return { action: "delete", wallet_id: mode.wallet.id };
  const openingBalance = integer(fields.get("opening_balance"), true);
  return openingBalance === null ? null : { action: "adjust", wallet_id: mode.wallet.id, opening_balance: openingBalance };
}

function WalletChoice({ name, label, wallets, defaultValue }: {
  name: string;
  label: string;
  wallets: ManagedWallet[];
  defaultValue: string;
}) {
  return (
    <label className={formStyles.field}>
      {label}
      <select name={name} defaultValue={defaultValue}>
        {wallets.map((wallet) => <option key={wallet.id} value={wallet.id}>{wallet.name}</option>)}
      </select>
    </label>
  );
}

function WalletDialog({ mode, workspaceId, wallets, onDismiss, onSaved }: {
  mode: Mode;
  workspaceId: string;
  wallets: ManagedWallet[];
  onDismiss: () => void;
  onSaved: (overview: WalletOverview, outcome: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const activeRequest = useRef(false);
  const attempt = useRef<{ body: string; id: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const wallet = "wallet" in mode ? mode.wallet : undefined;

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeRequest.current) return;
    const action = actionFromForm(mode, new FormData(event.currentTarget));
    if (!action) {
      setError(mode.action === "transfer" ? "Pilih dua dompet berbeda dan isi nominal Rupiah yang benar." : "Periksa kembali data dompet.");
      return;
    }
    activeRequest.current = true;
    setPending(true);
    setError("");
    try {
      const fingerprint = JSON.stringify(action);
      const operationId = attempt.current?.body === fingerprint ? attempt.current.id : crypto.randomUUID();
      attempt.current = { body: fingerprint, id: operationId };

      const response = await fetch("/api/wallets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, operation_id: operationId, ...action }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.overview?.workspace_id !== workspaceId || typeof result?.outcome !== "string") {
        setError(typeof result?.error === "string" ? result.error : "Perubahan dompet belum bisa disimpan. Coba lagi.");
        return;
      }
      dialog.current?.close();
      onSaved(result.overview, result.outcome);
    } catch {
      setError("Perubahan dompet belum bisa disimpan. Coba lagi.");
    } finally {
      activeRequest.current = false;
      setPending(false);
    }
  }

  const actionText = mode.action === "create" ? "Simpan Dompet"
    : mode.action === "transfer" ? "Transfer"
      : mode.action === "delete" ? "Hapus Dompet" : "Simpan Perubahan";

  return (
    <dialog
      id="wallet-dialog"
      className={formStyles.dialog}
      data-reveal
      ref={dialog}
      aria-labelledby="wallet-dialog-title"
      onCancel={(event) => { if (activeRequest.current) event.preventDefault(); }}
      onClose={onDismiss}
    >
      <div className={formStyles.dialogHeading}>
        <h2 id="wallet-dialog-title">{titles[mode.action]}</h2>
        <button className={formStyles.neutralButton} type="button" aria-label="Tutup" onClick={() => dialog.current?.close()} disabled={pending}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form className={formStyles.editForm} onSubmit={save} aria-busy={pending}>
        <fieldset className={formStyles.editFields} disabled={pending}>
          {(mode.action === "create" || mode.action === "update") && (
            <>
              <label className={formStyles.field}>Nama Dompet<input name="name" maxLength={80} defaultValue={wallet?.name} required /></label>
              <label className={formStyles.field}>
                Tipe Dompet
                <select name="type" defaultValue={wallet?.type ?? "cash"}>
                  {WALLET_TYPES.map((type) => <option key={type} value={type}>{walletTypeLabels[type]}</option>)}
                </select>
              </label>
            </>
          )}
          {mode.action === "adjust" && (
            <label className={formStyles.field}>
              Saldo Awal (Rp)
              <input name="opening_balance" maxLength={20} defaultValue={wallet?.opening_balance ?? "0"} required />
            </label>
          )}
          {mode.action === "transfer" && (
            <>
              <WalletChoice name="from_wallet_id" label="Dari Dompet" wallets={wallets} defaultValue={wallets[0]?.id ?? ""} />
              <WalletChoice name="to_wallet_id" label="Ke Dompet" wallets={wallets} defaultValue={wallets[1]?.id ?? ""} />
              <label className={formStyles.field}>
                Nominal (Rp)
                <input name="amount" inputMode="numeric" maxLength={19} required />
              </label>
            </>
          )}
          {mode.action === "delete" && (
            <div>
              <p className={styles.walletName}>{wallet?.name}</p>
              <p className={formStyles.muted}>Dompet dengan riwayat akan diarsipkan.</p>
            </div>
          )}
        </fieldset>
        {error && <p className={formStyles.error} role="alert">{error}</p>}
        <div className={formStyles.dialogActions}>
          {mode.action === "delete" && (
            <button className={formStyles.neutralButton} type="button" onClick={() => dialog.current?.close()} disabled={pending}>Batal</button>
          )}
          <button className={mode.action === "delete" ? formStyles.deleteButton : formStyles.primaryButton} type="submit" disabled={pending}>{actionText}</button>
        </div>
      </form>
    </dialog>
  );
}

export function WalletManagement({ workspaceId }: { workspaceId: string }) {
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const activeWallets = overview?.wallets.filter((wallet) => !wallet.archived) ?? [];

  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") setLoadVersion((version) => version + 1);
    }

    const unsubscribe = subscribeToWorkspaceRefresh(workspaceId, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceId]);

  useEffect(() => {
    const request = new AbortController();
    async function load() {
      setLoadError(false);
      try {
        const response = await fetch("/api/wallets?workspace_id=" + encodeURIComponent(workspaceId), { cache: "no-store", signal: request.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.overview?.workspace_id !== workspaceId) throw new Error();
        if (!request.signal.aborted) setOverview(result.overview);
      } catch {
        if (!request.signal.aborted) setLoadError(true);
      }
    }
    void load();
    return () => request.abort();
  }, [loadVersion, workspaceId]);

  function saved(next: WalletOverview, outcome: string) {
    setOverview(next);
    setLoadVersion((version) => version + 1);
    setMode(null);
    setNotice(outcomes[outcome] ?? "Perubahan dompet disimpan.");
    signalTransactionRefresh();
  }

  return (
    <section id="wallet-management" className={styles.panel} aria-labelledby="wallet-management-title" data-reveal data-lift>
      <div className={styles.heading}>
        <h2 id="wallet-management-title">Dompet</h2>
        {overview && (
          <div className={styles.actions}>
            <button className={formStyles.primaryButton} type="button" onClick={() => setMode({ action: "create" })}>Tambah Dompet</button>
            <button className={formStyles.neutralButton} type="button" onClick={() => setMode({ action: "transfer" })} disabled={activeWallets.length < 2}>
              <ArrowLeftRight aria-hidden="true" size={17} /> Transfer Antar-Dompet
            </button>
          </div>
        )}
      </div>
      {notice && <p className={formStyles.notice} role="status">{notice}</p>}
      {loadError ? (
        <div className={styles.fallback}>
          <p className={formStyles.error} role="alert">Dompet belum bisa dimuat.</p>
          <button className={formStyles.neutralButton} type="button" onClick={() => setLoadVersion((version) => version + 1)}>Coba Lagi</button>
        </div>
      ) : !overview ? <p className={formStyles.muted} role="status">Memuat dompet…</p> : (
        <ul className={styles.list}>
          {overview.wallets.length === 0 && <li className={formStyles.muted}>Belum ada dompet.</li>}
          {overview.wallets.map((entry) => (
            <li key={entry.id} className={styles.row} data-wallet-id={entry.id} data-archived={entry.archived}>
              <span className={styles.icon} aria-hidden="true"><Wallet size={19} strokeWidth={1.65} /></span>
              <div className={styles.walletCopy}>
                <p className={styles.walletName}>{entry.name}</p>
                <p className={formStyles.muted}>{walletTypeLabels[entry.type]}{entry.archived ? " · Diarsipkan" : ""}</p>
                <DashboardAmount className={styles.balance} value={entry.balance} />
              </div>
              {!entry.archived && (
                <div className={styles.walletActions}>
                  <button className={formStyles.neutralButton} type="button" onClick={() => setMode({ action: "update", wallet: entry })}>Ubah Dompet</button>
                  <button className={formStyles.neutralButton} type="button" onClick={() => setMode({ action: "adjust", wallet: entry })}>Sesuaikan Saldo Awal</button>
                  <button className={formStyles.deleteOutline} type="button" onClick={() => setMode({ action: "delete", wallet: entry })}>Hapus Dompet</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode && <WalletDialog mode={mode} workspaceId={workspaceId} wallets={activeWallets} onDismiss={() => setMode(null)} onSaved={saved} />}
    </section>
  );
}
