import { formatRupiah } from "@/lib/format";
import { parseTransactions } from "@/lib/gemini";
import {
  answerTelegramCallback,
  downloadTelegramImage,
  hashTelegramLinkToken,
  readTelegramCallback,
  readTelegramLinkCommand,
  readTelegramMessage,
  sendTelegramMessage,
  setTelegramDashboardMenu,
  telegramEditPromptPrefix,
  TelegramImageInputError,
  telegramMessageReply,
  verifyTelegramWebhook,
} from "@/lib/telegram";
import { redeemTelegramLink, type TelegramLinkResult } from "@/lib/telegram-link";
import {
  beginTelegramInput,
  deleteTelegramTransaction,
  finishTelegramInput,
  getTelegramEditTarget,
  releaseTelegramInput,
  saveTelegramEditPrompt,
  type TransactionReceipt,
} from "@/lib/telegram-transactions";
import type { TransactionDraft } from "@/types/database";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

const replies: Record<Exclude<TelegramLinkResult, "duplicate">, string> = {
  linked: "Telegram Terhubung",
  already_linked: "Akun DompetBareng ini sudah terhubung ke Telegram.",
  telegram_in_use: "Telegram ini sudah terhubung ke akun DompetBareng lain.",
  invalid: "Tautan ini sudah tidak berlaku. Buat tautan baru di DompetBareng.",
};

type TelegramMessage = NonNullable<ReturnType<typeof readTelegramMessage>>;
type TelegramCallback = NonNullable<ReturnType<typeof readTelegramCallback>>;

const missingTransaction = "Transaksi tidak ditemukan atau tidak dapat diubah.";
const connectTelegram = "Hubungkan akun Telegram dari DompetBareng terlebih dahulu.";

function emptyResponse(status = 200) {
  return new Response(null, { status, headers });
}

function reply(userId: number, text: string) {
  return Response.json(telegramMessageReply(userId, text), { headers });
}

function replyWithTransactions(userId: number, transactions: TransactionReceipt[]) {
  const lines = transactions.map(({ item, amount, category }) => {
    const nominal = formatRupiah(amount).replace(/\s/g, "");
    return `Tercatat! ${item} - ${nominal} (${category})`;
  });
  const keyboard = transactions.map(({ id }) => [
    { text: "Edit", callback_data: `edit:${id}` },
    { text: "Hapus", callback_data: `delete:${id}` },
  ]);
  return Response.json(telegramMessageReply(userId, lines.join("\n"), keyboard), { headers });
}

async function handleCallback({ queryId, userId, transactionId, action }: TelegramCallback) {
  if (action === "delete") {
    const deleted = await deleteTelegramTransaction(userId, transactionId);
    await answerTelegramCallback(queryId, deleted ? "Transaksi dihapus." : missingTransaction);
    return emptyResponse();
  }

  const item = await getTelegramEditTarget(userId, transactionId);
  if (!item) {
    await answerTelegramCallback(queryId, missingTransaction);
    return emptyResponse();
  }

  // Prompt koreksi tetap bisa dikirim bila Telegram sudah menutup notifikasi tombol.
  await answerTelegramCallback(queryId).catch(() => {});
  const prompt = await sendTelegramMessage(
    userId,
    `${telegramEditPromptPrefix}: ${item}\nBalas pesan ini dengan perubahan transaksi.`,
    { reply_markup: { force_reply: true, input_field_placeholder: "Tulis perubahan transaksi" } },
  );
  await saveTelegramEditPrompt(userId, prompt.message_id, transactionId);
  return emptyResponse();
}

async function handleInput(message: TelegramMessage) {
  const claim = await beginTelegramInput(message);
  switch (claim.status) {
    case "duplicate": return emptyResponse();
    case "busy": return emptyResponse(503);
    case "unlinked": return reply(message.userId, connectTelegram);
    case "not_found": return reply(message.userId, missingTransaction);
    case "rate_limited":
      return reply(message.userId, "Kuota harian Telegram habis. Catat lewat PWA atau coba lagi besok.");
  }

  if (claim.status !== "ready") return emptyResponse(503);

  try {
    let drafts: TransactionDraft[];
    try {
      const image = message.photo ? await downloadTelegramImage(message.photo) : undefined;
      drafts = await parseTransactions({ text: message.text, image, existing: claim.existing });
    } catch (error) {
      if (!(error instanceof TelegramImageInputError)) throw error;
      drafts = [];
    }

    const result = await finishTelegramInput(
      message,
      claim.claim_token,
      drafts,
      message.text ?? null,
      new Date(message.date * 1000).toISOString(),
    );

    switch (result.status) {
      case "saved":
      case "edited":
        return replyWithTransactions(message.userId, result.transactions);
      case "empty":
        return reply(message.userId, claim.existing
          ? "Koreksi belum terbaca. Balas pesan koreksi dengan perubahan yang ingin disimpan."
          : "Transaksi belum terbaca. Kirim teks dengan nominal atau foto struk yang jelas.");
      case "not_found":
        return reply(message.userId, missingTransaction);
      case "obsolete":
        return emptyResponse(503);
    }
  } catch {
    await releaseTelegramInput(message, claim.claim_token).catch(() => {});
    return emptyResponse(503);
  }
}

export async function POST(request: Request) {
  if (!verifyTelegramWebhook(request.headers)) {
    return emptyResponse(401);
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return emptyResponse(400);
  }

  try {
    const command = readTelegramLinkCommand(update);
    if (command) {
      const result = await redeemTelegramLink(
        hashTelegramLinkToken(command.token),
        command.userId,
        command.messageId,
      );
      if (result === "duplicate") return emptyResponse();
      if (result === "linked" || result === "already_linked") {
        await setTelegramDashboardMenu(command.userId).catch(() => {});
      }
      return reply(command.userId, replies[result]);
    }

    const callback = readTelegramCallback(update);
    if (callback) return await handleCallback(callback);

    const message = readTelegramMessage(update);
    if (!message) return emptyResponse();
    if (!message.photo && message.text?.startsWith("/")) {
      return message.text === "/start"
        ? reply(message.userId, `Kirim teks transaksi atau foto struk/QRIS. ${connectTelegram}`)
        : emptyResponse();
    }
    return await handleInput(message);
  } catch {
    return emptyResponse(503);
  }
}
