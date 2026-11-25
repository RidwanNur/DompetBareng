import "server-only";

import { revalidatePath } from "next/cache";
import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";
import {
  WALLET_TYPES,
  type ManagedWallet,
  type Rupiah,
  type WalletAction,
  type WalletMutationOutcome,
  type WalletOverview,
} from "@/types/database";

class WalletError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type WalletClient = Awaited<ReturnType<typeof createClient>>;

const unavailable = "Data dompet belum dapat diproses. Coba lagi.";
const invalidInput = "Data dompet tidak valid.";
const denied = "Anda tidak tergabung dalam ruang ini.";
const maxPositive = "9223372036854775807";
const maxNegativeMagnitude = "9223372036854775808";

export function walletResponse(body: { overview: WalletOverview; outcome?: WalletMutationOutcome } | { error: string }, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function walletFailure(error: unknown) {
  return error instanceof WalletError
    ? walletResponse({ error: error.message }, error.status)
    : walletResponse({ error: unavailable }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRupiah(value: unknown): value is Rupiah {
  return typeof value === "string" && value === value.trim() && /^(?:0|-?[1-9][0-9]*)$/.test(value);
}

function isLedgerAmount(value: unknown, signed: boolean): value is Rupiah {
  if (!isRupiah(value)) return false;
  const negative = value.startsWith("-");
  if (!signed && (negative || value === "0")) return false;
  const digits = negative ? value.slice(1) : value;
  const limit = negative ? maxNegativeMagnitude : maxPositive;
  return digits.length < limit.length || (digits.length === limit.length && digits <= limit);
}

function workspaceId(value: unknown) {
  if (!isUuid(value)) throw new WalletError(400, "Ruang dompet tidak valid.");
  return value.toLowerCase();
}

function readWallet(value: unknown): ManagedWallet {
  if (!isRecord(value)) throw new WalletError(503, unavailable);
  const { id, name, balance, opening_balance, archived } = value;
  const type = WALLET_TYPES.find((entry) => entry === value.type);
  if (
    !isUuid(id) || typeof name !== "string" || !name.trim() || !type ||
    !isRupiah(balance) || !isLedgerAmount(opening_balance, true) || typeof archived !== "boolean"
  ) {
    throw new WalletError(503, unavailable);
  }
  return { id, name, type, balance, opening_balance, archived };
}

async function queryOverview(client: WalletClient, workspace: string): Promise<WalletOverview> {
  const { data, error } = await client.rpc("get_wallet_overview", { p_workspace_id: workspace });
  if (error) throw new WalletError(503, unavailable);
  if (data === null) throw new WalletError(403, denied);
  if (!isRecord(data) || data.workspace_id !== workspace || !Array.isArray(data.wallets)) {
    throw new WalletError(503, unavailable);
  }
  return { workspace_id: workspace, wallets: data.wallets.map(readWallet) };
}

export async function getWalletOverview(targetWorkspaceId: string): Promise<WalletOverview> {
  const workspace = workspaceId(targetWorkspaceId);
  return queryOverview(await createClient(), workspace);
}

async function verifySession() {
  if (!isSupabaseConfigured()) throw new WalletError(503, unavailable);
  if (!(await getCurrentUser())) throw new WalletError(401, "Masuk untuk mengelola dompet.");
}

export async function getWalletsFromRequest(request: Request) {
  await verifySession();
  const params = new URL(request.url).searchParams;
  const target = params.get("workspace_id") ?? (await getWorkspaceState()).active_workspace_id;
  return getWalletOverview(target);
}

function readWalletAction(data: Record<string, unknown>): WalletAction {
  const { action, wallet_id, opening_balance, from_wallet_id, to_wallet_id, amount } = data;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const type = WALLET_TYPES.find((entry) => entry === data.type);

  switch (action) {
    case "create":
      if (name && !name.includes("\0") && type) return { action, name, type };
      break;
    case "update":
      if (isUuid(wallet_id) && name && !name.includes("\0") && type) {
        return { action, wallet_id: wallet_id.toLowerCase(), name, type };
      }
      break;
    case "adjust":
      if (isUuid(wallet_id) && isLedgerAmount(opening_balance, true)) {
        return { action, wallet_id: wallet_id.toLowerCase(), opening_balance };
      }
      break;
    case "transfer":
      if (
        isUuid(from_wallet_id) && isUuid(to_wallet_id) && from_wallet_id.toLowerCase() !== to_wallet_id.toLowerCase() &&
        isLedgerAmount(amount, false)
      ) {
        return { action, from_wallet_id: from_wallet_id.toLowerCase(), to_wallet_id: to_wallet_id.toLowerCase(), amount };
      }
      break;
    case "delete":
      if (isUuid(wallet_id)) return { action, wallet_id: wallet_id.toLowerCase() };
      break;
  }
  throw new WalletError(400, invalidInput);
}

function readOutcome(value: unknown): WalletMutationOutcome {
  switch (value) {
    case "created":
    case "updated":
    case "adjusted":
    case "transferred":
    case "deleted":
    case "archived":
      return value;
    case "forbidden":
      throw new WalletError(403, denied);
    case "not_found":
      throw new WalletError(404, "Dompet tidak ditemukan atau tidak dapat diubah.");
    case "invalid_input":
      throw new WalletError(400, invalidInput);
    case "conflict":
      throw new WalletError(409, "Permintaan dompet ini sudah digunakan. Coba lagi.");
    default:
      throw new WalletError(503, unavailable);
  }
}

export async function applyWalletActionFromRequest(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    site === "cross-site" || site === "same-site" ||
    (origin !== null && origin !== new URL(request.url).origin && origin !== (await getAppOrigin()))
  ) {
    throw new WalletError(403, "Permintaan dari luar DompetBareng ditolak.");
  }
  await verifySession();

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new WalletError(415, "Kirim permintaan dalam format JSON.");
  const data: unknown = await request.json().catch(() => null);
  if (!isRecord(data) || !isUuid(data.operation_id)) throw new WalletError(400, invalidInput);

  const workspace = workspaceId(data.workspace_id);
  const action = readWalletAction(data);
  const supabase = await createClient();
  const { data: result, error } = await supabase.rpc("apply_wallet_action", {
    p_workspace_id: workspace,
    p_operation_id: data.operation_id.toLowerCase(),
    p_action: action,
  });
  if (error) throw new WalletError(503, unavailable);
  const outcome = readOutcome(result);

  revalidatePath("/");
  revalidatePath("/ruang");
  revalidatePath("/riwayat");
  revalidatePath("/laporan");
  return { overview: await queryOverview(supabase, workspace), outcome };
}
