import { isSupabaseConfigured, redirectToLogin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) {
    return redirectToLogin("configuration");
  }

  const tokenHash = new URL(request.url).searchParams.get("token_hash");
  if (!tokenHash) {
    return redirectToLogin("email");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  return redirectToLogin(error || !data.session ? "email" : undefined);
}
