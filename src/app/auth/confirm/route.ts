import { authRedirect, isSupabaseConfigured, redirectToLogin } from "@/lib/auth";
import { getInternalReturnPath } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  let tokenHash = searchParams.get("token_hash");
  let next = searchParams.get("next");
  // Template yang sudah dipakai menambahkan ?token_hash di akhir URL tujuan.
  // Next.js dapat menormalkan pemisah kedua tersebut sebagai bagian dari nilai next.
  const legacySeparator = "?token_hash=";
  const separator = next?.lastIndexOf(legacySeparator) ?? -1;
  if (!tokenHash && next && separator >= 0) {
    tokenHash = next.slice(separator + legacySeparator.length);
    next = next.slice(0, separator);
  }
  const returnPath = getInternalReturnPath(next);
  if (!isSupabaseConfigured()) {
    return redirectToLogin("configuration", returnPath);
  }

  if (!tokenHash) {
    return redirectToLogin("email", returnPath);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  return error || !data.session ? redirectToLogin("email", returnPath) : authRedirect(returnPath ?? "/login");
}
