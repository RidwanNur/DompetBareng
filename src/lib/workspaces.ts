import "server-only";

import { isInvitationCode } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceAction, WorkspaceState, WorkspaceType } from "@/types/database";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

const unreadableState = "Data ruang tidak dapat dibaca.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuidPattern.test(value);
}

export function parseWorkspaceAction(value: unknown): WorkspaceAction | null {
  if (!isObject(value)) {
    return null;
  }

  switch (value.action) {
    case "select":
      return isUuid(value.workspace_id)
        ? { action: "select", workspace_id: value.workspace_id }
        : null;
    case "create_invite":
      return { action: "create_invite" };
    case "join":
      return isInvitationCode(value.code) ? { action: "join", code: value.code } : null;
    default:
      return null;
  }
}

function readWorkspace<T extends WorkspaceType>(data: unknown, type: T) {
  if (!isObject(data) || !isUuid(data.id) || data.type !== type || typeof data.name !== "string") {
    throw new Error(unreadableState);
  }
  return { id: data.id, type, name: data.name };
}

function readHousehold(data: unknown): WorkspaceState["household"] {
  if (data === null) {
    return null;
  }
  if (!isObject(data) || typeof data.is_owner !== "boolean" || (data.member_count !== 1 && data.member_count !== 2)) {
    throw new Error(unreadableState);
  }
  return {
    ...readWorkspace(data, "household"),
    is_owner: data.is_owner,
    member_count: data.member_count,
  };
}

function readInvitation(data: unknown): WorkspaceState["invitation"] {
  if (data === null) {
    return null;
  }
  if (
    !isObject(data) ||
    !isInvitationCode(data.code) ||
    typeof data.expires_at !== "string" ||
    !Number.isFinite(Date.parse(data.expires_at))
  ) {
    throw new Error(unreadableState);
  }
  return { code: data.code, expires_at: data.expires_at };
}

async function readWorkspaceState(supabase: SupabaseClient): Promise<WorkspaceState> {
  const { data, error } = await supabase.rpc("get_workspace_state");
  if (error || !isObject(data)) {
    throw new Error(unreadableState);
  }

  const personal = readWorkspace(data.personal, "personal");
  const household = readHousehold(data.household);
  const activeWorkspaceId = data.active_workspace_id;
  if (activeWorkspaceId !== personal.id && (household === null || activeWorkspaceId !== household.id)) {
    throw new Error(unreadableState);
  }

  return {
    personal,
    household,
    active_workspace_id: activeWorkspaceId,
    invitation: household?.is_owner && household.member_count === 1
      ? readInvitation(data.invitation)
      : null,
  };
}

export async function getWorkspaceState(): Promise<WorkspaceState> {
  const supabase = await createClient();
  return readWorkspaceState(supabase);
}

export async function updateWorkspaceState(input: WorkspaceAction) {
  const supabase = await createClient();
  let result;
  switch (input.action) {
    case "select":
      result = await supabase.rpc("set_active_workspace", { p_workspace_id: input.workspace_id });
      break;
    case "create_invite":
      result = await supabase.rpc("issue_household_invite");
      break;
    case "join":
      result = await supabase.rpc("join_household", { p_code: input.code });
      break;
  }

  if (result.error) {
    throw new Error("Perubahan ruang tidak dapat diproses.");
  }

  const status: unknown = result.data;
  switch (status) {
    case "ok":
      return { state: await readWorkspaceState(supabase) } as const;
    case "not_member":
    case "household_full":
    case "not_owner":
    case "invalid_code":
    case "already_household":
    case "household_has_data":
    case "rate_limited":
      return { reason: status } as const;
    default:
      throw new Error("Perubahan ruang tidak dapat diproses.");
  }
}
