/** Bilangan bulat Rupiah yang diserialisasi sebagai teks agar presisi BIGINT terjaga. */
export type Rupiah = `${bigint}`;

export type WorkspaceType = "personal" | "household";
export const WALLET_TYPES = ["cash", "bank", "ewallet"] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export interface Workspace {
  id: string;
  type: WorkspaceType;
  name: string;
}

export interface WorkspaceState {
  personal: Workspace & { type: "personal" };
  household: (Workspace & {
    type: "household";
    is_owner: boolean;
    member_count: number;
  }) | null;
  active_workspace_id: string;
  invitation: { code: string; expires_at: string } | null;
}

export type WorkspaceAction =
  | { action: "select"; workspace_id: string }
  | { action: "create_invite" }
  | { action: "join"; code: string };

export interface Wallet {
  id: string;
  workspace_id: string;
  type: WalletType;
  name: string;
}

export type ManagedWallet = Pick<Wallet, "id" | "name" | "type"> & {
  balance: Rupiah;
  opening_balance: Rupiah;
  archived: boolean;
};

export interface WalletOverview {
  workspace_id: string;
  wallets: ManagedWallet[];
}

export type WalletAction =
  | { action: "create"; name: string; type: WalletType }
  | { action: "update"; wallet_id: string; name: string; type: WalletType }
  | { action: "adjust"; wallet_id: string; opening_balance: string }
  | { action: "transfer"; from_wallet_id: string; to_wallet_id: string; amount: string }
  | { action: "delete"; wallet_id: string };

export type WalletMutationOutcome = "created" | "updated" | "adjusted" | "transferred" | "deleted" | "archived";

export const INCOME_CATEGORIES = [
  "Gaji",
  "Bonus & Tunjangan",
  "Usaha / Sampingan",
  "Hadiah / Transfer Masuk",
  "Lainnya",
] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const EXPENSE_CATEGORIES = [
  "Makan & Minum",
  "Belanja Harian",
  "Transportasi",
  "Tagihan & Utilitas",
  "Rumah Tangga",
  "Kesehatan",
  "Hiburan & Gaya Hidup",
  "Pendidikan",
  "Sosial & Hadiah",
  "Lainnya",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

interface TransactionDetails {
  id: string;
  workspace_id: string;
  wallet_id: string;
  created_by: string;
  amount: Rupiah;
  occurred_at: string;
  item: string;
  raw_input: string | null;
}

type CashFlow =
  | { type: "income"; category: IncomeCategory }
  | { type: "expense"; category: ExpenseCategory };

export type Transaction = TransactionDetails & CashFlow;

export type TransactionDraft = Pick<TransactionDetails, "item" | "amount"> &
  CashFlow & { wallet_type: WalletType };

export type DashboardTransaction = Pick<TransactionDetails, "id" | "item" | "amount" | "occurred_at"> &
  CashFlow & { recorded_by: "self" | "partner"; wallet_name: string };

export interface DashboardSummary {
  workspace_id: string;
  total_balance: Rupiah;
  total_income: Rupiah;
  total_expense: Rupiah;
  transactions: DashboardTransaction[];
}

export type HistoryTransaction = DashboardTransaction & Pick<TransactionDetails, "wallet_id">;

export type TransactionEditorContext = {
  wallet_id: string;
  workspaces: { id: string; type: WorkspaceType; wallets: Pick<Wallet, "id" | "name" | "type">[] }[];
};

export type TransactionHistoryFilters = {
  month?: string;
  wallet_id?: string;
  category?: IncomeCategory | ExpenseCategory;
  recorder?: HistoryTransaction["recorded_by"];
  search?: string;
  before_at?: string;
  before_id?: string;
};

export interface TransactionHistory {
  workspace_id: string;
  wallets: Pick<Wallet, "id" | "name">[];
  transactions: HistoryTransaction[];
  next_cursor: Pick<HistoryTransaction, "occurred_at" | "id"> | null;
}

export type FinancialHealthStatus = "Sehat" | "Waspada" | "Defisit" | "Belum Ada Data";

export interface MonthlyAnalysis {
  narrative: string;
  suggestions: string[];
}

export interface MonthlyReport {
  workspace_id: string;
  month: string;
  transaction_count: number;
  total_income: Rupiah;
  total_expense: Rupiah;
  net_cash_flow: Rupiah;
  expense_ratio_percent: string | null;
  health_status: FinancialHealthStatus;
  largest_expense: { category: ExpenseCategory; total: Rupiah } | null;
  category_totals: (CashFlow & { total: Rupiah })[];
  wallet_balances: { wallet_id: string; wallet_name: string; balance: Rupiah }[];
  analysis: MonthlyAnalysis | null;
  analysis_stale: boolean;
}
