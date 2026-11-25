import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const redeemResults = [
  "linked",
  "already_linked",
  "telegram_in_use",
  "invalid",
  "duplicate",
] as const;

export type TelegramLinkResult = (typeof redeemResults)[number];

export async function getTelegramLinkStatus() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_telegram_link_status");

  if (error || typeof data !== "boolean") {
    throw new Error("Status penautan Telegram tidak dapat dibaca.");
  }

  return data;
}

export async function saveTelegramLinkToken(tokenHash: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("issue_telegram_link", {
    p_token_hash: tokenHash,
  });

  if (error || typeof data !== "boolean") {
    throw new Error("Tautan Telegram tidak dapat dibuat.");
  }

  return data;
}

export async function redeemTelegramLink(
  tokenHash: string,
  userId: number,
  messageId: number,
) {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("redeem_telegram_link", {
    p_token_hash: tokenHash,
    p_telegram_user_id: userId,
    p_telegram_message_id: messageId,
  });

  const result = redeemResults.find((status) => status === data);

  if (error || !result) {
    throw new Error("Penautan Telegram tidak dapat diproses.");
  }

  return result;
}
