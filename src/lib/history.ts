import "server-only";

import { revalidatePath } from "next/cache";
import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { historyCategories, historyFilterNames, isHistoryMonth, isHistoryType } from "@/lib/history-filters";
import { createClient } from "@/lib/supabase/server";
import { moveTransaction } from "@/lib/transaction-move";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  WALLET_TYPES,
  type HistoryTransaction,
  type Rupiah,
  type TransactionEditorContext,
  type TransactionHistory,
  type TransactionHistoryFilters,
  type WorkspaceType,
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
const filterNames = [...historyFilterNames, "before_at", "before_id"] as const;
const timestampPattern =
  /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])$/;

type RawFilters = Partial<Record<(typeof filterNames)[number], unknown>>;
type MutationResponse = { ok: true; moved_to?: WorkspaceType };

export function historyResponse(body: { history: TransactionHistory } | { editor: TransactionEditorContext } | MutationResponse | { error: string }, status = 200) {
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
  const user = await getCurrentUser();
  if (!user) throw new HistoryError(401, "Masuk untuk mengakses riwayat transaksi.");
  return user;
}

function readFilters(filters: RawFilters) {
  const optional = (value: unknown) => value === "" ? undefined : value;
  const month = optional(filters.month);
  const type = optional(filters.type);
  const walletId = optional(filters.wallet_id);
  const category = optional(filters.category);
  const recorder = optional(filters.recorder);
  const search = optional(filters.search);
  const beforeAt = optional(filters.before_at);
  const beforeId = optional(filters.before_id);
  if (
    (month !== undefined && !isHistoryMonth(month)) ||
    (type !== undefined && !isHistoryType(type)) ||
    (walletId !== undefined && !isUuid(walletId)) ||
    (category !== undefined && !historyCategories(type).some((name) => name === category)) ||
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
    ...(type && { p_type: type }),
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

export async function getTransactionEditor(request: Request, transactionId: string): Promise<TransactionEditorContext> {
  const workspaceId = new URL(request.url).searchParams.get("workspace_id");
  if (!isUuid(workspaceId) || !isUuid(transactionId)) throw new HistoryError(400, invalidInput);

  const user = await verifySession();
  const [supabase, state] = await Promise.all([createClient(), getWorkspaceState()]);
  const workspaces = state.household ? [state.personal, state.household] : [state.personal];
  const source = workspaceId.toLowerCase();
  const notFound = "Transaksi tidak ditemukan atau tidak dapat diubah.";
  if (!workspaces.some(({ id }) => id === source)) throw new HistoryError(404, notFound);

  const [transaction, wallets] = await Promise.all([
    supabase.from("transactions").select("wallet_id").eq("id", transactionId).eq("workspace_id", source).eq("created_by", user.id).maybeSingle(),
    supabase.from("wallets").select("id,name,type,archived_at,workspace_id").in("workspace_id", workspaces.map(({ id }) => id))
      .order("name").order("id"),
  ]);
  if (transaction.error || wallets.error) throw new HistoryError(503, unavailable);
  if (!transaction.data) throw new HistoryError(404, notFound);
  const walletId: unknown = transaction.data.wallet_id;
  if (!isUuid(walletId)) throw new HistoryError(503, unavailable);

  return {
    wallet_id: walletId,
    workspaces: workspaces.map(({ id, type }) => ({
      id,
      type,
      wallets: (wallets.data ?? []).flatMap((wallet) => {
        if (wallet.workspace_id !== id || (wallet.archived_at !== null && wallet.id !== walletId)) return [];
        const walletType = WALLET_TYPES.find((choice) => choice === wallet.type);
        if (!isUuid(wallet.id) || typeof wallet.name !== "string" || !walletType) throw new HistoryError(503, unavailable);
        return [{ id: wallet.id, name: wallet.name, type: walletType }];
      }),
    })),
  };
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

function readEdit(data: Record<string, unknown>) {
  const { item, amount, occurred_at } = data;
  const flow = readCashFlow(data);
  if (
    typeof item !== "string" || !item.trim() || item.includes("\0") || !isAmount(amount) ||
    !isTimestamp(occurred_at) || !flow
  ) {
    throw new HistoryError(400, invalidInput);
  }
  return {
    item: item.trim(), amount, occurred_at, ...flow,
  };
}

function readUpdate(data: Record<string, unknown>) {
  const { wallet_id } = data;
  if (!isUuid(wallet_id)) throw new HistoryError(400, invalidInput);
  const { item, amount, type, category, occurred_at } = readEdit(data);
  return { p_item: item, p_amount: amount, p_type: type, p_category: category, p_wallet_id: wallet_id, p_occurred_at: occurred_at };
}

async function moveHistoryTransaction(data: Record<string, unknown>, transactionId: string, workspaceId: string) {
  const { target_workspace_id, target_wallet_id, operation_id } = data;
  if (
    !isUuid(target_workspace_id) || target_workspace_id.toLowerCase() === workspaceId ||
    (target_wallet_id != null && !isUuid(target_wallet_id)) || (operation_id != null && !isUuid(operation_id))
  ) {
    throw new HistoryError(400, invalidInput);
  }
  const editFields = ["item", "amount", "occurred_at", "type", "category"];
  const edit = editFields.some((field) => Object.hasOwn(data, field)) ? readEdit(data) : undefined;
  const result = await moveTransaction({
    channel: "pwa",
    transactionId,
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: target_workspace_id,
    targetWalletId: target_wallet_id ?? undefined,
    operationId: operation_id ?? undefined,
    edit,
  }).catch(() => { throw new HistoryError(503, "Transaksi belum dapat dipindahkan. Coba lagi."); });

  switch (result.status) {
    case "moved":
    case "already_moved":
      return result.transaction.workspace_type;
    case "not_found":
      throw new HistoryError(404, "Transaksi tidak ditemukan atau tidak dapat dipindahkan ke ruang itu.");
    case "invalid_wallet":
      throw new HistoryError(400, "Pilih dompet aktif di ruang tujuan.");
    case "invalid_input":
      throw new HistoryError(400, invalidInput);
    case "conflict":
      throw new HistoryError(409, "Transaksi sudah berubah. Muat ulang halaman sebelum mencoba lagi.");
  }
}

async function mutateWithinWorkspace(data: Record<string, unknown>, args: { p_workspace_id: string; p_transaction_id: string }, action: "update" | "delete") {
  const supabase = await createClient();
  const result = action === "update"
    ? await supabase.rpc("update_history_transaction", { ...args, ...readUpdate(data) })
    : await supabase.rpc("delete_history_transaction", args);

  if (result.error) throw new HistoryError(503, unavailable);
  if (result.data === "not_found") throw new HistoryError(404, "Transaksi tidak ditemukan atau tidak dapat diubah.");
  if (result.data === "invalid_wallet") throw new HistoryError(400, "Dompet transaksi tidak valid.");
  if (result.data === "invalid_input") throw new HistoryError(400, invalidInput);
  if (result.data !== (action === "update" ? "updated" : "deleted")) throw new HistoryError(503, unavailable);
}

export async function changeHistoryTransaction(request: Request, transactionId: string, action: "update" | "delete"): Promise<MutationResponse> {
  if (!isUuid(transactionId)) throw new HistoryError(400, invalidInput);
  const { data, workspaceId } = await readMutation(request);
  const args = { p_workspace_id: workspaceId, p_transaction_id: transactionId.toLowerCase() };
  let movedTo: WorkspaceType | undefined;
  if (action === "update" && Object.hasOwn(data, "target_workspace_id")) {
    movedTo = await moveHistoryTransaction(data, args.p_transaction_id, workspaceId);
  } else {
    await mutateWithinWorkspace(data, args, action);
  }

  revalidatePath("/");
  revalidatePath("/riwayat");
  revalidatePath("/laporan");
  return { ok: true, ...(movedTo && { moved_to: movedTo }) };
}
