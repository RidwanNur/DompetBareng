import "server-only";

import { formatDate, formatRupiah } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { telegramWorkspaceLabels, type TelegramInlineKeyboard } from "@/lib/telegram";
import { formatTelegramReportMonth, shiftTelegramReportMonth } from "@/lib/telegram-report-date";
import type { Rupiah, WorkspaceType } from "@/types/database";

type ReportView = "balance" | "history" | "today" | "monthly";
type ReportQuery = { userId: number; workspaceType?: WorkspaceType } & (
  | { view: "monthly"; month: string }
  | { view: Exclude<ReportView, "monthly"> }
);

type Entry = {
  item: string;
  amount: Rupiah;
  type: "income" | "expense";
  occurredAt: string;
  wallet: string;
  recorder?: string;
};

type TelegramQuickReport = { workspaceType: WorkspaceType } & (
  | { view: "balance"; total: Rupiah; wallets: { name: string; balance: Rupiah }[] }
  | { view: "history"; entries: Entry[] }
  | { view: "today"; date: string; count: number; expense: Rupiah; entries: Entry[] }
  | { view: "monthly"; month: string; income: Rupiah; expense: Rupiah; net: Rupiah; savingsRatio: string | null;
    categories: { name: string; total: Rupiah; percent: string }[];
    members?: { name: string; income: Rupiah; expense: Rupiah }[] }
);

const unreadable = "Ringkasan Telegram belum bisa dibaca.";
const moneyPattern = /^(?:0|-?[1-9][0-9]*)$/;
const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const datePattern = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const maximumMessageLength = 4096;

const shortDate = new Intl.DateTimeFormat("id-ID", {
  day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta",
});
const shortTime = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Jakarta",
});
const groupedInteger = new Intl.NumberFormat("id-ID");

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(unreadable);
  return value as Record<string, unknown>;
}

function readList(value: unknown, limit = Infinity): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(unreadable);
  return value;
}

function readText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(unreadable);
  return value;
}

function readMoney(value: unknown, signed = false): Rupiah {
  const text = readText(value);
  if (!moneyPattern.test(text) || (!signed && text.startsWith("-"))) throw new Error(unreadable);
  return text as Rupiah;
}

function readDecimal(value: unknown): string {
  const text = readText(value);
  if (!decimalPattern.test(text)) throw new Error(unreadable);
  return text;
}

function readEntries(value: unknown, workspaceType: WorkspaceType, expensesOnly: boolean) {
  return readList(value, 5).map((entry): Entry => {
    const row = readObject(entry);
    const { type } = row;
    const occurredAt = readText(row.occurred_at);
    if ((type !== "expense" && (expensesOnly || type !== "income")) || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error(unreadable);
    }
    return {
      item: readText(row.item), amount: readMoney(row.amount), type, occurredAt, wallet: readText(row.wallet_name),
      ...(workspaceType === "household" && { recorder: readText(row.creator_name) }),
    };
  });
}

function readReport(data: Record<string, unknown>, query: ReportQuery): TelegramQuickReport {
  const { workspace_type: workspaceType } = data;
  if ((workspaceType !== "personal" && workspaceType !== "household") || (query.workspaceType && query.workspaceType !== workspaceType)) {
    throw new Error(unreadable);
  }

  switch (query.view) {
    case "balance":
      return { view: query.view, workspaceType, total: readMoney(data.total_balance, true), wallets: readList(data.wallets).map((entry) => {
        const wallet = readObject(entry);
        return { name: readText(wallet.name), balance: readMoney(wallet.balance, true) };
      }) };
    case "history":
      return { view: query.view, workspaceType, entries: readEntries(data.transactions, workspaceType, false) };
    case "today": {
      const { transaction_count: count, date } = data;
      const entries = readEntries(data.transactions, workspaceType, true);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < entries.length ||
        typeof date !== "string" || !datePattern.test(date) || !Number.isFinite(Date.parse(date))) {
        throw new Error(unreadable);
      }
      return { view: query.view, workspaceType, count, date, expense: readMoney(data.total_expense), entries };
    }
    case "monthly": {
      if (data.month !== query.month) throw new Error(unreadable);
      return {
        view: query.view, workspaceType, month: query.month,
        income: readMoney(data.total_income), expense: readMoney(data.total_expense), net: readMoney(data.net_cash_flow, true),
        savingsRatio: data.savings_ratio_percent === null ? null : readDecimal(data.savings_ratio_percent),
        categories: readList(data.top_expenses, 3).map((entry) => {
          const category = readObject(entry);
          return { name: readText(category.category), total: readMoney(category.total), percent: readDecimal(category.percent) };
        }),
        ...(workspaceType === "household" && { members: readList(data.members, 2).map((entry) => {
          const member = readObject(entry);
          return { name: readText(member.name), income: readMoney(member.total_income), expense: readMoney(member.total_expense) };
        }) }),
      };
    }
  }
}

export async function getTelegramQuickReport(query: ReportQuery): Promise<
  { status: "ok"; report: TelegramQuickReport } | { status: "unlinked" | "workspace_unavailable" | "invalid_input" }
> {
  const { data, error } = await createAdminClient().rpc("get_telegram_quick_report", {
    p_telegram_user_id: query.userId,
    p_workspace_type: query.workspaceType ?? null,
    p_view: query.view,
    p_month: query.view === "monthly" ? query.month : null,
  });
  if (error) throw new Error(unreadable);
  const raw = readObject(data);
  switch (raw.status) {
    case "ok":
      return { status: "ok", report: readReport(raw, query) };
    case "unlinked":
    case "workspace_unavailable":
    case "invalid_input":
      return { status: raw.status };
    default:
      throw new Error(unreadable);
  }
}

function money(value: Rupiah | bigint) {
  return formatRupiah(value).replace(/\s/g, "");
}

function percentage(value: string) {
  const negative = value.startsWith("-");
  const [whole, decimal] = (negative ? value.slice(1) : value).split(".");
  return `${negative ? "-" : ""}${groupedInteger.format(BigInt(whole))}${decimal ? "," + decimal : ""}%`;
}

function label(value: string, max: number) {
  const text = value.replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ").trim();
  return text.length <= max ? text : text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

function entryLine(entry: Entry, date: Intl.DateTimeFormat) {
  const amount = entry.type === "income" ? "+" + money(entry.amount) : money(-BigInt(entry.amount));
  const recorder = entry.recorder ? " · " + label(entry.recorder, 48) : "";
  return `${date.format(new Date(entry.occurredAt))} · ${label(entry.item, 140)} · ${amount} · ${label(entry.wallet, 88)}${recorder}`;
}

function balanceMessages(report: Extract<TelegramQuickReport, { view: "balance" }>, workspaceName: string) {
  const heading = `Saldo · ${workspaceName}`;
  const messages = [`${heading}\nTotal saldo ${money(report.total)}\n`];
  if (!report.wallets.length) return [messages[0] + "\nBelum ada dompet aktif."];

  for (const wallet of report.wallets) {
    const line = `${label(wallet.name, 88)} · ${money(wallet.balance)}`;
    const index = messages.length - 1;
    if (messages[index].length + line.length + 1 > maximumMessageLength) messages.push(`${heading} (lanjutan)\n\n${line}`);
    else messages[index] += "\n" + line;
  }
  return messages;
}

function monthKeyboard(month: string, workspaceType: WorkspaceType): TelegramInlineKeyboard {
  const previous = shiftTelegramReportMonth(month, -1);
  const next = shiftTelegramReportMonth(month, 1);
  const other = workspaceType === "personal" ? "household" : "personal";
  const navigation = [
    ...(previous ? [{ text: "◀ Bulan Sebelumnya", callback_data: `quick:monthly:${previous}:${workspaceType}` }] : []),
    ...(next ? [{ text: "Bulan Berikutnya ▶", callback_data: `quick:monthly:${next}:${workspaceType}` }] : []),
  ];
  return [navigation, [{ text: `Lihat ${telegramWorkspaceLabels[other]}`, callback_data: `quick:monthly:${month}:${other}` }]];
}

export function renderTelegramQuickReport(report: TelegramQuickReport): { messages: string[]; keyboard?: TelegramInlineKeyboard } {
  const workspaceName = telegramWorkspaceLabels[report.workspaceType];
  switch (report.view) {
    case "balance":
      return { messages: balanceMessages(report, workspaceName) };
    case "history":
      return { messages: [`5 Riwayat · ${workspaceName}\n\n${report.entries.map((entry) => entryLine(entry, shortDate)).join("\n") || "Belum ada transaksi."}`] };
    case "today": {
      const date = formatDate(report.date + "T00:00:00+07:00");
      const entries = report.entries.map((entry) => entryLine(entry, shortTime));
      const remaining = report.count - entries.length;
      const lines = [`Hari Ini · ${workspaceName}`, date + " WIB", `Total pengeluaran ${money(report.expense)}`, "",
        ...(entries.length ? entries : ["Belum ada pengeluaran hari ini."]),
        ...(remaining ? [`${groupedInteger.format(remaining)} pengeluaran lainnya.`] : []),
      ];
      return { messages: [lines.join("\n")] };
    }
    case "monthly": {
      const lines = [
        `Laporan ${formatTelegramReportMonth(report.month)} · ${workspaceName}`, "",
        `Pemasukan ${money(report.income)}`, `Pengeluaran ${money(report.expense)}`,
        `Selisih bersih ${money(report.net)}`,
        `Rasio tabungan ${report.savingsRatio === null ? "— (belum ada pemasukan)" : percentage(report.savingsRatio)}`,
        "", "Top 3 kategori pengeluaran",
        ...(report.categories.length ? report.categories.map((entry, index) =>
          `${index + 1}. ${label(entry.name, 80)} · ${money(entry.total)} (${percentage(entry.percent)})`) : ["Belum ada pengeluaran."]),
      ];
      if (report.members?.length) {
        lines.push("", "Ringkasan per Anggota", ...report.members.map((member) =>
          `${label(member.name, 48)} · Masuk ${money(member.income)} · Keluar ${money(member.expense)}`));
      }
      return { messages: [lines.join("\n")], keyboard: monthKeyboard(report.month, report.workspaceType) };
    }
  }
}
