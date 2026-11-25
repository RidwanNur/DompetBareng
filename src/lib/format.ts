import type { Rupiah } from "@/types/database";

const rupiahFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "long",
  timeZone: "Asia/Jakarta",
});

const dateTimeFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

const monthFormatter = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

export function formatRupiah(amount: Rupiah | bigint | number) {
  return rupiahFormatter.format(typeof amount === "string" ? BigInt(amount) : amount);
}

export function formatDate(date: Date | string | number) {
  return dateFormatter.format(date instanceof Date ? date : new Date(date));
}

export function formatDateTime(date: string) {
  return dateTimeFormatter.format(new Date(date));
}

export function formatMonth(month: string) {
  return monthFormatter.format(new Date(month + "-01T00:00:00+07:00"));
}
