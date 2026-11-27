import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/workspaces";
import type { Rupiah, TransactionDraft, WorkspaceType } from "@/types/database";

type TelegramInput = {
  userId: number;
  messageId: number;
  updateId?: number;
  replyToPromptId?: number;
  workspaceType?: WorkspaceType;
};

type InputClaim =
  | { status: "ready"; claim_token: string; existing?: TransactionDraft }
  | { status: "unlinked" | "duplicate" | "busy" | "rate_limited" | "not_found" | "workspace_unavailable" };

export type TransactionReceipt = {
  id: string;
  item: string;
  amount: Rupiah;
  category: string;
  workspace_id: string;
  workspace_name: string;
  workspace_type: WorkspaceType;
  wallet_id: string;
  wallet_name: string;
  can_move: boolean;
};

type InputResult = {
  status: "saved" | "edited" | "empty" | "obsolete" | "not_found";
  transactions: TransactionReceipt[];
};

function inputKey({ userId, messageId }: TelegramInput) {
  return { p_telegram_user_id: userId, p_telegram_message_id: messageId };
}

export async function beginTelegramInput(input: TelegramInput, dailyLimit: number): Promise<InputClaim> {
  const { data, error } = await createAdminClient().rpc("begin_telegram_input_in_workspace", {
    ...inputKey(input),
    p_reply_to_message_id: input.replyToPromptId ?? null,
    p_workspace_type: input.workspaceType ?? null,
    p_daily_limit: dailyLimit,
    p_update_id: input.updateId ?? null,
  });
  if (error) throw new Error("Pesan Telegram belum bisa diproses.");
  if (data?.status === "ready" && typeof data.claim_token === "string") {
    return { status: "ready", claim_token: data.claim_token, existing: data.existing ?? undefined };
  }
  if (["unlinked", "duplicate", "busy", "rate_limited", "not_found", "workspace_unavailable"].includes(data?.status)) return data;
  throw new Error("Status pesan Telegram tidak valid.");
}

function isReceipt(value: unknown): value is TransactionReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    isUuid(receipt.id) &&
    typeof receipt.item === "string" &&
    typeof receipt.amount === "string" && /^[1-9][0-9]*$/.test(receipt.amount) &&
    typeof receipt.category === "string" &&
    isUuid(receipt.workspace_id) &&
    typeof receipt.workspace_name === "string" &&
    (receipt.workspace_type === "personal" || receipt.workspace_type === "household") &&
    isUuid(receipt.wallet_id) &&
    typeof receipt.wallet_name === "string" &&
    typeof receipt.can_move === "boolean"
  );
}

export async function finishTelegramInput(
  input: TelegramInput,
  claimToken: string,
  transactions: TransactionDraft[],
  rawInput: string | null,
  occurredAt: string,
): Promise<InputResult> {
  const { data, error } = await createAdminClient().rpc("finish_telegram_input", {
    ...inputKey(input),
    p_claim_token: claimToken,
    p_transactions: transactions,
    p_raw_input: rawInput,
    p_occurred_at: occurredAt,
  });
  if (
    error ||
    !["saved", "edited", "empty", "obsolete", "not_found"].includes(data?.status) ||
    !Array.isArray(data.transactions) ||
    !data.transactions.every(isReceipt)
  ) {
    throw new Error("Transaksi Telegram belum bisa disimpan.");
  }
  return data;
}

export async function getTelegramTransactionReceipts(userId: number, transactionIds: string[]): Promise<TransactionReceipt[]> {
  const { data, error } = await createAdminClient().rpc("get_telegram_transaction_receipts", {
    p_telegram_user_id: userId,
    p_transaction_ids: transactionIds,
  });
  if (error || !Array.isArray(data) || !data.every(isReceipt)) {
    throw new Error("Ringkasan transaksi Telegram belum bisa dibaca.");
  }
  return data;
}

export async function getTelegramWorkspaceState(userId: number): Promise<{ active_workspace_type: WorkspaceType; has_household: boolean } | null> {
  const { data, error } = await createAdminClient().rpc("get_telegram_workspace_state", { p_telegram_user_id: userId });
  if (error) throw new Error("Ruang Telegram belum bisa dibaca.");
  if (data === null) return null;
  if (
    (data?.active_workspace_type !== "personal" && data?.active_workspace_type !== "household") ||
    typeof data.has_household !== "boolean"
  ) {
    throw new Error("Status ruang Telegram tidak valid.");
  }
  return { active_workspace_type: data.active_workspace_type, has_household: data.has_household };
}

export async function setTelegramWorkspace(userId: number, workspaceType: WorkspaceType) {
  const { data, error } = await createAdminClient().rpc("set_telegram_workspace", {
    p_telegram_user_id: userId,
    p_workspace_type: workspaceType,
  });
  const outcome = (["ok", "unlinked", "workspace_unavailable"] as const).find((status) => status === data);
  if (error || !outcome) throw new Error("Ruang default Telegram belum bisa diubah.");
  return outcome;
}

export async function releaseTelegramInput(input: TelegramInput, claimToken: string) {
  const { error } = await createAdminClient().rpc("release_telegram_input", {
    ...inputKey(input),
    p_claim_token: claimToken,
  });
  if (error) throw new Error("Klaim pesan Telegram belum bisa dilepas.");
}

export async function getTelegramEditTarget(userId: number, transactionId: string) {
  const { data, error } = await createAdminClient().rpc("get_telegram_edit_target", {
    p_telegram_user_id: userId,
    p_transaction_id: transactionId,
  });
  if (error || (typeof data !== "string" && data !== null)) {
    throw new Error("Transaksi Telegram belum bisa dibaca.");
  }
  return data;
}

export async function saveTelegramEditPrompt(userId: number, promptMessageId: number, transactionId: string) {
  const { data, error } = await createAdminClient().rpc("save_telegram_edit_prompt", {
    p_telegram_user_id: userId,
    p_prompt_message_id: promptMessageId,
    p_transaction_id: transactionId,
  });
  if (error || typeof data !== "boolean") throw new Error("Permintaan koreksi belum bisa disimpan.");
  return data;
}

export async function deleteTelegramTransaction(userId: number, transactionId: string) {
  const { data, error } = await createAdminClient().rpc("delete_telegram_transaction", {
    p_telegram_user_id: userId,
    p_transaction_id: transactionId,
  });
  if (error || typeof data !== "boolean") throw new Error("Transaksi Telegram belum bisa dihapus.");
  return data;
}
