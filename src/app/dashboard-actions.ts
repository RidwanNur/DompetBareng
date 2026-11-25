"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { parseWorkspaceAction, updateWorkspaceState } from "@/lib/workspaces";

type SelectionFeedback = { error?: string };

export async function selectDashboardWorkspace(
  _previous: SelectionFeedback,
  formData: FormData,
): Promise<SelectionFeedback> {
  if (!(await getCurrentUser())) redirect("/login");

  const action = parseWorkspaceAction({ action: "select", workspace_id: formData.get("workspaceId") });
  if (!action) return { error: "Pilihan ruang tidak valid." };

  try {
    const result = await updateWorkspaceState(action);
    if (!result.state) return { error: "Anda tidak tergabung dalam ruang ini." };
    refresh();
    return {};
  } catch {
    return { error: "Ruang aktif belum bisa diganti. Coba lagi." };
  }
}
