import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const botApiOrigin = "https://api.telegram.org";
const telegramRequestTimeout = 5_000;
const maxImageBytes = 10 * 1024 * 1024;
const supportedImageTypes = ["image/jpeg", "image/png", "image/webp"] as const;

type TelegramImageType = (typeof supportedImageTypes)[number];
type TelegramImage = { fileId: string };
type TelegramMethod = "getFile" | "sendMessage" | "answerCallbackQuery" | "setChatMenuButton";

export type TelegramInlineKeyboard = readonly (readonly {
  text: string;
  callback_data: string;
}[])[];

type TelegramForceReply = {
  reply_markup: { force_reply: true; input_field_placeholder?: string };
};

export const telegramEditPromptPrefix = "Koreksi transaksi";

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

  return text?.trim() || photo ? { userId, messageId, date, text, photo, replyToPromptId } : null;
}

const callbackPattern =
  /^(edit|delete):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function readTelegramCallback(update: unknown) {
  if (!isRecord(update) || !isRecord(update.callback_query)) return null;

  const { id: queryId, from, message, data } = update.callback_query;
  if (
    typeof queryId !== "string" || !queryId.trim() ||
    !isRecord(message) || !isPositiveInteger(message.message_id) ||
    typeof data !== "string"
  ) {
    return null;
  }

  const userId = privateUserId(from, message.chat);
  const match = callbackPattern.exec(data);
  if (userId === null || match?.[0] !== data) return null;

  return {
    queryId,
    userId,
    messageId: message.message_id,
    action: match[1] === "edit" ? "edit" as const : "delete" as const,
    transactionId: match[2],
  };
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

export async function setTelegramDashboardMenu(chatId?: number) {
  const menu = getTelegramMenuButtonConfig();
  if (!menu) return;
  const result = await callTelegram("setChatMenuButton", { chat_id: chatId, menu_button: menu });
  if (result !== true) throw new Error("Menu Telegram tidak dapat diperbarui.");
}
