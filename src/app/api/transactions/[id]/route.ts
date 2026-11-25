import { changeHistoryTransaction, historyFailure, historyResponse } from "@/lib/history";

type TransactionRouteContext = { params: Promise<{ id: string }> };

async function mutate(request: Request, { params }: TransactionRouteContext, action: "update" | "delete") {
  try {
    const { id } = await params;
    await changeHistoryTransaction(request, id, action);
    return historyResponse({ ok: true });
  } catch (error) {
    return historyFailure(error);
  }
}

export function PATCH(request: Request, context: TransactionRouteContext) {
  return mutate(request, context, "update");
}

export function DELETE(request: Request, context: TransactionRouteContext) {
  return mutate(request, context, "delete");
}
