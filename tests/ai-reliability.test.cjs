const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { after, beforeEach, test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const workspace = "90000000-0000-0000-0000-000000000001";
const account = "90000000-0000-0000-0000-000000000002";
const claimToken = "90000000-0000-0000-0000-000000000003";
const userId = 100001;
const origin = "https://fixture.example.test";
const secret = "fixture-webhook-secret";
const apiKey = "fixture-gemini-key";
const month = "2026-11";
const analysis = { narrative: "Arus kas bulan ini surplus.", suggestions: ["Rencanakan belanja mingguan.", "Periksa persediaan sebelum membeli."] };
const draft = [{ item: "Kopi", amount: "15000", type: "expense", category: "Makan & Minum", wallet_type: "cash" }];

const sampleReport = {
  workspace_id: workspace, month, transaction_count: 2, total_income: "100000", total_expense: "25000",
  net_cash_flow: "75000", expense_ratio_percent: "25", health_status: "Sehat",
  largest_expense: { category: "Makan & Minum", total: "25000" },
  category_totals: [{ type: "expense", category: "Makan & Minum", total: "25000" }], wallet_balances: [],
  analysis: null, analysis_stale: false, analysis_source: null, analysis_fingerprint: "a".repeat(64),
  analysis_updated_at: null, analysis_retry_at: null,
};

let provider;
let rpc;
let providerCalls;
let rpcCalls;
const previousLoad = Module._load;
const previousTs = require.extensions[".ts"];
const previousFetch = global.fetch;
const config = {
  GEMINI_MODEL_ANALYSIS: "fixture-analysis",
  GEMINI_MODEL_FALLBACKS: "fixture-backup",
  GEMINI_MODEL_FAST: "fixture-fast",
  GEMINI_API_KEY: apiKey,
  TELEGRAM_WEBHOOK_SECRET: secret,
};
const originalEnv = Object.fromEntries([...Object.keys(config), "TELEGRAM_DAILY_AI_LIMIT"].map((key) => [key, process.env[key]]));

function databaseRpc(role) {
  return async (name, args) => {
    rpcCalls.push({ role, name, args });
    return { data: await rpc(role, name, args), error: null };
  };
}

Module._load = function resolveFixture(name, ...args) {
  if (name === "server-only") return {};
  if (name === "@/lib/supabase/admin") return { createAdminClient: () => ({ rpc: databaseRpc("service") }) };
  if (name === "@/lib/supabase/server") return { createClient: async () => ({ rpc: databaseRpc("member") }) };
  if (name === "@/lib/auth") return { getAppOrigin: async () => origin, getCurrentUser: async () => ({ id: account }), isSupabaseConfigured: () => true };
  const filename = name.startsWith("@/") ? path.join(root, "src", name.slice(2) + ".ts") : name;
  return previousLoad.call(this, filename, ...args);
};

require.extensions[".ts"] = (module, filename) => {
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions }).outputText, filename);
};

const { generateMonthlyAnalysis } = require("../src/lib/gemini.ts");
const { POST: monthly } = require("../src/app/api/reports/monthly/route.ts");
const { POST: webhook } = require("../src/app/api/webhook/telegram/route.ts");

beforeEach(() => {
  Object.assign(process.env, config);
  delete process.env.TELEGRAM_DAILY_AI_LIMIT;
  providerCalls = [];
  rpcCalls = [];
  rpc = (_role, name) => { throw new Error(`Unexpected RPC ${name}`); };
  provider = (model) => { throw new Error(`Unexpected Gemini request ${model}`); };
  global.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    const model = /\/models\/([^/:]+):generateContent$/.exec(url.pathname)?.[1];
    assert.ok(model);
    providerCalls.push(model);
    const result = provider(model);
    if (typeof result === "number") {
      return Response.json({ error: { code: result, message: `Upstream ${apiKey}` } }, { status: result });
    }
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(result) }] } }] });
  };
});

after(() => {
  Module._load = previousLoad;
  if (previousTs) require.extensions[".ts"] = previousTs;
  else delete require.extensions[".ts"];
  global.fetch = previousFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function monthlyRequest(manual = false) {
  return new Request(`${origin}/api/reports/monthly`, {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ workspace_id: workspace, month, manual }),
  });
}

function telegramRequest(id, text, token = secret) {
  return new Request(`${origin}/api/webhook/telegram`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": token },
    body: JSON.stringify({ update_id: id, message: {
      message_id: id, date: 1_795_727_600, from: { id: userId, is_bot: false }, chat: { id: userId, type: "private" }, text,
    } }),
  });
}

test("Gemini analysis continues from HTTP 503 and 429 in configured order", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const info = t.mock.method(console, "info", () => {});
  provider = (model) => model === "fixture-analysis" ? 503 : model === "fixture-backup" ? 429 : analysis;

  assert.deepEqual(await generateMonthlyAnalysis(sampleReport), { analysis, modelUsed: "fixture-fast" });
  assert.deepEqual(providerCalls, ["fixture-analysis", "fixture-backup", "fixture-fast"]);
  assert.deepEqual(warnings.mock.calls.map((call) => call.arguments[1].reason), [503, 429]);
  assert.equal(info.mock.calls[0].arguments[1].model, "fixture-fast");
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls), new RegExp(apiKey));
});

test("a valid analysis cache answers without contacting Gemini", async () => {
  const cached = { ...sampleReport, analysis, analysis_source: "ai", analysis_updated_at: "2026-11-26T12:30:00Z" };
  rpc = (_role, name) => {
    assert.equal(name, "begin_monthly_analysis");
    return { status: "cached", report: cached };
  };

  const response = await monthly(monthlyRequest());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).report, cached);
  assert.equal(providerCalls.length, 0);
});

test("all models unavailable persists deterministic analysis for the current report", async (t) => {
  t.mock.method(console, "warn", () => {});
  const noIncome = { ...sampleReport, total_income: "0", net_cash_flow: "-25000", expense_ratio_percent: null, health_status: "Defisit" };
  let saved = null;
  provider = () => 503;
  rpc = (role, name, args) => {
    if (name === "begin_monthly_analysis") return { status: "ready", claim_token: claimToken, report: noIncome };
    if (name === "complete_monthly_analysis") {
      assert.equal(role, "service");
      assert.equal(args.p_source, "fallback");
      assert.equal(args.p_model_used, null);
      assert.equal(args.p_claim_token, claimToken);
      saved = args.p_analysis;
      return true;
    }
    assert.equal(name, "get_monthly_report");
    return { ...noIncome, analysis: saved, analysis_source: "fallback", analysis_updated_at: "2026-11-26T12:30:00Z",
      analysis_retry_at: "2026-11-26T12:35:00Z" };
  };

  const response = await monthly(monthlyRequest());
  assert.equal(response.status, 200);
  const { report } = await response.json();
  assert.equal(report.analysis_source, "fallback");
  assert.match(report.analysis.narrative, /defisit.*Pemasukan belum tercatat.*Makan & Minum/);
  assert.equal(report.analysis.suggestions.length, 2);
  assert.equal(providerCalls.length, 3);
});

test("manual health refresh at its limit returns the cache with HTTP 200", async () => {
  rpc = (_role, name) => {
    assert.equal(name, "begin_monthly_analysis");
    return { status: "rate_limited", report: { ...sampleReport, analysis, analysis_source: "ai" } };
  };
  const response = await monthly(monthlyRequest(true));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).limited, true);
  assert.equal(providerCalls.length, 0);
});

test("Telegram commands bypass extraction and Gemini 503 releases the claim with HTTP 200", async (t) => {
  t.mock.method(console, "warn", () => {});
  let claimed = false;
  provider = () => 503;
  rpc = (_role, name, args) => {
    if (name === "get_telegram_quick_report") {
      const report = { status: "ok", workspace_type: "personal", total_income: "0", total_expense: "0" };
      return args.p_view === "balance" ? { ...report, total_balance: "0", wallets: [] }
        : { ...report, month: args.p_month, net_cash_flow: "0", savings_ratio_percent: null, top_expenses: [] };
    }
    if (name === "begin_telegram_input_in_workspace") {
      assert.equal(args.p_daily_limit, 80);
      assert.equal(args.p_update_id, 3);
      if (claimed) return { status: "duplicate" };
      claimed = true;
      return { status: "ready", claim_token: claimToken };
    }
    assert.equal(name, "release_telegram_input");
    assert.equal(args.p_claim_token, claimToken);
    return null;
  };

  assert.equal((await webhook(telegramRequest(1, "/saldo"))).status, 200);
  assert.equal((await webhook(telegramRequest(2, "/laporan"))).status, 200);
  assert.deepEqual(rpcCalls.map((call) => call.name), ["get_telegram_quick_report", "get_telegram_quick_report"]);
  assert.equal(providerCalls.length, 0);
  const response = await webhook(telegramRequest(3, "Kopi 15rb"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, "Layanan AI sedang sibuk sementara. Silakan kirim ulang pesan ini beberapa saat lagi atau catat lewat PWA.");
  assert.equal((await webhook(telegramRequest(3, "Kopi 15rb"))).status, 200);
  assert.deepEqual(providerCalls, ["fixture-fast", "fixture-backup"]);
  assert.equal(rpcCalls.filter((call) => call.name === "release_telegram_input").length, 1);
});

test("Telegram uses a configured cap of 60 and acknowledges internal errors", async (t) => {
  t.mock.method(console, "warn", () => {});
  process.env.TELEGRAM_DAILY_AI_LIMIT = "60";
  let consumed = 59;
  provider = () => draft;
  t.mock.method(console, "info", () => {});
  rpc = (_role, name, args) => {
    if (name === "begin_telegram_input_in_workspace") {
      assert.equal(args.p_daily_limit, 60);
      if (args.p_update_id === 11) throw new Error("Fixture database is unavailable");
      return consumed < args.p_daily_limit ? { status: "ready", claim_token: claimToken } : { status: "rate_limited" };
    }
    assert.equal(name, "finish_telegram_input");
    consumed++;
    return { status: "saved", transactions: [{ id: claimToken, item: "Kopi", amount: "15000", category: "Makan & Minum",
      workspace_id: workspace, workspace_name: "Pribadi", workspace_type: "personal", wallet_id: account, wallet_name: "Tunai", can_move: false }] };
  };

  assert.equal((await webhook(telegramRequest(9, "Kopi 15rb"))).status, 200);
  assert.equal(consumed, 60);
  const limited = await webhook(telegramRequest(10, "Kopi 15rb"));
  assert.equal(limited.status, 200);
  assert.equal((await limited.json()).text, "Kuota input AI harian Telegram tercapai (60/60). Catat manual lewat PWA atau coba lagi besok.");
  assert.equal((await webhook(telegramRequest(11, "Kopi 15rb"))).status, 200);
  const malformed = new Request(`${origin}/api/webhook/telegram`, {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: "{",
  });
  assert.equal((await webhook(malformed)).status, 200);
  assert.equal((await webhook(telegramRequest(12, "Kopi 15rb", "wrong-secret"))).status, 401);
  assert.equal(providerCalls.length, 1);
});
