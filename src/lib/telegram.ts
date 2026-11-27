import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isTelegramReportMonth } from "@/lib/telegram-report-date";
import type { WorkspaceType } from "@/types/database";

const botApiOrigin = "https://api.telegram.org";
const telegramRequestTimeout = 5_000;
const maxImageBytes = 10 * 1024 * 1024;
const supportedImageTypes = ["image/jpeg", "image/png", "image/webp"] as const;

type TelegramImageType = (typeof supportedImageTypes)[number];
type TelegramImage = { fileId: string };
type TelegramMethod = "getFile" | "sendMessage" | "editMessageText" | "answerCallbackQuery" | "setChatMenuButton";

type TelegramButton = {
  text: string;
} & ({ callback_data: string } | { url: string });

export type TelegramInlineKeyboard = readonly (readonly TelegramButton[])[];

type TelegramForceReply = {
  reply_markup: { force_reply: true; input_field_placeholder?: string };
};

export const telegramEditPromptPrefix = "Koreksi transaksi";
export const telegramWorkspaceLabels: Record<WorkspaceType, string> = {
  personal: "Pribadi",
  household: "Rumah Tangga",
};

export class TelegramImageInputError extends Error {}

function sha256(value: string) {
  return createHash("sha256").update(value);
}

export function verifyTelegramWebhook(headers: Headers) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const received = headers.get("X-Telegram-Bot-Api-Secret-Token");

  return Boolean(
    expected &&
      received &&
      timingSafeEqual(sha256(expected).digest(), sha256(received).digest()),
  );
}

export function generateTelegramLinkToken() {
  return randomBytes(32).toString("base64url");
}

export function hashTelegramLinkToken(token: string) {
  return sha256(token).digest("hex");
}

export function getTelegramBotUrl() {
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");

  if (!username || !/^[A-Za-z0-9_]+$/.test(username)) {
    throw new Error("Konfigurasi nama Bot Telegram belum lengkap.");
  }

  const url = new URL("https://t.me");
  url.pathname = username;
  return url.toString();
}

export function getTelegramLinkUrl(token: string) {
  const url = new URL(getTelegramBotUrl());
  url.searchParams.set("start", token);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function privateUserId(from: unknown, chat: unknown) {
  return isRecord(from) && from.is_bot === false && isPositiveInteger(from.id) &&
    isRecord(chat) && chat.type === "private" && chat.id === from.id
    ? from.id
    : null;
}

function readPrivateMessage(update: unknown) {
  if (!isRecord(update) || !isRecord(update.message)) {
    return null;
  }

  const message = update.message;
  const messageId = message.message_id;
  const userId = privateUserId(message.from, message.chat);
  return userId !== null && isPositiveInteger(messageId) ? { message, messageId, userId } : null;
}

export function readTelegramLinkCommand(update: unknown) {
  const envelope = readPrivateMessage(update);
  if (!envelope || typeof envelope.message.text !== "string") {
    return null;
  }

  const token = /^\/start ([A-Za-z0-9_-]{1,64})$/.exec(envelope.message.text)?.[1];
  return token ? { token, messageId: envelope.messageId, userId: envelope.userId } : null;
}

function matchesBotAlias(alias: string | undefined) {
  if (!alias) return true;
  const username = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "").toLowerCase();
  return alias.toLowerCase() === username;
}

export function readTelegramWorkspaceCommand(update: unknown) {
  const envelope = readPrivateMessage(update);
  if (!envelope || typeof envelope.message.text !== "string") return null;

  const command = /^\/(ruang|pribadi|rt)(?:@([A-Za-z0-9_]+))?$/i.exec(envelope.message.text.trim());
  if (!command || !matchesBotAlias(command[2])) return null;

  const name = command[1].toLowerCase();
  const workspaceType: WorkspaceType | null = name === "ruang" ? null : name === "pribadi" ? "personal" : "household";
  return { userId: envelope.userId, workspaceType };
}

const quickCommands = {
  menu: "menu",
  bantuan: "menu",
  saldo: "balance",
  riwayat: "history",
  hariini: "today",
  laporan: "monthly",
} as const;

export type TelegramQuickView = (typeof quickCommands)[keyof typeof quickCommands];

export function readTelegramQuickCommand(update: unknown) {
  const envelope = readPrivateMessage(update);
  if (!envelope || typeof envelope.message.text !== "string") return null;

  const command = /^\/(menu|bantuan|saldo|riwayat|hariini|laporan)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]+))?$/i
    .exec(envelope.message.text.trim());
  if (!command || !matchesBotAlias(command[2])) return null;

  const view = quickCommands[command[1].toLowerCase() as keyof typeof quickCommands];
  const tagged = readTelegramWorkspaceTags(command[3]);
  return {
    userId: envelope.userId,
    view,
    help: command[1].toLowerCase() === "bantuan",
    argument: tagged.text?.trim() ?? "",
    workspaceType: tagged.workspaceType,
    conflicts: tagged.conflicts,
  };
}

const workspaceTag = /(?<![\p{L}\p{N}_#/@])#(pribadi|p|rumahtangga|rt)(?![\p{L}\p{N}_])/giu;

export function readTelegramWorkspaceTags(text: string | undefined) {
  const choices = new Set<WorkspaceType>();
  const withoutTags = text?.replace(workspaceTag, (_tag, label: string) => {
    choices.add(/^p/i.test(label) ? "personal" : "household");
    return "";
  });
  return {
    workspaceType: choices.size === 1 ? choices.values().next().value : undefined,
    conflicts: choices.size > 1,
    text: choices.size ? withoutTags?.replace(/[^\S\r\n]{2,}/g, " ").trim() || undefined : text,
  };
}

const transactionTypeTag = /(?<![\p{L}\p{N}_#/@])#(masuk|pemasukan|in|keluar|pengeluaran|out)(?![\p{L}\p{N}_])/giu;

export function readTelegramTransactionType(text: string | undefined) {
  const directions = new Set<"income" | "expense">();
  let content = text?.replace(transactionTypeTag, (_tag, label: string) => {
    directions.add(/^(masuk|pemasukan|in)$/i.test(label) ? "income" : "expense");
    return "";
  }).trim() ?? "";
  const command = /^\/(?:masuk|pemasukan)(?:@([A-Za-z0-9_]+))?(?=\s|$)/i.exec(content);
  const incomeCommand = command !== null && matchesBotAlias(command[1]);
  if (incomeCommand) {
    directions.add("income");
    content = content.slice(command[0].length).trimStart();
  }
  if (content.startsWith("+")) {
    directions.add("income");
    content = content.slice(1).trimStart();
  }
  return {
    text: content.replace(/[^\S\r\n]{2,}/g, " ") || undefined,
    forcedType: directions.size === 1 ? directions.values().next().value : undefined,
    conflicts: directions.size > 1,
    incomeCommand,
  };
}

function imageFileId(file: unknown) {
  if (!isRecord(file) || typeof file.file_id !== "string" || !file.file_id.trim()) {
    return null;
  }
  return file.file_id;
}

function messageImage(message: Record<string, unknown>): TelegramImage | undefined {
  if (Array.isArray(message.photo)) {
    let largestSize = 0;
    let largestFileId: string | null = null;
    for (const variant of message.photo) {
      if (!isRecord(variant) || !isPositiveInteger(variant.width) || !isPositiveInteger(variant.height)) {
        continue;
      }
      const fileId = imageFileId(variant);
      const size = variant.width * variant.height;
      if (fileId && size > largestSize) {
        largestFileId = fileId;
        largestSize = size;
      }
    }
    return largestFileId ? { fileId: largestFileId } : undefined;
  }

  const document = message.document;
  if (isRecord(document) && supportedImageTypes.some((mimeType) => mimeType === document.mime_type)) {
    const fileId = imageFileId(document);
    if (fileId) return { fileId };
  }
}

function editPromptId(message: unknown) {
  if (
    isRecord(message) &&
    isRecord(message.from) &&
    message.from.is_bot === true &&
    typeof message.text === "string" &&
    message.text.startsWith(telegramEditPromptPrefix) &&
    isPositiveInteger(message.message_id)
  ) {
    return message.message_id;
  }
}

export function readTelegramMessage(update: unknown) {
  const envelope = readPrivateMessage(update);
  const date = envelope?.message.date;
  if (!envelope || !isPositiveInteger(date)) return null;

  const { message, userId, messageId } = envelope;
  const photo = messageImage(message);
  const text = typeof message.text === "string"
    ? message.text
    : photo && typeof message.caption === "string"
      ? message.caption
      : undefined;
  const replyToPromptId = editPromptId(message.reply_to_message);
  const updateId = isRecord(update) && typeof update.update_id === "number" &&
    Number.isSafeInteger(update.update_id) && update.update_id >= 0 ? update.update_id : undefined;

  return text?.trim() || photo ? { userId, messageId, updateId, date, text, photo, replyToPromptId } : null;
}

const transactionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTransactionId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && transactionIdPattern.test(value);
}

function isWorkspaceType(value: unknown): value is WorkspaceType {
  return value === "personal" || value === "household";
}

type QuickCallback = {
  view: TelegramQuickView | "workspace";
  month?: string;
  workspaceType?: WorkspaceType;
};

function readQuickCallback(parts: string[]): QuickCallback | null {
  const [, view, option, room] = parts;
  if (view === "monthly" && isTelegramReportMonth(option)) {
    if (parts.length === 3) return { view, month: option };
    if (parts.length === 4 && isWorkspaceType(room)) return { view, month: option, workspaceType: room };
    return null;
  }
  if (
    view !== "menu" && view !== "balance" && view !== "history" &&
    view !== "today" && view !== "monthly" && view !== "workspace"
  ) return null;

  if (parts.length === 2) return { view };
  if (parts.length === 3 && isWorkspaceType(option)) return { view, workspaceType: option };
  return null;
}

function originalTransactionIds(message: Record<string, unknown>) {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];

  const ids = new Set<string>();
  for (const row of markup.inline_keyboard.slice(0, 40)) {
    if (!Array.isArray(row)) continue;
    const button = row.find((candidate) => isRecord(candidate) &&
      typeof candidate.callback_data === "string" && candidate.callback_data.startsWith("edit:"));
    const id: unknown = button?.callback_data.slice(5);
    if (isTransactionId(id)) ids.add(id.toLowerCase());
    if (ids.size === 20) break;
  }
  return [...ids];
}

export function readTelegramCallback(update: unknown) {
  if (!isRecord(update) || !isRecord(update.callback_query)) return null;

  const { id: queryId, from, message, data } = update.callback_query;
  if (
    typeof queryId !== "string" || !queryId.trim() ||
    !isRecord(message) || !isPositiveInteger(message.message_id) ||
    typeof data !== "string" || Buffer.byteLength(data) > 64
  ) {
    return null;
  }

  const userId = privateUserId(from, message.chat);
  if (userId === null) return null;

  const base = { queryId, userId, messageId: message.message_id };
  const parts = data.split(":");
  const [action, option, id] = parts;
  if (action === "quick") {
    const selection = readQuickCallback(parts);
    return selection ? { ...base, action, ...selection } as const : null;
  }
  if (parts.length === 2 && action === "workspace" && isWorkspaceType(option)) {
    return { ...base, action, workspaceType: option } as const;
  }
  if (parts.length === 3 && (action === "move" || action === "flip") && isTransactionId(id)) {
    const transactionId = id.toLowerCase();
    const originalIds = originalTransactionIds(message);
    const target = {
      ...base,
      transactionId,
      messageTransactionIds: originalIds.includes(transactionId) ? originalIds : [transactionId],
    } as const;
    if (action === "move" && isWorkspaceType(option)) return { ...target, action, targetWorkspaceType: option } as const;
    if (action === "flip" && (option === "income" || option === "expense")) return { ...target, action, targetType: option } as const;
  }
  if (parts.length === 2 && (action === "edit" || action === "delete") && isTransactionId(option)) {
    return { ...base, action, transactionId: option } as const;
  }
  return null;
}

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Konfigurasi Bot Telegram belum lengkap.");
  }
  return token;
}

async function callTelegram(method: TelegramMethod, payload: object) {
  const token = getBotToken();
  try {
    const response = await fetch(botApiOrigin + "/bot" + token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(telegramRequestTimeout),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (isRecord(body) && body.ok === true && "result" in body) {
        return body.result;
      }
    } else if (method === "getFile" && response.status === 400) {
      throw new TelegramImageInputError("Foto tidak tersedia di Telegram.");
    } else if (method === "editMessageText" && response.status === 400) {
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && typeof body.description === "string" && body.description.includes("message is not modified")) {
        return true;
      }
    }
  } catch (error) {
    if (error instanceof TelegramImageInputError) throw error;
    // Pesan dari fetch dapat memuat URL yang berisi token bot.
  }
  throw new Error("Permintaan ke Telegram gagal.");
}

function detectImageType(bytes: Buffer): TelegramImageType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

async function downloadFileBytes(path: string) {
  const token = getBotToken();
  try {
    const response = await fetch(botApiOrigin + "/file/bot" + token + "/" + path, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(telegramRequestTimeout),
    });
    if (response.status === 404 || response.status === 410) {
      throw new TelegramImageInputError("Foto tidak tersedia di Telegram.");
    }
    if (!response.ok || !response.body) throw new Error();
    if (Number(response.headers.get("content-length")) > maxImageBytes) {
      await response.body.cancel().catch(() => {});
      throw new TelegramImageInputError("Ukuran foto Telegram terlalu besar.");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxImageBytes) {
          await reader.cancel().catch(() => {});
          throw new TelegramImageInputError("Ukuran foto Telegram terlalu besar.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof TelegramImageInputError) throw error;
    throw new Error("Foto Telegram tidak dapat diunduh.");
  }
}

const telegramFilePath = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export async function downloadTelegramImage(photo: TelegramImage) {
  const details = await callTelegram("getFile", { file_id: photo.fileId });
  if (
    !isRecord(details) ||
    typeof details.file_path !== "string" ||
    telegramFilePath.exec(details.file_path)?.[0] !== details.file_path
  ) {
    throw new TelegramImageInputError("Foto tidak tersedia di Telegram.");
  }
  if (typeof details.file_size === "number" && details.file_size > maxImageBytes) {
    throw new TelegramImageInputError("Ukuran foto Telegram terlalu besar.");
  }

  const bytes = await downloadFileBytes(details.file_path);
  const mimeType = detectImageType(bytes);
  if (!mimeType) throw new TelegramImageInputError("Format foto Telegram tidak didukung.");
  return { data: bytes.toString("base64"), mimeType };
}

export function telegramMessageReply(chatId: number, text: string, keyboard?: TelegramInlineKeyboard) {
  return {
    method: "sendMessage" as const,
    chat_id: chatId,
    text,
    ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }),
  };
}

export async function sendTelegramMessage(chatId: number, text: string, extra?: TelegramForceReply) {
  const result = await callTelegram("sendMessage", { chat_id: chatId, text, ...extra });
  if (!isRecord(result) || !isPositiveInteger(result.message_id)) {
    throw new Error("Pesan Telegram tidak dapat dikirim.");
  }
  return { message_id: result.message_id };
}

export async function editTelegramMessage(chatId: number, messageId: number, text: string, keyboard: TelegramInlineKeyboard) {
  const result = await callTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: keyboard },
  });
  if (result !== true && !isRecord(result)) {
    throw new Error("Pesan Telegram tidak dapat diperbarui.");
  }
}

export async function answerTelegramCallback(queryId: string, text?: string) {
  const result = await callTelegram("answerCallbackQuery", { callback_query_id: queryId, text });
  if (result !== true) throw new Error("Tombol Telegram tidak dapat diproses.");
}

export function getTelegramMenuButtonConfig() {
  const url = URL.parse(process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "");
  if (
    !url || url.protocol !== "https:" || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    return null;
  }
  return { type: "web_app" as const, text: "Buka Dashboard", web_app: { url: url.href } };
}

export function getTelegramWorkspacePageUrl() {
  const config = getTelegramMenuButtonConfig();
  return config ? new URL("/ruang", config.web_app.url).href : null;
}

export async function setTelegramDashboardMenu(chatId?: number) {
  const menu = getTelegramMenuButtonConfig();
  if (!menu) return;
  const result = await callTelegram("setChatMenuButton", { chat_id: chatId, menu_button: menu });
  if (result !== true) throw new Error("Menu Telegram tidak dapat diperbarui.");
}
