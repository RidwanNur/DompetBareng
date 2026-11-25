import { headers } from "next/headers";
import { cache } from "react";
import { createClient, getSupabaseConfig } from "@/lib/supabase/server";

const authErrors = {
  google: "Tidak bisa masuk dengan Google. Coba lagi.",
  email: "Tautan konfirmasi email tidak valid atau sudah kedaluwarsa.",
  configuration: "Autentikasi belum dikonfigurasi.",
  logout: "Terjadi kendala saat keluar dari akun.",
} as const;

type AuthErrorCode = keyof typeof authErrors;
const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

export function isSupabaseConfigured() {
  return getSupabaseConfig() !== null;
}

export const getCurrentUser = cache(async () => {
  if (!isSupabaseConfigured()) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});

export function getAuthErrorMessage(code: string | undefined) {
  return code === "google" || code === "email" || code === "configuration" || code === "logout"
    ? authErrors[code]
    : undefined;
}

export async function getAppOrigin() {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    const url = URL.parse(configured);
    if (
      url &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopbackHosts.includes(url.hostname))) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return url.origin;
    }
    return null;
  }

  if (process.env.NODE_ENV === "development") {
    const host = (await headers()).get("host");
    if (host && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
      return URL.parse(`http://${host}`)?.origin ?? null;
    }
  }
  return null;
}

export function redirectToLogin(error?: AuthErrorCode) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: error ? `/login?auth_error=${error}` : "/login",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
