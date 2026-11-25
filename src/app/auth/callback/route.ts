import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "@/lib/supabase/server";

const redirectHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function redirectWithinApp(path: string, request: NextRequest) {
  const response = NextResponse.redirect(new URL(path, request.url), { headers: redirectHeaders });
  // Gunakan host browser agar cookie sesi tetap terbaca saat Next.js menormalkan alamat loopback.
  response.headers.set("Location", path);
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const config = getSupabaseConfig();
  if (code && config) {
    try {
      const response = redirectWithinApp("/", request);
      const supabase = createServerClient(config.url, config.publishableKey, {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      });
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error && data.session) return response;
    } catch {
      // Gangguan jaringan mengikuti pengalihan gagal yang sama.
    }
  }

  return redirectWithinApp("/login?error=oauth_failed", request);
}
