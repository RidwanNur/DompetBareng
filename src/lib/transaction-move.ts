import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/workspaces";
import type { Rupiah, Transaction, WorkspaceType } from "@/types/database";

type TransactionEdit = Pick<Transaction, "item" | "amount" | "type" | "category" | "occurred_at">;

type MoveRequest = { transactionId: string; operationId?: string } & (
  | { channel: "pwa"; sourceWorkspaceId: string; targetWorkspaceId: string; targetWalletId?: string; edit?: TransactionEdit }
  | { channel: "telegram"; telegramUserId: number; targetWorkspaceType: WorkspaceType; operationId: string }
);

type MovedTransaction = Pick<Transaction, "id" | "item" | "amount" | "workspace_id" | "wallet_id"> & {
  category: string;
  workspace_type: WorkspaceType;
  workspace_name: string;
  wallet_name: string;
  can_move: boolean;
};

type MoveResult =
  | { status: "moved" | "already_moved"; transaction: MovedTransaction }
  | { status: "not_found" | "invalid_wallet" | "invalid_input" | "conflict" };

const unavailable = "Transaksi belum dapat dipindahkan. Coba lagi.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMovedTransaction(value: unknown): MovedTransaction {
  if (!isRecord(value)) throw new Error(unavailable);
  const { id, item, amount, category, workspace_id, workspace_type, workspace_name, wallet_id, wallet_name, can_move } = value;
  if (
    !isUuid(id) || !isUuid(workspace_id) || !isUuid(wallet_id) ||
    typeof item !== "string" || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount) ||
    typeof category !== "string" || (workspace_type !== "personal" && workspace_type !== "household") ||
    typeof workspace_name !== "string" || typeof wallet_name !== "string" || typeof can_move !== "boolean"
  ) {
    throw new Error(unavailable);
  }

  return { id, item, amount: amount as Rupiah, category, workspace_id, workspace_type, workspace_name, wallet_id, wallet_name, can_move };
}

export async function moveTransaction(request: MoveRequest): Promise<MoveResult> {
  const common = { p_transaction_id: request.transactionId, p_operation_id: request.operationId ?? null };
  const result = request.channel === "telegram"
    ? await createAdminClient().rpc("move_telegram_transaction", {
      ...common,
      p_telegram_user_id: request.telegramUserId,
      p_target_workspace_type: request.targetWorkspaceType,
    })
    : await (await createClient()).rpc("move_transaction", {
      ...common,
      p_source_workspace_id: request.sourceWorkspaceId,
      p_target_workspace_id: request.targetWorkspaceId,
      p_target_wallet_id: request.targetWalletId ?? null,
      p_edit: request.edit ?? null,
    });

  if (result.error || !isRecord(result.data)) throw new Error(unavailable);
  const { status, transaction } = result.data;
  switch (status) {
    case "moved":
    case "already_moved":
      return { status, transaction: readMovedTransaction(transaction) };
    case "not_found":
    case "invalid_wallet":
    case "invalid_input":
    case "conflict":
      return { status };
    default:
      throw new Error(unavailable);
  }
}
