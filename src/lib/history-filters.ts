import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type TransactionHistoryFilters } from "@/types/database";

export const historyFilterNames = ["month", "type", "wallet_id", "category", "recorder", "search"] as const;

type HistoryFilterName = (typeof historyFilterNames)[number];
type HistoryTypeFilter = NonNullable<TransactionHistoryFilters["type"]>;

const monthPattern = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/;
const walletIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHistoryMonth(value: unknown): value is string {
  return typeof value === "string" && value.length === 7 && monthPattern.test(value);
}

export function isHistoryType(value: unknown): value is HistoryTypeFilter {
  return value === "income" || value === "expense";
}

export function historyCategories(type?: HistoryTypeFilter) {
  if (type === "income") return INCOME_CATEGORIES;
  if (type === "expense") return EXPENSE_CATEGORIES;
  return [...new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES])];
}

export function readHistoryPageFilters(read: (name: HistoryFilterName) => unknown): TransactionHistoryFilters {
  const month = read("month");
  const type = read("type");
  const wallet = read("wallet_id");
  const recorder = read("recorder");
  const search = read("search");
  const category = read("category");
  const flow = isHistoryType(type) ? type : undefined;

  return {
    month: isHistoryMonth(month) ? month : undefined,
    type: flow,
    wallet_id: typeof wallet === "string" && wallet.length === 36 && walletIdPattern.test(wallet) ? wallet : undefined,
    category: historyCategories(flow).find((name) => name === category),
    recorder: recorder === "self" || recorder === "partner" ? recorder : undefined,
    search: typeof search === "string" && !search.includes("\0") ? search : undefined,
  };
}

export function serializeHistoryFilters(filters: TransactionHistoryFilters) {
  const params = new URLSearchParams();
  for (const name of historyFilterNames) {
    const value = filters[name];
    if (value) params.set(name, value);
  }
  return params;
}
