import "server-only";

const secretVariables = [
  "GEMINI_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN",
  "SUPABASE_DB_PASSWORD", "DATABASE_URL", "GOOGLE_API_KEY",
];

function safeMessage(message: string) {
  let clean = message;
  for (const name of secretVariables) {
    const secret = process.env[name]?.trim();
    if (secret) clean = clean.replaceAll(secret, "[disaring]").replaceAll(encodeURIComponent(secret), "[disaring]");
  }
  return clean
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\b(?:Bearer\s+[\w./+=-]+|AIza[\w-]{20,}|sb_(?:secret|publishable)_[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi, "[disaring]")
    .replace(/\b\d{5,}:[\w-]{20,}\b/g, "[disaring]")
    .replace(/[\x00-\x1f\x7f]+|\s{2,}/g, " ")
    .trim().slice(0, 250);
}

export class TelegramCallError extends Error {
  constructor(message: string, readonly code: string, readonly stage?: string) {
    super(message);
    this.name = "TelegramCallError";
  }
}

export function telegramRpcError(operation: string, error: { code?: string }) {
  const candidate = error.code ?? "";
  const code = /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(candidate) ? candidate : "SUPABASE_RPC_FAILED";
  const context = code === "PGRST202" ? "tidak tersedia di cache skema Supabase. Periksa migrasi."
    : code === "23514" ? "melanggar constraint PostgreSQL."
      : code === "42501" ? "ditolak oleh kebijakan akses database."
        : "gagal di Supabase.";
  return new TelegramCallError(`RPC ${operation} ${context}`, code);
}

export function logTelegramFailure(label: string, stage: string, error: unknown) {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(error.name) ? safeMessage(error.name) : "Error";
  const errorMessage = error instanceof Error ? safeMessage(error.message) : "Kesalahan tanpa pesan.";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? safeMessage(code) : "UNEXPECTED";
  console.warn(label, {
    stage: error instanceof TelegramCallError && error.stage ? error.stage : stage,
    errorName, errorMessage: errorMessage || "Kesalahan tanpa pesan.", errorCode,
  });
}
