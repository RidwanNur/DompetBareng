import { Send } from "lucide-react";
import Link from "next/link";
import { getAuthErrorMessage, getCurrentUser } from "@/lib/auth";
import { getTelegramLinkStatus } from "@/lib/telegram-link";
import { signOut } from "./actions";
import { AuthForm } from "./auth-form";
import styles from "./login.module.css";
import { TelegramConnect } from "./telegram-connect";

type LoginPageProps = {
  searchParams: Promise<{ auth_error?: string | string[]; shared?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [user, { auth_error: authError, shared }] = await Promise.all([getCurrentUser(), searchParams]);
  const authMessage = getAuthErrorMessage(typeof authError === "string" ? authError : undefined);
  const telegramStatus = user ? await getTelegramLinkStatus().catch(() => null) : null;

  return (
    <main className="app-main">
      <div className={styles.layout}>
        <section className={styles.account} aria-labelledby="account-title" data-reveal data-lift>
          <h1 id="account-title">{user ? "Akun" : "Masuk ke SakuBareng"}</h1>
          {authMessage && <p className={styles.error} role="alert">{authMessage}</p>}
          {shared === "login" && <p className={styles.notice} role="status">Masuk, lalu bagikan ulang foto struk.</p>}
          {user ? (
            <>
              {user.email && (
                <dl className={styles.identity}>
                  <dt>Email</dt>
                  <dd>{user.email}</dd>
                </dl>
              )}
              <div className={styles.accountActions}>
                <Link className={styles.primaryButton} href="/" data-lift>Buka Beranda</Link>
                <form action={signOut}>
                  <button className={styles.secondaryButton} type="submit">Keluar</button>
                </form>
              </div>
            </>
          ) : <AuthForm />}
        </section>
        <section className={styles.telegram} aria-labelledby="telegram-title" data-reveal data-lift>
          <span className={styles.telegramIcon} aria-hidden="true"><Send size={23} strokeWidth={1.7} /></span>
          <h2 id="telegram-title">Telegram</h2>
          {user ? <TelegramConnect status={telegramStatus} /> : <p>Masuk untuk menghubungkan akun Telegram.</p>}
        </section>
      </div>
    </main>
  );
}
