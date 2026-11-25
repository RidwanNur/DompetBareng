"use server";

import { redirect } from "next/navigation";
import { getAppOrigin, getAuthErrorMessage, isSupabaseConfigured } from "@/lib/auth";
import { getInternalReturnPath } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";

export type AuthState = {
  error?: string;
  message?: string;
};

const missingOrigin = "Atur NEXT_PUBLIC_APP_URL ke alamat aplikasi yang digunakan.";

function emailError(code: string | undefined) {
  switch (code) {
    case "invalid_credentials":
      return "Email atau kata sandi salah.";
    case "email_not_confirmed":
      return "Konfirmasi email sebelum masuk.";
    case "weak_password":
      return "Kata sandi belum memenuhi ketentuan.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Terlalu banyak percobaan. Coba lagi nanti.";
    default:
      return "Autentikasi lewat email gagal. Coba lagi.";
  }
}

export async function authenticate(_previousState: AuthState, formData: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    return { error: getAuthErrorMessage("configuration") };
  }

  const intent = formData.get("intent");
  const emailInput = formData.get("email");
  const email = typeof emailInput === "string" ? emailInput.trim() : "";
  const password = formData.get("password");
  const returnPath = getInternalReturnPath(formData.get("next"));
  if (
    (intent !== "signin" && intent !== "signup") ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    typeof password !== "string" ||
    !password
  ) {
    return { error: "Masukkan email dan kata sandi yang valid." };
  }

  const supabase = await createClient();
  if (intent === "signin") {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      return { error: emailError(error?.code) };
    }
    redirect(returnPath ?? "/login");
  }

  const origin = await getAppOrigin();
  if (!origin) {
    return { error: missingOrigin };
  }

  const confirmUrl = new URL("/auth/confirm", origin);
  if (returnPath) confirmUrl.searchParams.set("next", returnPath);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: confirmUrl.href },
  });
  if (error && error.code !== "user_already_exists") {
    return { error: emailError(error.code) };
  }
  if (data.session) {
    redirect(returnPath ?? "/login");
  }
  return { message: "Periksa email untuk mengonfirmasi pendaftaran." };
}

export async function signInWithGoogle(_previousState: AuthState, _formData: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    return { error: getAuthErrorMessage("configuration") };
  }

  const origin = await getAppOrigin();
  if (!origin) {
    return { error: missingOrigin };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) {
    return { error: getAuthErrorMessage("google") };
  }
  redirect(data.url);
}

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      redirect("/login?auth_error=logout");
    }
  }
  redirect("/login");
}
