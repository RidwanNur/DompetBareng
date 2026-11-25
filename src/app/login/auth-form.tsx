"use client";

import { useActionState, useState } from "react";
import { authenticate, type AuthState, signInWithGoogle } from "./actions";
import styles from "./login.module.css";

const initialState: AuthState = {};
const emailModes = [
  { intent: "signin", label: "Masuk" },
  { intent: "signup", label: "Daftar" },
] as const;
type Intent = typeof emailModes[number]["intent"];

function EmailForm({ intent }: { intent: Intent }) {
  const [state, submit, pending] = useActionState(authenticate, initialState);
  const [email, setEmail] = useState("");

  return (
    <form action={submit} className="grid gap-4">
      <input type="hidden" name="intent" value={intent} />
      <label className={styles.field}>
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label className={styles.field}>
        Kata sandi
        <input
          name="password"
          type="password"
          autoComplete={intent === "signup" ? "new-password" : "current-password"}
          required
        />
      </label>
      <button className={styles.primaryButton} disabled={pending} type="submit">
        {pending ? "Memproses…" : intent === "signup" ? "Daftar dengan Email" : "Masuk dengan Email"}
      </button>
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      {state.message && <p className={styles.notice} role="status">{state.message}</p>}
    </form>
  );
}

export function AuthForm() {
  const [intent, setIntent] = useState<Intent>("signin");
  const [googleState, googleAction, googlePending] = useActionState(signInWithGoogle, initialState);

  return (
    <div className={styles.formStack}>
      <div className={styles.modeSwitch} role="group" aria-label="Pilihan akun">
        {emailModes.map((mode) => (
          <button
            key={mode.intent}
            type="button"
            aria-pressed={intent === mode.intent}
            onClick={() => setIntent(mode.intent)}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <EmailForm key={intent} intent={intent} />
      <form action={googleAction} className="grid gap-4" aria-busy={googlePending}>
        <button className={styles.secondaryButton} disabled={googlePending} type="submit">
          Masuk dengan Google
        </button>
        {googleState.error && <p className={styles.error} role="alert">{googleState.error}</p>}
      </form>
    </div>
  );
}
