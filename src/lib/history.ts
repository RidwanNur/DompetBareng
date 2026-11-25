import "server-only";

import { revalidatePath } from "next/cache";
import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type HistoryTransaction,
  type Rupiah,
  type TransactionHistory,
  type TransactionHistoryFilters,
} from "@/types/database";

class HistoryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const unavailable = "Riwayat transaksi belum dapat diproses. Coba lagi.";
const invalidInput = "Data transaksi tidak valid.";
const maxAmount = "9223372036854775807";
const historyPageSize = 25;
const filterNames = ["month", "wallet_id", "category", "recorder", "search", "before_at", "before_id"] as const;
const categories = new Set<string>([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]);
const monthPattern = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/;
const timestampPattern =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$/;

type RawFilters = Partial<Record<(typeof filterNames)[number], unknown>>;

export function historyResponse(body: { history: TransactionHistory } | { ok: true } | { error: string }, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function historyFailure(error: unknown) {
  return error instanceof HistoryError
    ? historyResponse({ error: error.message }, error.status)
    : historyResponse({ error: unavailable }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is Rupiah {
  return (
    typeof value === "string" && value === value.trim() && /^[1-9][0-9]*$/.test(value) &&
    (value.length < maxAmount.length || (value.length === maxAmount.length && value <= maxAmount))
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim() || !timestampPattern.test(value)) return false;
  const date = value.slice(0, 10);
  const day = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === date;
}

function readCashFlow(value: Record<string, unknown>) {
  const { type, category } = value;
  if (type === "income") {
    const match = INCOME_CATEGORIES.find((candidate) => candidate === category);
    if (match) return { type, category: match } as const;
  }
  if (type === "expense") {
    const match = EXPENSE_CATEGORIES.find((candidate) => candidate === category);
    if (match) return { type, category: match } as const;
  }
  return null;
}

async function verifySession() {
  if (!isSupabaseConfigured()) throw new HistoryError(503, unavailable);
  if (!(await getCurrentUser())) throw new HistoryError(401, "Masuk untuk mengakses riwayat transaksi.");
}

function readFilters(filters: RawFilters) {
  const optional = (value: unknown) => value === "" ? undefined : value;
  const month = optional(filters.month);
  const walletId = optional(filters.wallet_id);
  const category = optional(filters.category);
  const recorder = optional(filters.recorder);
  const search = optional(filters.search);
  const beforeAt = optional(filters.before_at);
  const beforeId = optional(filters.before_id);
  if (
    (month !== undefined && (typeof month !== "string" || month.length !== 7 || !monthPattern.test(month))) ||
    (walletId !== undefined && !isUuid(walletId)) ||
    (category !== undefined && (typeof category !== "string" || !categories.has(category))) ||
    (recorder !== undefined && recorder !== "self" && recorder !== "partner") ||
    (search !== undefined && (typeof search !== "string" || search.includes("\0"))) ||
    (beforeAt !== undefined && !isTimestamp(beforeAt)) ||
    (beforeId !== undefined && !isUuid(beforeId)) ||
    (beforeAt === undefined) !== (beforeId === undefined)
  ) {
    throw new HistoryError(400, "Filter riwayat tidak valid.");
  }

  return {
    p_month: month ?? null,
    p_wallet_id: walletId ?? null,
    p_category: category ?? null,
    p_recorder: recorder ?? null,
    p_search: search?.trim() || null,
    p_before_at: beforeAt ?? null,
    p_before_id: beforeId ?? null,
  };
}

function readWallet(value: unknown): TransactionHistory["wallets"][number] {
  if (!isRecord(value) || !isUuid(value.id) || typeof value.name !== "string" || !value.name.trim()) {
    throw new HistoryError(503, unavailable);
  }
  return { id: value.id, name: value.name };
}

function readTransaction(value: unknown): HistoryTransaction {
  if (!isRecord(value)) throw new HistoryError(503, unavailable);
  const { id, item, amount, occurred_at, recorded_by, wallet_id, wallet_name } = value;
  const flow = readCashFlow(value);
  if (
    !isUuid(id) || typeof item !== "string" || !item.trim() || !isAmount(amount) ||
    !isTimestamp(occurred_at) || (recorded_by !== "self" && recorded_by !== "partner") ||
    !isUuid(wallet_id) || typeof wallet_name !== "string" || !wallet_name.trim() || !flow
  ) {
    throw new HistoryError(503, unavailable);
  }

  return { id, item, amount, occurred_at, recorded_by, wallet_id, wallet_name, ...flow };
}

function readHistory(value: unknown, workspaceId: string): TransactionHistory {
  if (value === null) throw new HistoryError(403, "Anda tidak tergabung dalam ruang ini.");
  if (
    !isRecord(value) || value.workspace_id !== workspaceId || !Array.isArray(value.wallets) ||
    !Array.isArray(value.transactions) || value.transactions.length > historyPageSize
  ) {
    throw new HistoryError(503, unavailable);
  }

  const wallets = value.wallets.map(readWallet);
  const transactions = value.transactions.map(readTransaction);
  const last = transactions.at(-1);
  const cursor = value.next_cursor;
  let next_cursor: TransactionHistory["next_cursor"] = null;
  if (cursor !== null) {
    if (!last || !isRecord(cursor) || cursor.id !== last.id || cursor.occurred_at !== last.occurred_at) {
      throw new HistoryError(503, unavailable);
    }
    next_cursor = { id: last.id, occurred_at: last.occurred_at };
  }
  return { workspace_id: workspaceId, wallets, transactions, next_cursor };
}

async function queryHistory(workspaceId: string, filters: RawFilters) {
  if (!isUuid(workspaceId)) throw new HistoryError(400, "Ruang transaksi tidak valid.");
  const id = workspaceId.toLowerCase();
  const query = readFilters(filters);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_transaction_history", { p_workspace_id: id, ...query });
  if (error) throw new HistoryError(503, unavailable);
  return readHistory(data, id);
}

export async function getTransactionHistory(
  workspaceId: string,
  filters: TransactionHistoryFilters = {},
): Promise<TransactionHistory> {
  return queryHistory(workspaceId, filters);
}

export async function getHistoryFromRequest(request: Request) {
  await verifySession();
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspace_id") ?? (await getWorkspaceState()).active_workspace_id;
  const filters = Object.fromEntries(filterNames.map((name) => [name, params.get(name) ?? undefined]));
  return queryHistory(workspaceId, filters);
}

async function readMutation(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    site === "cross-site" || site === "same-site" ||
    (origin !== null && origin !== new URL(request.url).origin && origin !== (await getAppOrigin()))
  ) {
    throw new HistoryError(403, "Permintaan dari luar DompetBareng ditolak.");
  }
  await verifySession();

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HistoryError(415, "Kirim permintaan dalam format JSON.");

  const data: unknown = await request.json().catch(() => null);
  if (!isRecord(data) || !isUuid(data.workspace_id)) throw new HistoryError(400, invalidInput);
  return { data, workspaceId: data.workspace_id.toLowerCase() };
}

function readUpdate(data: Record<string, unknown>) {
  const { item, amount, wallet_id, occurred_at } = data;
  const flow = readCashFlow(data);
  if (
    typeof item !== "string" || !item.trim() || item.includes("\0") || !isAmount(amount) ||
    !isUuid(wallet_id) || !isTimestamp(occurred_at) || !flow
  ) {
    throw new HistoryError(400, invalidInput);
  }
  return {
    p_item: item.trim(),
    p_amount: amount,
    p_type: flow.type,
    p_category: flow.category,
    p_wallet_id: wallet_id,
    p_occurred_at: occurred_at,
  };
}

export async function changeHistoryTransaction(request: Request, transactionId: string, action: "update" | "delete") {
  if (!isUuid(transactionId)) throw new HistoryError(400, invalidInput);
  const { data, workspaceId } = await readMutation(request);
  const args = { p_workspace_id: workspaceId, p_transaction_id: transactionId.toLowerCase() };
  const supabase = await createClient();
  const result = action === "update"
    ? await supabase.rpc("update_history_transaction", { ...args, ...readUpdate(data) })
    : await supabase.rpc("delete_history_transaction", args);

  if (result.error) throw new HistoryError(503, unavailable);
  if (result.data === "not_found") {
    throw new HistoryError(404, "Transaksi tidak ditemukan atau tidak dapat diubah.");
  }
  if (result.data === "invalid_wallet") throw new HistoryError(400, "Dompet transaksi tidak valid.");
  if (result.data === "invalid_input") throw new HistoryError(400, invalidInput);
  if (result.data !== (action === "update" ? "updated" : "deleted")) {
    throw new HistoryError(503, unavailable);
  }

  revalidatePath("/");
  revalidatePath("/riwayat");
  revalidatePath("/laporan");
}
