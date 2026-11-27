"use client";

import { Camera, ScanLine, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ManualInput, type ManualTransactionInput } from "./manual-input";
import { prepareReceipt } from "./prepare-receipt";
import styles from "./quick-input.module.css";

type InputAttempt = { workspaceId: string; id: string; input: string | File };
type EntryInput = { text: string } | { manual: ManualTransactionInput } | File;
export type ShareResult = "success" | "invalid" | "failed" | "limited";

const savedMessage = "Transaksi berhasil disimpan";
const shareErrors: Record<Exclude<ShareResult, "success">, string> = {
  invalid: "Foto struk belum bisa diproses. Pilih foto yang jelas lewat + Catat.",
  failed: "Foto struk belum bisa disimpan. Coba bagikan ulang.",
  limited: "Batas penggunaan AI harian tercapai. Catat Manual lewat + Catat.",
};

export function QuickInput({
  workspaceId,
  workspaceName,
  recordClassName,
  shared,
}: {
  workspaceId: string;
  workspaceName: string;
  recordClassName: string;
  shared?: ShareResult;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const attempt = useRef<InputAttempt | null>(null);
  const inFlight = useRef(false);
  const [space, setSpace] = useState({ id: workspaceId, name: workspaceName });
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(shared === "limited");
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [notice, setNotice] = useState(shared === "success" ? savedMessage : shared ? shareErrors[shared] : "");
  const [saved, setSaved] = useState(shared === "success");

  useEffect(() => {
    if (!shared) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("shared");
    window.history.replaceState(window.history.state, "", url);
  }, [shared]);

  function openDialog() {
    setSpace({ id: workspaceId, name: workspaceName });
    setError("");
    setNotice("");
    dialog.current?.showModal();
    setIsOpen(true);
  }

  function switchMode() {
    setManual((current) => !current);
    setError("");
    clearReceipt();
  }

  function clearReceipt() {
    setReceipt(null);
    if (gallery.current) gallery.current.value = "";
    if (camera.current) camera.current.value = "";
  }

  async function save(input: EntryInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setQuotaBlocked(false);
    try {
      const previous = attempt.current;
      const signature = input instanceof File ? input : JSON.stringify(input);
      const id = previous?.input === signature && previous.workspaceId === space.id ? previous.id : crypto.randomUUID();
      attempt.current = { workspaceId: space.id, id, input: signature };

      let options: RequestInit;
      if (!(input instanceof File)) {
        options = {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, workspace_id: space.id, input_id: id }),
        };
      } else {
        const image = await prepareReceipt(input).catch(() => null);
        if (!image) {
          setError("Foto terlalu besar untuk diproses. Pilih foto yang lebih kecil.");
          return;
        }
        const body = new FormData();
        body.set("receipt", image);
        body.set("workspace_id", space.id);
        body.set("input_id", id);
        options = { body };
      }

      const response = await fetch("/api/transactions", { ...options, method: "POST" });
      const result = await response.json().catch(() => null);
      if (!response.ok || !Number.isSafeInteger(result?.count) || result.count < 1) {
        setQuotaBlocked(response.status === 429);
        setError(typeof result?.error === "string" ? result.error : "Transaksi belum bisa disimpan. Coba lagi.");
        return;
      }

      attempt.current = null;
      setText("");
      clearReceipt();
      setSaved(true);
      setNotice(savedMessage);
      dialog.current?.close();
      router.refresh();
    } catch {
      setError("Transaksi belum bisa disimpan. Coba lagi.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanText = text.trim();
    if (!cleanText) {
      setError("Tulis transaksi yang ingin disimpan.");
      return;
    }
    clearReceipt();
    void save({ text: cleanText });
  }

  function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setReceipt(file);
    void save(file);
  }

  return (
    <div className={styles.entry}>
      <button id="quick-input-btn" className={recordClassName} type="button" aria-haspopup="dialog" aria-controls="quick-input-modal" onClick={openDialog}>
        + Catat
      </button>
      {notice && <p className={saved ? styles.saved : styles.error} role={saved ? "status" : "alert"}>{notice}</p>}
      <dialog
        id="quick-input-modal"
        className={styles.dialog}
        data-reveal
        ref={dialog}
        aria-labelledby="quick-input-title"
        onCancel={(event) => { if (inFlight.current) event.preventDefault(); }}
        onClose={() => {
          setIsOpen(false);
          clearReceipt();
          if (attempt.current && typeof attempt.current.input !== "string") attempt.current = null;
        }}
      >
        <div className={styles.heading}>
          <div>
            <h2 id="quick-input-title">Catat transaksi</h2>
            <p className={styles.room}>{space.name}</p>
          </div>
          <button type="button" className={styles.close} aria-label="Tutup" onClick={() => dialog.current?.close()} disabled={pending}>
            <X size={22} aria-hidden="true" />
          </button>
        </div>
        {isOpen && manual && (
          <ManualInput key={space.id} workspaceId={space.id} pending={pending} onSave={(input) => void save({ manual: input })} />
        )}
        <div className={styles.automatic} hidden={manual}>
          <form className={styles.form} onSubmit={submitText} aria-busy={pending}>
            <label className={styles.field}>
              Teks transaksi
              <textarea
                name="text"
                placeholder="Contoh: belanja sayur 45rb cash, kopi 25rb qris"
                maxLength={4000}
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
                disabled={pending}
              />
            </label>
            <button className={styles.submit} type="submit" disabled={pending}>Catat Sekarang</button>
          </form>
          <div className={styles.photos}>
            <input id="receipt-upload-input" ref={gallery} type="file" accept="image/*" hidden onChange={handlePhoto} disabled={pending} />
            <input id="receipt-camera-input" ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={handlePhoto} disabled={pending} />
            <button className={styles.secondary} type="button" onClick={() => gallery.current?.click()} disabled={pending}>
              <ScanLine aria-hidden="true" size={19} /> Scan Struk / QRIS
            </button>
            <button className={styles.secondary} type="button" onClick={() => camera.current?.click()} disabled={pending}>
              <Camera aria-hidden="true" size={19} /> Ambil Foto
            </button>
          </div>
        </div>
        {pending && <p className={styles.progress} role="status">Memproses transaksi…</p>}
        {error && (
          <div className={styles.failure}>
            <p className={styles.error} role="alert">{error}</p>
            {receipt && !quotaBlocked && <button type="button" className={styles.secondary} onClick={() => void save(receipt)} disabled={pending}>Coba Lagi</button>}
          </div>
        )}
        <button type="button" className={styles.modeSwitch} onClick={switchMode} disabled={pending}>
          {manual ? "Gunakan Teks atau Foto" : "Catat Manual"}
        </button>
      </dialog>
    </div>
  );
}
