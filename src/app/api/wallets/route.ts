import {
  applyWalletActionFromRequest,
  getWalletsFromRequest,
  walletFailure,
  walletResponse,
} from "@/lib/wallet-management";

export async function GET(request: Request) {
  try {
    return walletResponse({ overview: await getWalletsFromRequest(request) });
  } catch (error) {
    return walletFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    return walletResponse(await applyWalletActionFromRequest(request));
  } catch (error) {
    return walletFailure(error);
  }
}
