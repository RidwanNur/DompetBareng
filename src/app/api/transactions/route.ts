import { getHistoryFromRequest, historyFailure, historyResponse } from "@/lib/history";
import { PwaInputError, pwaInputResponseHeaders, recordPwaInput } from "@/lib/pwa-input";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return historyResponse({ history: await getHistoryFromRequest(request) });
  } catch (error) {
    return historyFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const count = await recordPwaInput(request);
    return Response.json({ count }, { headers: pwaInputResponseHeaders });
  } catch (error) {
    const message = error instanceof PwaInputError ? error.message : "Transaksi belum bisa disimpan. Coba lagi.";
    const status = error instanceof PwaInputError ? error.status : 503;
    return Response.json({ error: message }, { status, headers: pwaInputResponseHeaders });
  }
}
