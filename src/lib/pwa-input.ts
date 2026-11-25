import "server-only";

import { randomUUID } from "node:crypto";
import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { parseTransactions } from "@/lib/gemini";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceState, isUuid } from "@/lib/workspaces";

export class PwaInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Input =
  | { inputId: string; workspaceId?: string; text: string }
  | { inputId: string; workspaceId?: string; receipt: File };

const maxReceiptBytes = 4 * 1024 * 1024;
const maxMultipartBytes = maxReceiptBytes + 16 * 1024;
const maxTextLength = 4096;
const maxJsonBytes = 32 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const heicBrands = ["heic", "heix", "hevc", "hevx"];
const invalidInput = "Isi teks atau pilih satu foto struk yang valid.";
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

async function readInput(request: Request, shared: boolean): Promise<Input> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  try {
    if (!shared && mediaType === "application/json") {
      const data: unknown = await boundBody(request, contentType, maxJsonBytes, "Teks transaksi terlalu panjang.").json();
      if (
        typeof data !== "object" || data === null || Array.isArray(data) ||
        Object.keys(data).some((key) => key !== "text" && key !== "input_id" && key !== "workspace_id")
      ) {
        throw new PwaInputError(400, invalidInput);
      }
      const { text, input_id, workspace_id } = data as Record<string, unknown>;
      if (typeof text !== "string" || !text.trim()) throw new PwaInputError(400, invalidInput);
      if (text.length > maxTextLength) throw new PwaInputError(413, "Teks transaksi terlalu panjang.");

      return { text, ...inputIds(input_id, workspace_id, shared) };
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

async function geminiInput(input: Input) {
  if ("text" in input) return { text: input.text };

  const bytes = Buffer.from(await input.receipt.arrayBuffer());
  const mimeType = receiptMimeType(bytes);
  if (!mimeType) throw new PwaInputError(415, "Format foto struk tidak didukung.");
  return { image: { data: bytes.toString("base64"), mimeType } };
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

  const content = await geminiInput(input);
  const transactions = await parseTransactions(content).catch(() => {
    throw new PwaInputError(503, "Pembacaan transaksi belum tersedia. Coba lagi.");
  });
  if (!transactions.length) {
    throw new PwaInputError(422, "Transaksi belum terbaca. Tulis nominal atau pilih foto struk yang jelas.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_pwa_transactions", {
    p_workspace_id: workspaceId,
    p_input_id: input.inputId,
    p_transactions: transactions,
    p_raw_input: "text" in input ? input.text : null,
  });
  if (error) throw new PwaInputError(503, unavailable);
  if (data?.status === "forbidden") throw new PwaInputError(403, denied);
  if (data?.status === "conflict") {
    throw new PwaInputError(409, "Ruang pencatatan berubah. Mulai pencatatan baru.");
  }
  if (
    (data?.status !== "saved" && data?.status !== "duplicate") ||
    !Number.isSafeInteger(data.count) || data.count < 1
  ) {
    throw new PwaInputError(503, unavailable);
  }
  return data.count;
}
