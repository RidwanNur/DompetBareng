const internalOrigin = "https://app.invalid";

export function getInternalReturnPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\x00-\x1f\x7f\\]/.test(value)
  ) return;

  const url = URL.parse(value, internalOrigin);
  if (!url || url.origin !== internalOrigin) return;

  try {
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("//") || path.includes("\\")) return;
  } catch {
    return;
  }

  return url.pathname + url.search + url.hash;
}

export function isInvitationCode(value: unknown): value is string {
  return typeof value === "string" && value.length === 6 && /^[0-9]+$/.test(value);
}

export function invitationPath(code: string) {
  return "/ruang?" + new URLSearchParams({ invite: code });
}

export function loginPath(returnPath?: string) {
  return returnPath ? "/login?" + new URLSearchParams({ next: returnPath }) : "/login";
}
