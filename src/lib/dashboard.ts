import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/workspaces";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  type DashboardSummary,
  type DashboardTransaction,
  type Rupiah,
} from "@/types/database";

const unreadableSummary = "Data beranda tidak dapat dibaca.";
const latestTransactionLimit = 5;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRupiah(value: unknown): value is Rupiah {
  return typeof value === "string" && value === value.trim() && /^(?:0|-?[1-9][0-9]*)$/.test(value);
}

function isNonnegativeRupiah(value: unknown): value is Rupiah {
  return isRupiah(value) && !value.startsWith("-");
}

function validCategory<T extends string>(value: unknown, categories: readonly T[]): value is T {
  return categories.some((category) => category === value);
}

function readTransaction(value: unknown): DashboardTransaction {
  if (!isObject(value)) throw new Error(unreadableSummary);

  const { id, item, amount, type, category, occurred_at, recorded_by, wallet_name } = value;
  if (
    !isUuid(id) ||
    typeof item !== "string" ||
    !item.trim() ||
    !isNonnegativeRupiah(amount) ||
    amount === "0" ||
    typeof occurred_at !== "string" ||
    occurred_at !== occurred_at.trim() ||
    !timestampPattern.test(occurred_at) ||
    !Number.isFinite(Date.parse(occurred_at)) ||
    (recorded_by !== "self" && recorded_by !== "partner") ||
    typeof wallet_name !== "string" ||
    !wallet_name.trim()
  ) {
    throw new Error(unreadableSummary);
  }

  const transaction = { id, item, amount, occurred_at, recorded_by, wallet_name } as const;
  if (type === "income" && validCategory(category, INCOME_CATEGORIES)) {
    return { ...transaction, type, category };
  }
  if (type === "expense" && validCategory(category, EXPENSE_CATEGORIES)) {
    return { ...transaction, type, category };
  }
  throw new Error(unreadableSummary);
}

function readSummary(value: unknown, workspaceId: string): DashboardSummary {
  if (!isObject(value)) throw new Error(unreadableSummary);

  const { workspace_id, total_balance, total_income, total_expense, transactions } = value;
  if (
    workspace_id !== workspaceId ||
    !isRupiah(total_balance) ||
    !isNonnegativeRupiah(total_income) ||
    !isNonnegativeRupiah(total_expense) ||
    !Array.isArray(transactions) ||
    transactions.length > latestTransactionLimit
  ) {
    throw new Error(unreadableSummary);
  }

  const recent = transactions.map(readTransaction);
  const idSet = new Set<string>();
  let mostRecentAt = Infinity;
  for (const transaction of recent) {
    const id = transaction.id.toLowerCase();
    const occurredAt = Date.parse(transaction.occurred_at);
    if (idSet.has(id) || occurredAt > mostRecentAt) {
      throw new Error(unreadableSummary);
    }
    idSet.add(id);
    mostRecentAt = occurredAt;
  }

  return {
    workspace_id,
    total_balance,
    total_income,
    total_expense,
    transactions: recent,
  };
}

export async function getDashboardSummary(workspaceId: string): Promise<DashboardSummary> {
  if (!isUuid(workspaceId)) throw new Error(unreadableSummary);

  const normalizedId = workspaceId.toLowerCase();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_dashboard_summary", { p_workspace_id: normalizedId });
  if (error) throw new Error(unreadableSummary);

  return readSummary(data, normalizedId);
}
