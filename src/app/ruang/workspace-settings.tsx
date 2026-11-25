"use client";

import { Check, Copy, House, KeyRound, LockKeyhole, UsersRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { WalletManagement } from "@/components/transactions/wallet-management";
import { formatDateTime } from "@/lib/format";
import type { WorkspaceAction, WorkspaceState, WorkspaceType } from "@/types/database";
import styles from "./ruang.module.css";

const tabs = [
  { type: "personal", title: "Pribadi", Icon: LockKeyhole },
  { type: "household", title: "Rumah Tangga", Icon: House },
] as const;

type WorkspaceResponse = { state: WorkspaceState } | { error: string };

export function WorkspaceSettings({ initialState }: { initialState: WorkspaceState }) {
  const [state, setState] = useState(initialState);
  const [view, setView] = useState<WorkspaceType>(
    initialState.household?.id === initialState.active_workspace_id ? "household" : "personal",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const tabButtons = useRef<Partial<Record<WorkspaceType, HTMLButtonElement>>>({});
  const { household, invitation } = state;
  const viewedWorkspace = state[view];
  const issuedCode = invitation?.code;

  useEffect(() => {
    if (!issuedCode || view !== "household" || pending) return;

    const controller = new AbortController();
    let refreshing = false;

    async function refreshInvite() {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        const response = await fetch("/api/workspaces", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const result: WorkspaceResponse = await response.json();
        if (!controller.signal.aborted && "state" in result) setState(result.state);
      } catch {
        // Pertahankan tampilan ketika koneksi sementara terputus.
      } finally {
        refreshing = false;
      }
    }

    window.addEventListener("focus", refreshInvite);
    const interval = window.setInterval(refreshInvite, 8000);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refreshInvite);
      window.clearInterval(interval);
    };
  }, [issuedCode, pending, view]);

  async function mutate(action: WorkspaceAction) {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
      });
      const result: WorkspaceResponse = await response.json();
      if (!response.ok || !("state" in result)) {
        setError("error" in result ? result.error : "Pengaturan ruang belum bisa disimpan.");
        return false;
      }
      setState(result.state);
      return true;
    } catch {
      setError("Pengaturan ruang belum bisa disimpan. Coba lagi.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function selectTab(type: WorkspaceType) {
    if (pending) return;
    const workspace = state[type];
    if (workspace && workspace.id !== state.active_workspace_id) {
      if (!(await mutate({ action: "select", workspace_id: workspace.id }))) return;
    }
    setError("");
    setView(type);
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, type: WorkspaceType) {
    let next: WorkspaceType;
    if (event.key === "Home") next = "personal";
    else if (event.key === "End") next = "household";
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      next = type === "personal" ? "household" : "personal";
    } else return;
    event.preventDefault();
    tabButtons.current[next]?.focus();
  }

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[0-9]{6}$/.test(code)) {
      setError("Masukkan 6 digit kode undangan.");
      return;
    }
    if (await mutate({ action: "join", code })) setCode("");
  }

  async function copyInvite() {
    if (!invitation) return;
    setError("");
    try {
      await navigator.clipboard.writeText(invitation.code);
      setCopiedCode(invitation.code);
    } catch {
      setError("Kode belum bisa disalin. Pilih kode untuk menyalinnya.");
    }
  }

  return (
    <div className={styles.settings} aria-busy={pending}>
      <p id="current-workspace-label" className="sr-only">Ruang aktif</p>
      <div id="workspace-switcher" className={styles.tabs} role="tablist" aria-label="Pilih ruang">
        {tabs.map(({ type, title, Icon }) => {
          const active = state[type]?.id === state.active_workspace_id;
          return (
            <button
              key={type}
              ref={(element) => { if (element) tabButtons.current[type] = element; }}
              id={`workspace-tab-${type}`}
              type="button"
              role="tab"
              aria-label={title}
              aria-controls={`workspace-panel-${type}`}
              aria-selected={view === type}
              aria-describedby={active ? "current-workspace-label" : undefined}
              aria-disabled={pending}
              tabIndex={view === type ? 0 : -1}
              className={styles.tab}
              onClick={() => void selectTab(type)}
              onKeyDown={(event) => moveFocus(event, type)}
            >
              <span className={styles.tabIcon}><Icon size={22} strokeWidth={1.7} aria-hidden="true" /></span>
              {title}
              {active && <span className={styles.active} aria-hidden="true"><Check size={14} /> Aktif</span>}
            </button>
          );
        })}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <section
        id="workspace-panel-personal"
        className={styles.panel}
        data-reveal
        data-lift
        role="tabpanel"
        aria-labelledby="workspace-tab-personal"
        hidden={view !== "personal"}
        tabIndex={0}
      >
        <h2>Ruang Pribadi</h2>
        <p>Hanya Anda yang dapat mengakses ruang ini.</p>
      </section>
      <section
        id="workspace-panel-household"
        className={styles.panel}
        data-reveal
        data-lift
        role="tabpanel"
        aria-labelledby="workspace-tab-household"
        hidden={view !== "household"}
        tabIndex={0}
      >
        <h2>Ruang Rumah Tangga</h2>
        {household ? (
          <>
            <p role="status">
              {household.member_count === 2 ? "Pasangan sudah bergabung." : "Menunggu pasangan bergabung."}
            </p>
            {household.is_owner && household.member_count < 2 && (
              <div className={styles.inviteActions}>
                {invitation && (
                  <div className={styles.invite}>
                    <div className={styles.inviteDetails}>
                      <label htmlFor="household-invite-code">Kode undangan</label>
                      <output id="household-invite-code" data-invite-code className={styles.inviteCode}>
                        {invitation.code}
                      </output>
                      <p>Berlaku sampai {formatDateTime(invitation.expires_at)} WIB</p>
                    </div>
                    <div>
                      <button className={styles.secondaryButton} type="button" onClick={() => void copyInvite()} disabled={pending}>
                        <Copy size={17} aria-hidden="true" /> Salin Kode
                      </button>
                      {copiedCode === invitation.code && <p className={styles.notice} role="status">Kode disalin.</p>}
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className={invitation ? styles.secondaryButton : styles.primaryButton}
                  onClick={() => void mutate({ action: "create_invite" })}
                  disabled={pending}
                >
                  Buat Kode Undangan
                </button>
              </div>
            )}
          </>
        ) : (
          <div className={styles.setup}>
            <div className={styles.setupBlock}>
              <span className={styles.setupIcon}><KeyRound size={20} strokeWidth={1.7} aria-hidden="true" /></span>
              <h3>Buat undangan</h3>
              <p>Kirim kode undangan ke pasangan Anda.</p>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={pending}
                onClick={() => void mutate({ action: "create_invite" })}
              >
                Buat Kode Undangan
              </button>
            </div>
            <form className={styles.setupBlock} onSubmit={join}>
              <span className={styles.setupIcon}><UsersRound size={20} strokeWidth={1.7} aria-hidden="true" /></span>
              <h3>Sudah punya kode undangan?</h3>
              <label className="sr-only" htmlFor="join-workspace-code">Kode undangan</label>
              <input
                id="join-workspace-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                placeholder="Masukkan 6 digit kode undangan"
                className={styles.codeInput}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))}
                disabled={pending}
              />
              <button className={styles.secondaryButton} type="submit" disabled={pending}>
                Gabung Ruang Pasangan
              </button>
            </form>
          </div>
        )}
      </section>
      {viewedWorkspace && <WalletManagement key={viewedWorkspace.id} workspaceId={viewedWorkspace.id} />}
    </div>
  );
}
