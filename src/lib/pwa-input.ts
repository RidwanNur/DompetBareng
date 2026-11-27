import "server-only";

import { randomUUID } from "node:crypto";
import { aiQuotaMessage, getDailyAiLimit } from "@/lib/ai-quota";
import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { parseTransactions } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, WALLET_TYPES, type Transaction, type TransactionDraft, type WalletType } from "@/types/database";

export class PwaInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type ManualDraft = Pick<Transaction, "item" | "amount" | "type" | "category" | "wallet_id"> & { wallet_type: WalletType };
type ExtractionInput =
  | { inputId: string; workspaceId?: string; text: string }
  | { inputId: string; workspaceId?: string; receipt: File };
type Input = ExtractionInput | { inputId: string; workspaceId?: string; manual: ManualDraft };

const maxReceiptBytes = 4 * 1024 * 1024;
const maxMultipartBytes = maxReceiptBytes + 16 * 1024;
const maxTextLength = 4096;
const maxManualItemLength = 120;
const maxJsonBytes = 32 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const heicBrands = ["heic", "heix", "hevc", "hevx"];
const invalidInput = "Isi teks atau pilih satu foto struk yang valid.";
const invalidManual = "Isi rincian transaksi manual yang valid.";
const maxRupiah = "9223372036854775807";
const oversizeReceipt = "Ukuran struk maksimal 4 MiB.";
const unavailable = "Transaksi belum bisa disimpan. Coba lagi.";
const denied = "Anda tidak tergabung dalam ruang ini.";
export const pwaInputResponseHeaders = { "Cache-Control": "private, no-store" };

async function checkOrigin(request: Request, shared: boolean) {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const nativeOrigin = shared && origin === "null" && site === "none";
  if (
    site === "cross-site" || site === "same-site" ||
    (origin !== null && !nativeOrigin && origin !== new URL(request.url).origin && origin !== (await getAppOrigin()))
  ) {
    throw new PwaInputError(403, "Permintaan dari luar DompetBareng ditolak.");
  }

  if (shared) {
    const mode = request.headers.get("sec-fetch-mode");
    const destination = request.headers.get("sec-fetch-dest");
    if ((mode !== null && mode !== "navigate") || (destination !== null && destination !== "document")) {
      throw new PwaInputError(400, invalidInput);
    }
  }
}

function boundBody(request: Request, contentType: string, limit: number, sizeError: string) {
  const rejectSize = () => new PwaInputError(413, sizeError);
  if (Number(request.headers.get("content-length")) > limit) throw rejectSize();
  if (!request.body) throw new PwaInputError(400, invalidInput);

  let size = 0;
  // Multipart request producers can still have pending chunks when parsing stops.
  const stream = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) throw rejectSize();
      controller.enqueue(chunk);
    },
  }), { preventCancel: true });
  return new Response(stream, { headers: { "Content-Type": contentType } });
}

function inputIds(inputId: unknown, workspaceId: unknown, shared: boolean) {
  if (workspaceId !== undefined && !isUuid(workspaceId)) {
    throw new PwaInputError(400, "Ruang transaksi tidak valid.");
  }
  if (shared && inputId === undefined) {
    return { inputId: randomUUID(), workspaceId };
  }
  if (!isUuid(inputId)) {
    throw new PwaInputError(400, "Permintaan pencatatan tidak valid.");
  }
  return { inputId, workspaceId };
}

function readManualDraft(value: unknown): ManualDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PwaInputError(400, invalidManual);
  }

  const { item, amount, type, category, wallet_id, wallet_type } = value as Record<string, unknown>;
  const title = typeof item === "string" ? item.trim() : "";
  const categories = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const selectedCategory = categories.find((entry) => entry === category);
  const walletType = WALLET_TYPES.find((entry) => entry === wallet_type);
  if (
    Object.keys(value).some((key) => !["item", "amount", "type", "category", "wallet_id", "wallet_type"].includes(key)) ||
    !title || title.includes("\0") || title.length > maxManualItemLength || !isUuid(wallet_id) || !walletType ||
    typeof amount !== "string" || amount.length > maxRupiah.length || !/^[1-9][0-9]*$/.test(amount) ||
    amount !== amount.trim() ||
    (amount.length === maxRupiah.length && amount > maxRupiah) ||
    (type !== "income" && type !== "expense") || !selectedCategory
  ) {
    throw new PwaInputError(400, invalidManual);
  }

  return {
    item: title, amount: amount as ManualDraft["amount"], type, category: selectedCategory,
    wallet_id: wallet_id.toLowerCase(), wallet_type: walletType,
  };
}

async function readInput(request: Request, shared: boolean): Promise<Input> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  try {
    if (!shared && mediaType === "application/json") {
      const data: unknown = await boundBody(request, contentType, maxJsonBytes, "Teks transaksi terlalu panjang.").json();
      if (
        typeof data !== "object" || data === null || Array.isArray(data) ||
        Object.keys(data).some((key) => !["text", "manual", "input_id", "workspace_id"].includes(key))
      ) {
        throw new PwaInputError(400, invalidInput);
      }
      const { text, manual, input_id, workspace_id } = data as Record<string, unknown>;
      const ids = inputIds(input_id, workspace_id, shared);
      if (manual !== undefined) {
        if (text !== undefined) throw new PwaInputError(400, invalidManual);
        return { manual: readManualDraft(manual), ...ids };
      }
      if (typeof text !== "string" || !text.trim()) throw new PwaInputError(400, invalidInput);
      if (text.length > maxTextLength) throw new PwaInputError(413, "Teks transaksi terlalu panjang.");

      return { text, ...ids };
    }

    if (mediaType === "multipart/form-data") {
      const data = await boundBody(request, contentType, maxMultipartBytes, oversizeReceipt).formData();
      const keys = [...data.keys()];
      if (
        keys.some((key) => key !== "receipt" && key !== "input_id" && key !== "workspace_id") ||
        new Set(keys).size !== keys.length
      ) {
        throw new PwaInputError(400, invalidInput);
      }
      const receipt = data.get("receipt");
      if (!(receipt instanceof File) || !receipt.size) throw new PwaInputError(400, invalidInput);
      if (receipt.size > maxReceiptBytes) throw new PwaInputError(413, oversizeReceipt);

      return { receipt, ...inputIds(data.get("input_id") ?? undefined, data.get("workspace_id") ?? undefined, shared) };
    }
  } catch (error) {
    if (error instanceof PwaInputError) throw error;
    throw new PwaInputError(400, invalidInput);
  }
  throw new PwaInputError(415, "Format permintaan pencatatan tidak didukung.");
}

function receiptMimeType(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, pngSignature.length).equals(pngSignature)) return "image/png";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";

  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) return;
  let mimeType: "image/heic" | "image/heif" | undefined;
  for (let offset = 8; offset < boxSize; offset += 4) {
    if (offset === 12) continue; // Minor version follows the major brand.
    const brand = bytes.toString("latin1", offset, offset + 4);
    if (brand === "avif" || brand === "avis") return;
    if (heicBrands.includes(brand)) mimeType = "image/heic";
    if (brand === "mif1" || brand === "msf1") mimeType ??= "image/heif";
  }
  return mimeType;
}

async function geminiInput(input: ExtractionInput) {
  if ("text" in input) return { text: input.text };

  const bytes = Buffer.from(await input.receipt.arrayBuffer());
  const mimeType = receiptMimeType(bytes);
  if (!mimeType) throw new PwaInputError(415, "Format foto struk tidak didukung.");
  return { image: { data: bytes.toString("base64"), mimeType } };
}

type PwaClient = Awaited<ReturnType<typeof createClient>>;

function checkInputStatus(data: { status?: string } | null) {
  if (data?.status === "forbidden") throw new PwaInputError(403, denied);
  if (data?.status === "conflict") {
    throw new PwaInputError(409, "Ruang pencatatan berubah. Mulai pencatatan baru.");
  }
}

function transactionCount(count: unknown) {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    throw new PwaInputError(503, unavailable);
  }
  return count;
}

async function saveTransactions(
  supabase: PwaClient, workspaceId: string, input: Input, transactions: readonly (ManualDraft | TransactionDraft)[], claimToken?: string,
) {
  const { data, error } = await supabase.rpc("save_pwa_transactions", {
    p_workspace_id: workspaceId,
    p_input_id: input.inputId,
    p_transactions: transactions,
    p_raw_input: "text" in input ? input.text : null,
    ...(claimToken && { p_extraction_claim_token: claimToken }),
  });
  if (error) throw new PwaInputError(503, unavailable);
  checkInputStatus(data);
  if (data?.status === "invalid_wallet") throw new PwaInputError(400, "Pilih dompet aktif di ruang ini.");
  if (data?.status !== "saved" && data?.status !== "duplicate") throw new PwaInputError(503, unavailable);
  return { status: data.status, count: transactionCount(data.count) };
}

export async function recordPwaInput(request: Request, shared = false): Promise<number> {
  await checkOrigin(request, shared);
  if (!isSupabaseConfigured()) throw new PwaInputError(503, unavailable);
  if (!(await getCurrentUser())) throw new PwaInputError(401, "Masuk untuk mencatat transaksi.");

  const input = await readInput(request, shared);
  const state = await getWorkspaceState();
  const workspaceId = input.workspaceId?.toLowerCase() ?? state.active_workspace_id;
  if (workspaceId !== state.personal.id && workspaceId !== state.household?.id) {
    throw new PwaInputError(403, denied);
  }

  const supabase = await createClient();
  if ("manual" in input) return (await saveTransactions(supabase, workspaceId, input, [input.manual])).count;

  const content = await geminiInput(input);
  const limit = getDailyAiLimit();
  const { data, error } = await supabase.rpc("reserve_pwa_extraction", {
    p_workspace_id: workspaceId,
    p_input_id: input.inputId,
    p_daily_limit: limit,
  });
  if (error) throw new PwaInputError(503, unavailable);
  checkInputStatus(data);
  if (data?.status === "duplicate") return transactionCount(data.count);
  if (data?.status === "rate_limited") throw new PwaInputError(429, aiQuotaMessage(limit));
  if (data?.status === "busy") throw new PwaInputError(409, "Transaksi sedang diproses. Coba lagi sebentar.");
  if (data?.status !== "ready" || !isUuid(data.claim_token)) throw new PwaInputError(503, unavailable);

  let settled = false;
  try {
    const transactions = await parseTransactions(content).catch(() => {
      throw new PwaInputError(503, "Pembacaan transaksi belum tersedia. Catat manual atau coba lagi.");
    });
    if (!transactions.length) {
      throw new PwaInputError(422, "Transaksi belum terbaca. Tulis nominal atau pilih foto struk yang jelas.");
    }
    const saved = await saveTransactions(supabase, workspaceId, input, transactions, data.claim_token);
    settled = saved.status === "saved";
    return saved.count;
  } finally {
    if (!settled) {
      await Promise.resolve(supabase.rpc("release_pwa_extraction", {
        p_input_id: input.inputId,
        p_claim_token: data.claim_token,
      })).catch(() => undefined);
    }
  }
}
