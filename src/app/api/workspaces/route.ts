import { getAppOrigin, getCurrentUser, isSupabaseConfigured } from "@/lib/auth";
import { getWorkspaceState, parseWorkspaceAction, updateWorkspaceState } from "@/lib/workspaces";
import type { WorkspaceState } from "@/types/database";

const failures = {
  not_member: { status: 403, error: "Anda tidak tergabung dalam ruang ini." },
  not_owner: { status: 403, error: "Hanya pembuat ruang yang dapat membuat kode undangan." },
  household_full: { status: 409, error: "Ruang Rumah Tangga sudah penuh." },
  invalid_code: { status: 404, error: "Kode undangan tidak valid atau sudah kedaluwarsa." },
  already_household: { status: 409, error: "Anda sudah bergabung di Ruang Rumah Tangga." },
  rate_limited: { status: 429, error: "Terlalu banyak percobaan. Coba lagi nanti." },
};

function reply(body: { state: WorkspaceState } | { error: string }, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function withVerifiedUser(handler: () => Promise<Response>) {
  if (!isSupabaseConfigured()) {
    return reply({ error: "Layanan ruang belum tersedia." }, 503);
  }

  try {
    if (!(await getCurrentUser())) {
      return reply({ error: "Masuk untuk mengelola ruang." }, 401);
    }
    return await handler();
  } catch {
    return reply({ error: "Data ruang tidak dapat diproses. Coba lagi." }, 500);
  }
}

export function GET() {
  return withVerifiedUser(async () => reply({ state: await getWorkspaceState() }));
}

export function POST(request: Request) {
  return withVerifiedUser(async () => {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin !== null && origin !== new URL(request.url).origin && origin !== await getAppOrigin())
    ) {
      return reply({ error: "Permintaan perubahan ruang ditolak." }, 403);
    }

    const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      return reply({ error: "Kirim permintaan dalam format JSON." }, 415);
    }

    const action = parseWorkspaceAction(await request.json().catch(() => null));
    if (!action) {
      return reply({ error: "Permintaan ruang tidak valid." }, 400);
    }

    const outcome = await updateWorkspaceState(action);
    if (outcome.state) {
      return reply({ state: outcome.state });
    }
    const { error, status } = failures[outcome.reason];
    return reply({ error }, status);
  });
}
