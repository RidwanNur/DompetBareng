import { isSupabaseConfigured, redirectToLogin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) {
    return redirectToLogin("configuration");
  }

  const code = new URL(request.url).searchParams.get("code");
  if (!code) {
    return redirectToLogin("google");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  return redirectToLogin(error || !data.session ? "google" : undefined);
}
