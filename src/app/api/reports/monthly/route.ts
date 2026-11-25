import {
  getMonthlyReportFromRequest,
  monthlyReportFailure,
  monthlyReportResponse,
  requestMonthlyAnalysis,
} from "@/lib/monthly-report";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    return monthlyReportResponse({ report: await getMonthlyReportFromRequest(request) });
  } catch (error) {
    return monthlyReportFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const result = await requestMonthlyAnalysis(request);
    return monthlyReportResponse(result, result.busy ? 202 : 200);
  } catch (error) {
    return monthlyReportFailure(error);
  }
}
