import { changeHistoryTransaction, getTransactionEditor, historyFailure, historyResponse } from "@/lib/history";

type TransactionRouteContext = { params: Promise<{ id: string }> };

async function mutate(request: Request, { params }: TransactionRouteContext, action: "update" | "delete") {
  try {
    const { id } = await params;
    return historyResponse(await changeHistoryTransaction(request, id, action));
  } catch (error) {
    return historyFailure(error);
  }
}

export async function GET(request: Request, { params }: TransactionRouteContext) {
  try {
    const { id } = await params;
    return historyResponse({ editor: await getTransactionEditor(request, id) });
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
