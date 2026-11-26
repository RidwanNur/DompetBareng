export { formatMonth as formatTelegramReportMonth } from "@/lib/format";

const jakartaMonth = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
});

const monthNames = [
  ["januari", "january", "jan"],
  ["februari", "february", "feb"],
  ["maret", "march", "mar"],
  ["april", "apr"],
  ["mei", "may"],
  ["juni", "june", "jun"],
  ["juli", "july", "jul"],
  ["agustus", "august", "agu", "ags", "aug"],
  ["september", "sep", "sept"],
  ["oktober", "october", "okt", "oct"],
  ["november", "nov"],
  ["desember", "december", "des", "dec"],
];

export function isTelegramReportMonth(value: unknown): value is string {
  return typeof value === "string" && value.length === 7 && /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(value);
}

function monthKey(year: number, month: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1 || year > 9999 || month < 1 || month > 12) {
    return null;
  }
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
}

export function shiftTelegramReportMonth(month: string, offset: -1 | 1): string | null {
  if (!isTelegramReportMonth(month)) return null;
  const [year, number] = month.split("-").map(Number);
  const shifted = number + offset;
  if (shifted === 0) return monthKey(year - 1, 12);
  if (shifted === 13) return monthKey(year + 1, 1);
  return monthKey(year, shifted);
}

export function parseTelegramReportMonth(argument: string, now = new Date()): string | null {
  const value = argument.trim().toLowerCase().replace(/\s+/g, " ");
  const parts = jakartaMonth.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const current = monthKey(year, month);
  if (value === "" || value === "bulan ini" || value === "this month") return current;

  if (value === "bulan lalu" || value === "bulan sebelumnya" || value === "last month" || value === "previous month") {
    return current ? shiftTelegramReportMonth(current, -1) : null;
  }

  if (isTelegramReportMonth(value)) return value;
  if (/^[0-9]{1,2}$/.test(value)) return monthKey(year, Number(value));
  const yearFirst = /^([0-9]{4})[-/]([0-9]{1,2})$/.exec(value);
  if (yearFirst) return monthKey(Number(yearFirst[1]), Number(yearFirst[2]));
  const monthFirst = /^([0-9]{1,2})[-/]([0-9]{4})$/.exec(value);
  if (monthFirst) return monthKey(Number(monthFirst[2]), Number(monthFirst[1]));

  const named = /^([a-z]+)\.?(?: ([0-9]{4}))?$/.exec(value);
  if (!named) return null;
  const index = monthNames.findIndex((names) => names.includes(named[1]));
  return monthKey(named[2] ? Number(named[2]) : year, index + 1);
}
