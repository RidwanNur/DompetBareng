"use client";

import { useSearchParams } from "next/navigation";
import { useActionState, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { authenticate, type AuthState } from "./actions";
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
  const searchParams = useSearchParams();
  const [googleError, setGoogleError] = useState(searchParams.get("error") === "oauth_failed");
  const [googlePending, setGooglePending] = useState(false);

  async function signInWithGoogle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (googlePending) return;
    setGoogleError(false);
    setGooglePending(true);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error || !data.url) setGoogleError(true);
    } catch {
      setGoogleError(true);
    } finally {
      setGooglePending(false);
    }
  }

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
      <form onSubmit={signInWithGoogle} className="grid gap-4" aria-busy={googlePending}>
        <button className={styles.secondaryButton} disabled={googlePending} type="submit">
          Masuk dengan Google
        </button>
        {googleError && <p className={styles.error} role="alert">Tidak bisa masuk dengan Google. Coba lagi.</p>}
      </form>
    </div>
  );
}
