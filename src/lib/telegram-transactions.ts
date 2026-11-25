import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Rupiah, TransactionDraft } from "@/types/database";

type TelegramInput = {
  userId: number;
  messageId: number;
  replyToPromptId?: number;
};

type InputClaim =
  | { status: "ready"; claim_token: string; existing?: TransactionDraft }
  | { status: "unlinked" | "duplicate" | "busy" | "rate_limited" | "not_found" };

export type TransactionReceipt = {
  id: string;
  item: string;
  amount: Rupiah;
  category: string;
};

type InputResult = {
  status: "saved" | "edited" | "empty" | "obsolete" | "not_found";
  transactions: TransactionReceipt[];
};

function inputKey({ userId, messageId }: TelegramInput) {
  return { p_telegram_user_id: userId, p_telegram_message_id: messageId };
}

export async function beginTelegramInput(input: TelegramInput): Promise<InputClaim> {
  const { data, error } = await createAdminClient().rpc("begin_telegram_input", {
    ...inputKey(input),
    p_reply_to_message_id: input.replyToPromptId ?? null,
  });
  if (error) throw new Error("Pesan Telegram belum bisa diproses.");
  if (data?.status === "ready" && typeof data.claim_token === "string") {
    return { status: "ready", claim_token: data.claim_token, existing: data.existing ?? undefined };
  }
  if (["unlinked", "duplicate", "busy", "rate_limited", "not_found"].includes(data?.status)) return data;
  throw new Error("Status pesan Telegram tidak valid.");
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
  if (error || !["saved", "edited", "empty", "obsolete", "not_found"].includes(data?.status) || !Array.isArray(data.transactions)) {
    throw new Error("Transaksi Telegram belum bisa disimpan.");
  }
  return data;
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
