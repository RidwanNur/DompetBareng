const jakartaDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
});

const months = [
  ["jan", "januari"], ["feb", "februari"], ["mar", "maret"], ["apr", "april"], ["mei"], ["jun", "juni"],
  ["jul", "juli"], ["agu", "ags", "agustus"], ["sep", "sept", "september"], ["okt", "oktober"],
  ["nov", "november"], ["des", "desember"],
];
const monthNames = months.flat().sort((a, b) => b.length - a.length).join("|");

const dateToken = new RegExp([
  String.raw`(?<![\p{L}\p{N}/-])(?:(?:tgl\.?|tanggal)\s+)?(?:`,
  String.raw`(?<iso>\d{4}-\d{1,2}-\d{1,2})`,
  String.raw`|(?<full>\d{1,2}(?<separator>[/\-])\d{1,2}\k<separator>\d{4})`,
  String.raw`|(?<short>\d{1,2}/\d{1,2})(?!\s*(?:kg|gram|ons|liter|ml)\b)`,
  String.raw`|(?<day>\d{1,2})\s+(?<month>${monthNames})\.?(?:\s+(?<year>\d{4}))?`,
  String.raw`|(?<yesterday>kemarin)|(?<days>\d{1,5})\s+hari\s+(?:yang\s+)?lalu|(?<today>hari\s+ini)`,
  String.raw`)(?![\p{L}\p{N}/-])`,
].join(""), "giu");

export function isTransactionDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function currentTransactionDate(now = new Date()) {
  const parts = jakartaDate.formatToParts(Number.isFinite(now.getTime()) ? now : new Date());
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value.padStart(type === "year" ? 4 : 2, "0")).join("-");
}

function calendarDate(year: string, month: string, day: string) {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isTransactionDate(value) ? value : undefined;
}

function resolveDate(groups: Record<string, string | undefined>, referenceDate: string) {
  const currentYear = referenceDate.slice(0, 4);
  if (groups.iso) {
    const [year, month, day] = groups.iso.split("-");
    return calendarDate(year, month, day);
  }
  if (groups.full || groups.short) {
    const [day, month, year = currentYear] = (groups.full ?? groups.short ?? "").split(/[/\-]/);
    return calendarDate(year, month, day);
  }
  if (groups.day && groups.month) {
    const month = months.findIndex((names) => names.includes(groups.month?.toLowerCase() ?? "")) + 1;
    return calendarDate(groups.year ?? currentYear, String(month), groups.day);
  }

  const offset = groups.yesterday ? 1 : Number(groups.days ?? 0);
  const date = new Date(referenceDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - offset);
  const value = date.toISOString().slice(0, 10);
  return isTransactionDate(value) ? value : undefined;
}

export function readExplicitTransactionDates(text: string | undefined, referenceDate: string): string[] {
  if (!text) return [];
  const baseline = isTransactionDate(referenceDate) ? referenceDate : currentTransactionDate();
  return [...new Set([...text.matchAll(dateToken)].map(({ groups }) => resolveDate(groups ?? {}, baseline) ?? baseline))];
}

export function stripTransactionDates(text: string) {
  const withoutDates = text.replace(dateToken, " ");
  if (withoutDates === text) return text.trim();
  return withoutDates.replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ").replace(/^[\s,;:–—·-]+|[\s,;:–—·-]+$/g, "");
}
