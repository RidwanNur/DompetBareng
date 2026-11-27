import { getDailyAiLimit } from "@/lib/ai-quota";
import { formatRupiah } from "@/lib/format";
import { GeminiUnavailableError, parseTransactions } from "@/lib/gemini";
import {
  answerTelegramCallback,
  downloadTelegramImage,
  editTelegramMessage,
  getTelegramWorkspacePageUrl,
  hashTelegramLinkToken,
  readTelegramCallback,
  readTelegramLinkCommand,
  readTelegramMessage,
  readTelegramQuickCommand,
  readTelegramTransactionType,
  readTelegramWorkspaceCommand,
  readTelegramWorkspaceTags,
  sendTelegramMessage,
  setTelegramDashboardMenu,
  telegramEditPromptPrefix,
  TelegramImageInputError,
  telegramMessageReply,
  telegramWorkspaceLabels,
  verifyTelegramWebhook,
  type TelegramInlineKeyboard,
} from "@/lib/telegram";
import { redeemTelegramLink, type TelegramLinkResult } from "@/lib/telegram-link";
import { logTelegramFailure } from "@/lib/telegram-diagnostics";
import { getTelegramQuickReport, renderTelegramQuickReport } from "@/lib/telegram-quick-reports";
import { parseTelegramReportMonth } from "@/lib/telegram-report-date";
import {
  beginTelegramInput,
  deleteTelegramTransaction,
  finishTelegramInput,
  flipTelegramTransaction,
  getTelegramEditTarget,
  getTelegramTransactionReceipts,
  getTelegramWorkspaceState,
  releaseTelegramInput,
  saveTelegramEditPrompt,
  setTelegramWorkspace,
  type TransactionReceipt,
  type TelegramTransactionDraft,
} from "@/lib/telegram-transactions";
import { currentTransactionDate, readExplicitTransactionDates, stripTransactionDates } from "@/lib/transaction-date";
import { moveTransaction } from "@/lib/transaction-move";
import type { TransactionDraft, WorkspaceType } from "@/types/database";

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
type TelegramQuickCommand = NonNullable<ReturnType<typeof readTelegramQuickCommand>>;

const missingTransaction = "Transaksi tidak ditemukan atau tidak dapat diubah.";
const connectTelegram = "Hubungkan akun Telegram dari DompetBareng terlebih dahulu.";
const householdUnavailable = "Ruang Rumah Tangga belum tersedia. Buka halaman Ruang di PWA untuk membuat atau bergabung.";
const workspaceKeyboard: TelegramInlineKeyboard = [[
  { text: "Pribadi", callback_data: "workspace:personal" },
  { text: "Rumah Tangga", callback_data: "workspace:household" },
]];
const quickMenu: TelegramInlineKeyboard = [
  [{ text: "Saldo", callback_data: "quick:balance" }, { text: "Laporan Bulan Ini", callback_data: "quick:monthly" }],
  [{ text: "5 Riwayat", callback_data: "quick:history" }, { text: "Hari Ini", callback_data: "quick:today" }],
  [{ text: "Ganti Ruang", callback_data: "quick:workspace" }],
];
const invalidMonth = "Format bulan belum valid. Coba /laporan bulan lalu, /laporan nov 2026, /laporan 10/2026, atau /laporan 2026-10.";
const aiUnavailable = "Layanan AI sedang sibuk sementara. Silakan kirim ulang pesan ini beberapa saat lagi atau catat lewat PWA.";
const processingFailed = "Permintaan belum dapat diproses. Periksa riwayat sebelum mencoba lagi.";
const transactionTypeLabels = { income: "Pemasukan", expense: "Pengeluaran" };
const receiptDate = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });

function emptyResponse() {
  return new Response(null, { headers });
}

function reply(userId: number, text: string, keyboard?: TelegramInlineKeyboard) {
  return Response.json(telegramMessageReply(userId, text, keyboard), { headers });
}

function replyWithoutHousehold(userId: number) {
  const url = getTelegramWorkspacePageUrl();
  return reply(userId, householdUnavailable, url ? [[{ text: "Buka Ruang", url }]] : undefined);
}

function displayText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

function transactionMessage(transactions: TransactionReceipt[]) {
  const lineBudget = Math.floor((4096 - Math.max(0, transactions.length - 1) * 2) / Math.max(1, transactions.length));
  const lines = transactions.map((entry) => {
    const item = entry.item.replace(/\s+/g, " ").trim();
    const wallet = entry.wallet_name.replace(/\s+/g, " ").trim();
    const sign = entry.type === "income" ? "+" : "-";
    const nominal = sign + formatRupiah(entry.amount).replace(/\s/g, "");
    const details = ` - ${nominal} (${entry.category}) [${telegramWorkspaceLabels[entry.workspace_type]}] · `;
    const dateLine = `\n${transactionTypeLabels[entry.type]} · Tanggal: ${receiptDate.format(new Date(entry.occurred_at))}`;
    const labelBudget = lineBudget - "Tercatat! ".length - details.length - dateLine.length;
    const walletLabel = displayText(wallet, Math.max(Math.floor(labelBudget / 2), labelBudget - item.length));
    return `Tercatat! ${displayText(item, labelBudget - walletLabel.length)}${details}${walletLabel}${dateLine}`;
  });
  const keyboard: TelegramInlineKeyboard = transactions.flatMap(({ id, type, workspace_type, can_move }) => {
    const nextType = type === "income" ? "expense" : "income";
    const nextWorkspace = workspace_type === "personal" ? "household" : "personal";
    return [
      [{ text: "Edit", callback_data: `edit:${id}` }, { text: "Hapus", callback_data: `delete:${id}` }],
      [
        ...(can_move ? [{ text: `Pindah ke ${telegramWorkspaceLabels[nextWorkspace]}`, callback_data: `move:${nextWorkspace}:${id}` }] : []),
        { text: `Ubah ke ${transactionTypeLabels[nextType]}`, callback_data: `flip:${nextType}:${id}` },
      ],
    ];
  });
  return { text: lines.join("\n\n"), keyboard };
}

function replyWithTransactions(userId: number, transactions: TransactionReceipt[]) {
  const { text, keyboard } = transactionMessage(transactions);
  return reply(userId, text, keyboard);
}

function workspaceStatus(workspaceType: WorkspaceType) {
  return `Ruang default: ${telegramWorkspaceLabels[workspaceType]}.`;
}

async function handleWorkspaceCommand(userId: number, workspaceType: WorkspaceType | null) {
  if (workspaceType === null) {
    const state = await getTelegramWorkspaceState(userId);
    return state ? reply(userId, workspaceStatus(state.active_workspace_type), workspaceKeyboard) : reply(userId, connectTelegram);
  }

  const result = await setTelegramWorkspace(userId, workspaceType);
  if (result === "workspace_unavailable") return replyWithoutHousehold(userId);
  if (result === "unlinked") return reply(userId, connectTelegram);
  return reply(userId, workspaceStatus(workspaceType), workspaceKeyboard);
}

function replyQuickMenu(userId: number, help = false) {
  const menu = "Akses cepat DompetBareng\nPilih menu di bawah. Gunakan tag #pribadi atau #rt pada perintah untuk memilih ruang.";
  const examples = "\n\nContoh pemasukan: gaji 5jt bank atau +500rb bonus #rt.\nTanggal lampau: bensin 50rb 15/11/2026 atau makan 25rb kemarin.";
  return reply(userId, menu + (help ? examples : ""), quickMenu);
}

async function replyQuickReport(query: Parameters<typeof getTelegramQuickReport>[0], editMessageId?: number) {
  const result = await getTelegramQuickReport(query);
  const { userId } = query;
  if (result.status === "unlinked") return reply(userId, connectTelegram);
  if (result.status === "workspace_unavailable") return replyWithoutHousehold(userId);
  if (result.status !== "ok") return reply(userId, query.view === "monthly" ? invalidMonth : "Ringkasan belum bisa dibuka.");

  const { messages, keyboard } = renderTelegramQuickReport(result.report);
  if (editMessageId !== undefined) {
    await editTelegramMessage(userId, editMessageId, messages[0], keyboard ?? []);
    return emptyResponse();
  }

  // Daftar dompet yang panjang tetap bisa dikirim dalam beberapa pesan.
  const last = messages.length - 1;
  for (const text of messages.slice(0, last)) await sendTelegramMessage(userId, text);
  return reply(userId, messages[last], keyboard);
}

function handleQuickCommand({ userId, view, help, workspaceType, argument, conflicts }: TelegramQuickCommand) {
  if (view === "menu") return replyQuickMenu(userId, help);
  if (conflicts) return reply(userId, "Pilih satu tag ruang, #pribadi atau #rt.");
  if (view === "monthly") {
    const month = parseTelegramReportMonth(argument);
    return month ? replyQuickReport({ userId, view, workspaceType, month }) : reply(userId, invalidMonth);
  }
  if (argument) return reply(userId, "Tambahkan tag #pribadi atau #rt untuk memilih ruang.");
  return replyQuickReport({ userId, view, workspaceType });
}

async function handleQuickCallback({ queryId, userId, messageId, view, month, workspaceType }: Extract<TelegramCallback, { action: "quick" }>) {
  const acknowledged = answerTelegramCallback(queryId).catch(() => {});
  try {
    if (view === "workspace") return await handleWorkspaceCommand(userId, null);
    if (view === "menu") return replyQuickMenu(userId);
    if (view === "monthly") {
      const selectedMonth = month ?? parseTelegramReportMonth("");
      return selectedMonth
        ? await replyQuickReport({ userId, view, workspaceType, month: selectedMonth }, month ? messageId : undefined)
        : reply(userId, invalidMonth);
    }
    return await replyQuickReport({ userId, view, workspaceType });
  } finally {
    await acknowledged;
  }
}

async function handleWorkspaceCallback({ queryId, userId, messageId, workspaceType }: Extract<TelegramCallback, { action: "workspace" }>) {
  const result = await setTelegramWorkspace(userId, workspaceType);
  await answerTelegramCallback(queryId).catch(() => {});
  if (result === "workspace_unavailable") return replyWithoutHousehold(userId);
  if (result === "unlinked") return reply(userId, connectTelegram);
  await editTelegramMessage(userId, messageId, workspaceStatus(workspaceType), workspaceKeyboard).catch(() => {});
  return emptyResponse();
}

async function handleMove({ queryId, userId, messageId, transactionId, targetWorkspaceType, messageTransactionIds }: Extract<TelegramCallback, { action: "move" }>) {
  const moved = await moveTransaction({
    channel: "telegram",
    telegramUserId: userId,
    transactionId,
    targetWorkspaceType,
    operationId: queryId,
  });
  if (!("transaction" in moved)) {
    const text = moved.status === "invalid_wallet"
      ? "Dompet aktif di ruang tujuan belum tersedia."
      : "Transaksi tidak dapat dipindahkan.";
    await answerTelegramCallback(queryId, text).catch(() => {});
    return emptyResponse();
  }

  await answerTelegramCallback(queryId, `Transaksi dipindahkan ke ${telegramWorkspaceLabels[moved.transaction.workspace_type]}.`).catch(() => {});
  return refreshTransactionReply(userId, messageId, messageTransactionIds);
}

async function refreshTransactionReply(userId: number, messageId: number, messageTransactionIds: string[]) {
  const transactions = await getTelegramTransactionReceipts(userId, messageTransactionIds);
  if (transactions.length) {
    const { text, keyboard } = transactionMessage(transactions);
    await editTelegramMessage(userId, messageId, text, keyboard);
  }
  return emptyResponse();
}

async function handleFlip({ queryId, userId, messageId, transactionId, targetType, messageTransactionIds }: Extract<TelegramCallback, { action: "flip" }>) {
  const transaction = await flipTelegramTransaction(userId, transactionId, targetType, queryId);
  const confirmation = transaction ? `Tipe transaksi: ${transactionTypeLabels[transaction.type]}.` : missingTransaction;
  await answerTelegramCallback(queryId, confirmation).catch(() => {});
  return transaction ? refreshTransactionReply(userId, messageId, messageTransactionIds) : emptyResponse();
}

async function handleCallback(callback: TelegramCallback) {
  if (callback.action === "quick") return handleQuickCallback(callback);
  if (callback.action === "workspace") return handleWorkspaceCallback(callback);
  if (callback.action === "move") return handleMove(callback);
  if (callback.action === "flip") return handleFlip(callback);

  const { queryId, userId, transactionId, action } = callback;
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

async function handleInput(
  message: TelegramMessage & { workspaceType?: WorkspaceType },
  parsedText: string | undefined,
  forcedType: TransactionDraft["type"] | undefined,
) {
  let stage = "claim_input";
  let claimToken: string | undefined;

  try {
    const limit = getDailyAiLimit();
    const claim = await beginTelegramInput(message, limit);
    switch (claim.status) {
      case "duplicate":
      case "busy": return emptyResponse();
      case "unlinked": return reply(message.userId, connectTelegram);
      case "workspace_unavailable": return replyWithoutHousehold(message.userId);
      case "not_found": return reply(message.userId, missingTransaction);
      case "rate_limited":
        return reply(message.userId, `Kuota input AI harian Telegram tercapai (${limit}/${limit}). Catat manual lewat PWA atau coba lagi besok.`);
    }
    if (claim.status !== "ready") return emptyResponse();
    claimToken = claim.claim_token;

    stage = "parse_date";
    const sentAt = new Date(message.date * 1000);
    const occurredAt = Number.isFinite(sentAt.getTime()) ? sentAt : new Date();
    const referenceDate = currentTransactionDate(occurredAt);
    const explicitDates = readExplicitTransactionDates(parsedText, referenceDate);
    let drafts: TelegramTransactionDraft[];
    try {
      stage = "download_image";
      const image = message.photo ? await downloadTelegramImage(message.photo) : undefined;
      stage = "gemini_extract";
      const predictions = await parseTransactions({ text: parsedText, image, existing: claim.existing, forcedType, referenceDate });
      stage = "normalize_drafts";
      drafts = predictions.map(({ transaction_date: extractedDate, ...draft }) => {
        const explicitDate = explicitDates.find((date) => date === extractedDate) ?? explicitDates[0];
        const date = explicitDate ?? (image ? extractedDate : undefined);
        const cleanType = readTelegramTransactionType(readTelegramWorkspaceTags(draft.item).text);
        const item = stripTransactionDates(cleanType.text ?? "") || transactionTypeLabels[draft.type];
        return { ...draft, item, ...(date && { occurred_at: date }) };
      });
    } catch (error) {
      if (!(error instanceof TelegramImageInputError)) throw error;
      drafts = [];
    }

    stage = "save_transaction";
    const result = await finishTelegramInput(
      message,
      claimToken,
      drafts,
      message.text ?? null,
      occurredAt.toISOString(),
    );
    claimToken = undefined;

    stage = "build_reply";
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
        return emptyResponse();
    }
  } catch (error) {
    logTelegramFailure("[telegram] input processing failed", stage, error);
    if (claimToken) {
      await releaseTelegramInput(message, claimToken).catch((releaseError: unknown) => {
        logTelegramFailure("[telegram] input claim release failed", "release_claim", releaseError);
      });
    }
    if (error instanceof GeminiUnavailableError) return reply(message.userId, aiUnavailable);
    return reply(message.userId, processingFailed);
  }
}

export async function POST(request: Request) {
  if (!verifyTelegramWebhook(request.headers)) {
    return new Response(null, { status: 401, headers });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return emptyResponse();
  }

  let userId: number | undefined;
  let callbackId: string | undefined;
  let stage = "dispatch";
  try {
    const command = readTelegramLinkCommand(update);
    if (command) {
      userId = command.userId;
      stage = "link_account";
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

    const workspaceCommand = readTelegramWorkspaceCommand(update);
    if (workspaceCommand) {
      userId = workspaceCommand.userId;
      stage = "workspace_command";
      return await handleWorkspaceCommand(workspaceCommand.userId, workspaceCommand.workspaceType);
    }

    const quickCommand = readTelegramQuickCommand(update);
    if (quickCommand) {
      userId = quickCommand.userId;
      stage = "report_command";
      return await handleQuickCommand(quickCommand);
    }

    const callback = readTelegramCallback(update);
    if (callback) {
      userId = callback.userId;
      callbackId = callback.queryId;
      stage = "callback";
      return await handleCallback(callback);
    }

    const message = readTelegramMessage(update);
    if (!message) return emptyResponse();
    userId = message.userId;
    stage = "parse_input";
    const tagged = readTelegramWorkspaceTags(message.text);
    const input = readTelegramTransactionType(tagged.text);
    if (!message.photo && message.text?.trimStart().startsWith("/") && !input.incomeCommand) {
      return message.text.trim() === "/start"
        ? reply(message.userId, `Kirim teks transaksi atau foto struk/QRIS. ${connectTelegram}`)
        : emptyResponse();
    }
    if (tagged.conflicts) {
      return reply(message.userId, "Pilih satu tag ruang untuk transaksi ini, lalu kirim ulang.");
    }
    if (input.conflicts) return reply(message.userId, "Pilih satu penanda tipe, #masuk atau #keluar.");
    if (!input.text && !message.photo) {
      return reply(message.userId, "Tulis transaksi beserta nominal atau kirim foto struk.");
    }
    return await handleInput({
      ...message,
      workspaceType: message.replyToPromptId ? undefined : tagged.workspaceType,
    }, input.text, input.forcedType);
  } catch (error) {
    const label = stage === "parse_input" ? "[telegram] input processing failed" : "[telegram] webhook handler failed";
    logTelegramFailure(label, stage, error);
    if (callbackId) await answerTelegramCallback(callbackId).catch(() => {});
    return userId === undefined ? emptyResponse() : reply(userId, processingFailed);
  }
}
