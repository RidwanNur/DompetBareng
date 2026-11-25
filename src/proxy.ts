import { NextResponse, type NextRequest } from "next/server";
import { getInternalReturnPath } from "@/lib/navigation";
import { refreshSession } from "@/lib/supabase/proxy";

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/auth/callback") {
    return NextResponse.next();
  }

  const code = searchParams.get("code");
  if (pathname === "/" && code?.trim()) {
    const callback = new URL("/auth/callback", request.url);
    callback.searchParams.set("code", code);
    const returnPath = getInternalReturnPath(searchParams.get("next"));
    if (returnPath) callback.searchParams.set("next", returnPath);
    return NextResponse.redirect(callback, {
      status: 303,
      headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  }

  return refreshSession(request);
}

export const config = {
  matcher: ["/", "/login", "/ruang", "/riwayat", "/laporan"],
};
