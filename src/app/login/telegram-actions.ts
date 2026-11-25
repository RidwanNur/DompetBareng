"use server";

import {
  generateTelegramLinkToken,
  getTelegramLinkUrl,
  hashTelegramLinkToken,
} from "@/lib/telegram";
import { saveTelegramLinkToken } from "@/lib/telegram-link";

export async function issueTelegramLink(): Promise<
  { url: string } | { error: string }
> {
  try {
    const token = generateTelegramLinkToken();
    const url = getTelegramLinkUrl(token);
    const issued = await saveTelegramLinkToken(hashTelegramLinkToken(token));

    if (!issued) {
      return { error: "Akun ini sudah terhubung ke Telegram." };
    }

    return { url };
  } catch {
    return { error: "Tautan Telegram tidak dapat dibuat. Silakan coba lagi." };
  }
}
