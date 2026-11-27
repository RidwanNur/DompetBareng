import { PwaInputError, pwaInputResponseHeaders, recordPwaInput } from "@/lib/pwa-input";

export const runtime = "nodejs";

function sharedRedirect(location: string) {
  return new Response(null, {
    status: 303,
    headers: { ...pwaInputResponseHeaders, Location: location },
  });
}

export async function POST(request: Request) {
  try {
    await recordPwaInput(request, true);
    return sharedRedirect("/?shared=success");
  } catch (error) {
    if (error instanceof PwaInputError) {
      if (error.status === 401) return sharedRedirect("/login?shared=login");
      if (error.status === 429) return sharedRedirect("/?shared=limited");
      if (error.status === 409 || error.status >= 500) return sharedRedirect("/?shared=failed");
      return sharedRedirect("/?shared=invalid");
    }
    return sharedRedirect("/?shared=failed");
  }
}
