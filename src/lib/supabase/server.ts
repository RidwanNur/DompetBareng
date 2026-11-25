import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const protocol = url ? URL.parse(url)?.protocol : undefined;
  if (!url || !publishableKey || (protocol !== "https:" && protocol !== "http:")) {
    return null;
  }
  return { url, publishableKey };
}

export async function createClient() {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error("Konfigurasi Supabase belum lengkap.");
  }
  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component hanya dapat membaca cookie. Penyegaran sesi dilakukan di proxy autentikasi.
        }
      },
    },
  });
}
