import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "./server";

export async function refreshSession(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) {
    return NextResponse.next();
  }

  const updatedCookies: Parameters<SetAllCookies>[0] = [];
  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookies) {
        for (const { name, value } of cookies) {
          request.cookies.set(name, value);
        }
        updatedCookies.push(...cookies);
      },
    },
  });

  await supabase.auth.getClaims();

  const response = NextResponse.next({ request });
  for (const { name, value, options } of updatedCookies) {
    response.cookies.set(name, value, options);
  }
  if (updatedCookies.length) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
