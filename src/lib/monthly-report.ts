import "server-only";

import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { generateMonthlyAnalysis, readMonthlyAnalysis } from "@/lib/gemini";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type MonthlyReport, type Rupiah } from "@/types/database";

class ReportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type ReportClient = Awaited<ReturnType<typeof createClient>>;

const unavailable = "Laporan bulanan belum dapat diproses. Coba lagi.";
const unavailableAnalysis = "Ringkasan AI belum dapat dibuat. Coba lagi.";
const denied = "Anda tidak tergabung dalam ruang ini.";
const jakartaMonth = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" });

export function getCurrentJakartaMonth(now = new Date()) {
  const parts = jakartaMonth.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

export function monthlyReportResponse(body: { report: MonthlyReport; busy?: true } | { error: string }, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function monthlyReportFailure(error: unknown) {
  return error instanceof ReportError
    ? monthlyReportResponse({ error: error.message }, error.status)
    : monthlyReportResponse({ error: unavailable }, 503);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportTarget(workspaceId: unknown, month: unknown) {
  if (!isUuid(workspaceId)) throw new ReportError(400, "Ruang laporan tidak valid.");
  if (typeof month !== "string" || month.length !== 7 || !/^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new ReportError(400, "Bulan laporan tidak valid.");
  }
  return { p_workspace_id: workspaceId.toLowerCase(), p_month: month };
}

function readMoney(value: unknown, signed = false): Rupiah {
  const pattern = signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/;
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value)) {
    throw new ReportError(503, unavailable);
  }
  return value as Rupiah;
}

function readCategory(value: unknown): MonthlyReport["category_totals"][number] {
  if (!isRecord(value)) throw new ReportError(503, unavailable);
  const total = readMoney(value.total);
  if (value.type === "income") {
    const category = INCOME_CATEGORIES.find((entry) => entry === value.category);
    if (category) return { type: "income", category, total };
  }
  if (value.type === "expense") {
    const category = EXPENSE_CATEGORIES.find((entry) => entry === value.category);
    if (category) return { type: "expense", category, total };
  }
  throw new ReportError(503, unavailable);
}

function readLargestExpense(value: unknown): MonthlyReport["largest_expense"] {
  if (value === null) return null;
  if (!isRecord(value)) throw new ReportError(503, unavailable);
  const category = EXPENSE_CATEGORIES.find((entry) => entry === value.category);
  if (!category) throw new ReportError(503, unavailable);
  return { category, total: readMoney(value.total) };
}

function readWallet(value: unknown): MonthlyReport["wallet_balances"][number] {
  if (!isRecord(value) || !isUuid(value.wallet_id) || typeof value.wallet_name !== "string" || !value.wallet_name.trim()) {
    throw new ReportError(503, unavailable);
  }
  return { wallet_id: value.wallet_id, wallet_name: value.wallet_name, balance: readMoney(value.balance, true) };
}

function readReport(value: unknown, target: ReturnType<typeof reportTarget>): MonthlyReport {
  if (value === null) throw new ReportError(403, denied);
  if (!isRecord(value) || value.workspace_id !== target.p_workspace_id || value.month !== target.p_month) {
    throw new ReportError(503, unavailable);
  }

  const { transaction_count, expense_ratio_percent, health_status, category_totals, wallet_balances, analysis_stale } = value;
  if (
    typeof transaction_count !== "number" || !Number.isSafeInteger(transaction_count) || transaction_count < 0 ||
    (expense_ratio_percent !== null && (
      typeof expense_ratio_percent !== "string" || expense_ratio_percent !== expense_ratio_percent.trim() ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(expense_ratio_percent)
    )) ||
    (health_status !== "Sehat" && health_status !== "Waspada" && health_status !== "Defisit" && health_status !== "Belum Ada Data") ||
    !Array.isArray(category_totals) || !Array.isArray(wallet_balances) || typeof analysis_stale !== "boolean"
  ) {
    throw new ReportError(503, unavailable);
  }

  return {
    workspace_id: target.p_workspace_id,
    month: target.p_month,
    transaction_count,
    total_income: readMoney(value.total_income),
    total_expense: readMoney(value.total_expense),
    net_cash_flow: readMoney(value.net_cash_flow, true),
    expense_ratio_percent,
    health_status,
    largest_expense: readLargestExpense(value.largest_expense),
    category_totals: category_totals.map(readCategory),
    wallet_balances: wallet_balances.map(readWallet),
    analysis: value.analysis === null ? null : readMonthlyAnalysis(value.analysis),
    analysis_stale,
  };
}

async function queryReport(supabase: ReportClient, target: ReturnType<typeof reportTarget>) {
  const { data, error } = await supabase.rpc("get_monthly_report", target);
  if (error) throw new ReportError(503, unavailable);
  return readReport(data, target);
}

export async function getMonthlyReport(workspaceId: string, month: string): Promise<MonthlyReport> {
  const target = reportTarget(workspaceId, month);
  return queryReport(await createClient(), target);
}

async function requireSession() {
  if (!isSupabaseConfigured()) throw new ReportError(503, unavailable);
  if (!(await getCurrentUser())) throw new ReportError(401, "Masuk untuk melihat laporan bulanan.");
}

export async function getMonthlyReportFromRequest(request: Request) {
  await requireSession();
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspace_id") ?? (await getWorkspaceState()).active_workspace_id;
  return getMonthlyReport(workspaceId, params.get("month") ?? getCurrentJakartaMonth());
}

async function readAnalysisRequest(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    site === "cross-site" || site === "same-site" ||
    (origin !== null && origin !== new URL(request.url).origin && origin !== (await getAppOrigin()))
  ) {
    throw new ReportError(403, "Permintaan dari luar DompetBareng ditolak.");
  }
  await requireSession();

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new ReportError(415, "Kirim permintaan dalam format JSON.");
  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.manual !== "boolean") {
    throw new ReportError(400, "Permintaan ringkasan AI tidak valid.");
  }
  return { target: reportTarget(body.workspace_id, body.month), manual: body.manual };
}

export async function requestMonthlyAnalysis(request: Request): Promise<{ report: MonthlyReport; busy?: true }> {
  const { target, manual } = await readAnalysisRequest(request);
  const supabase = await createClient();
  const { data: claim, error } = await supabase.rpc("begin_monthly_analysis", { ...target, p_manual: manual });
  if (error || !isRecord(claim)) throw new ReportError(503, unavailableAnalysis);

  switch (claim.status) {
    case "forbidden":
      throw new ReportError(403, denied);
    case "rate_limited":
      throw new ReportError(429, "Batas pembaruan ringkasan AI hari ini sudah tercapai.");
    case "cached":
    case "empty":
      return { report: await queryReport(supabase, target) };
    case "busy":
      return { report: await queryReport(supabase, target), busy: true };
    case "ready":
      break;
    default:
      throw new ReportError(503, unavailableAnalysis);
  }
  if (!isUuid(claim.claim_token)) throw new ReportError(503, unavailableAnalysis);

  const args = { ...target, p_claim_token: claim.claim_token };
  const admin = createAdminClient();
  let finished = false;
  try {
    const report = readReport(claim.report, target);
    if (!report.transaction_count || (report.total_income === "0" && report.total_expense === "0")) {
      return { report };
    }

    const analysis = await generateMonthlyAnalysis(report);
    const completed = await admin.rpc("complete_monthly_analysis", { ...args, p_analysis: analysis });
    if (completed.error || completed.data !== true) {
      throw new ReportError(503, unavailableAnalysis);
    }
    finished = true;
  } catch {
    throw new ReportError(503, unavailableAnalysis);
  } finally {
    if (!finished) {
      try {
        await admin.rpc("release_monthly_analysis", args);
      } catch {
        // The database releases the expired claim if the provider is unavailable.
      }
    }
  }

  return { report: await queryReport(supabase, target) };
}
