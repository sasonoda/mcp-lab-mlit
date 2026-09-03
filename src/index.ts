import Anthropic from "@anthropic-ai/sdk";
import { DpfMcpClient, type McpTool } from "./mcp-client.js";
import { QUESTIONS, getQuestion } from "./questions.js";
import {
  hasAnthropicCredentials,
  MODE_B_BUDGET,
  MODEL,
} from "./config.js";
import {
  extractNumber,
  judge,
  loadAllSessions,
  loadToolCosts,
  measureToolCosts,
  measureSubset,
  saveSession,
  saveToolCosts,
} from "./metrics.js";
import { gate, rewriteTools, selectForModeB, type Mode } from "./tool-gate.js";
import { runSession } from "./agent-loop.js";
import { writeReport } from "./report.js";

const MODES: Mode[] = ["a", "b", "c", "a-prime"];

function usage(): void {
  console.log(
    [
      "mcp-lab-mlit — DPF MCP を消費するクライアント/ホストの実験",
      "",
      "使い方:",
      "  npm run tools                    ツール18個をダンプする（Anthropic キー不要）",
      "  npm run tools -- --measure       ツール定義のトークン量を実測して保存する",
      "  npm start -- run --mode a --question Q1",
      "  npm start -- run --mode all --question all",
      "  npm run report                   experiments/report.html を生成する",
      "",
      `モード: ${MODES.join(" | ")} | all`,
      `質問:   ${QUESTIONS.map((q) => q.id).join(" | ")} | all`,
      "",
      "モードの意味は docs/experiment-design-v1.md §2 を参照。",
    ].join("\n"),
  );
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function cmdTools(argv: string[]): Promise<void> {
  const measure = argv.includes("--measure");
  const mcp = new DpfMcpClient();
  await mcp.connect();
  try {
    console.log(`接続しました: ${JSON.stringify(mcp.serverInfo)}`);
    console.log(`交渉されたプロトコル版: ${mcp.negotiatedProtocolVersion}`);

    const tools = await mcp.listTools();
    console.log(`ツール数: ${tools.length}`);

    const extraKeys = new Set<string>();
    for (const t of tools) {
      for (const k of Object.keys(t)) {
        if (!["name", "description", "inputSchema"].includes(k)) extraKeys.add(k);
      }
    }
    console.log(
      `name/description/inputSchema 以外のキー: ${extraKeys.size ? [...extraKeys].join(", ") : "なし（ttlMs / cacheScope は来ない）"}`,
    );

    for (const t of tools) {
      const props = Object.keys(
        (t.inputSchema["properties"] ?? {}) as Record<string, unknown>,
      );
      const req = (t.inputSchema["required"] ?? []) as string[];
      console.log(
        `  ${t.name.padEnd(36)} 引数${String(props.length).padStart(2)}  required: ${req.length ? req.join(",") : "-"}`,
      );
    }

    if (!measure) {
      console.log("\n--measure を付けるとトークン量を実測します（ANTHROPIC_API_KEY が必要）");
      return;
    }

    if (!hasAnthropicCredentials()) {
      throw new Error(
        "ANTHROPIC_API_KEY が未設定です。.env に設定してから --measure を使ってください。",
      );
    }

    console.log(`\ncountTokens で実測中（model=${MODEL}）…`);
    const anthropic = new Anthropic();
    const costs = await measureToolCosts(anthropic, tools);
    saveToolCosts(costs);

    const rows = Object.entries(costs.perTool).sort((a, b) => b[1] - a[1]);
    console.log(`\nベースライン(ツールなし): ${costs.baseline} tokens`);
    for (const [name, tok] of rows) {
      console.log(`  ${name.padEnd(36)} ${String(tok).padStart(6)}`);
    }
    console.log(`  ${"単体値の総和".padEnd(36)} ${String(costs.perToolSum).padStart(6)}`);
    console.log(`  ${"全18個まとめて（実測）".padEnd(36)} ${String(costs.allToolsTotal).padStart(6)}`);
    console.log(
      `  ※ 単体値には tools ブロックの固定オーバーヘッドが毎回乗るため、` +
        `総和は実測より ${(costs.perToolSum / costs.allToolsTotal).toFixed(2)}倍 大きい。足し算で予算判定してはいけない。`,
    );

    const sel = await selectForModeB(tools, (n) => costs.perTool[n] ?? 0, (names) =>
      measureSubset(anthropic, tools, names, costs.baseline),
    );
    console.log(`\nモードB の選定（予算 ${MODE_B_BUDGET}）:`);
    for (const s of sel.steps) console.log(`  ${s}`);
    console.log(
      `  → ${sel.selected.length}個 / 実測 ${sel.totalTokens} tokens (全体の ${((100 * sel.totalTokens) / costs.allToolsTotal).toFixed(0)}%)`,
    );
  } finally {
    await mcp.close();
  }
}

async function cmdRun(argv: string[]): Promise<void> {
  const modeArg = (arg(argv, "mode") ?? "a").toLowerCase();
  const qArg = arg(argv, "question") ?? "all";
  const verbose = !argv.includes("--quiet");

  const modes: Mode[] =
    modeArg === "all" ? MODES : [modeArg as Mode];
  for (const m of modes) {
    if (!MODES.includes(m)) throw new Error(`不明なモード: ${m}`);
  }
  const questions =
    qArg.toLowerCase() === "all" ? QUESTIONS : [getQuestion(qArg)];

  if (!hasAnthropicCredentials()) {
    throw new Error(
      [
        "ANTHROPIC_API_KEY が未設定です。",
        ".env に ANTHROPIC_API_KEY=... を設定してください。",
      ].join("\n"),
    );
  }

  const costs = loadToolCosts();
  const anthropic = new Anthropic();
  const mcp = new DpfMcpClient();
  await mcp.connect();

  try {
    const allTools = await mcp.listTools();
    console.log(
      `DPF MCP 接続済み / ツール ${allTools.length}個 / プロトコル ${mcp.negotiatedProtocolVersion}`,
    );

    const measure = (toolsForMeasure: McpTool[], names: string[]) =>
      measureSubset(anthropic, toolsForMeasure, names, costs.baseline);

    // モードB の選定は質問に依らないので起動時に1度だけ決める
    const sel = await selectForModeB(
      allTools,
      (n) => costs.perTool[n] ?? 0,
      (names) => measure(allTools, names),
    );
    if (modes.includes("b")) {
      console.log(`\nモードB の選定（予算 ${sel.budget}）:`);
      for (const s of sel.steps) console.log(`  ${s}`);
      console.log(`  → ${sel.selected.length}個 / 実測 ${sel.totalTokens} tokens`);
    }

    for (const mode of modes) {
      for (const question of questions) {
        console.log(`\n=== モード${mode} × ${question.id} ===`);
        console.log(`  ${question.prompt}`);
        const rec = await runSession({
          anthropic,
          mcp,
          allTools,
          costs,
          mode,
          question,
          modeBTools: sel.selected,
          measureSubset: measure,
          verbose,
        });
        const file = saveSession(rec);
        console.log(
          `  判定 ${rec.verdict}  ${rec.verdictReason}`,
        );
        console.log(
          `  ツール定義 ${rec.toolDefTokens} tok / ${rec.turnCount} ターン / 受信 ${rec.totalToolResultChars} 文字`,
        );
        console.log(`  → ${file}`);
      }
    }
  } finally {
    await mcp.close();
  }
}

/** Anthropic キー無しでも動く確認用。ゲートの出力だけ見る */
async function cmdGate(argv: string[]): Promise<void> {
  const mode = (arg(argv, "mode") ?? "b") as Mode;
  const mcp = new DpfMcpClient();
  await mcp.connect();
  try {
    const tools = await mcp.listTools();

    // モードB だけが実測コストを必要とする。A/A′/C は Anthropic の鍵なしで確認できる。
    let modeBTools: string[] = [];
    let costOf: (n: string) => number = () => 0;
    if (mode === "b") {
      const costs = loadToolCosts();
      costOf = (n) => costs.perTool[n] ?? 0;
      const anthropic = new Anthropic();
      const sel = await selectForModeB(tools, costOf, (names) =>
        measureSubset(anthropic, tools, names, costs.baseline),
      );
      modeBTools = sel.selected;
      console.log("選定の経過:");
      for (const s of sel.steps) console.log(`  ${s}`);
      console.log(`  合計 実測 ${sel.totalTokens} / 予算 ${sel.budget}\n`);
    }

    const res = gate(tools, mode, modeBTools, ["検索", "地域コード"]);
    console.log(`モード${mode}: ${res.tools.length}個`);
    for (const t of res.tools) {
      console.log(`  ${t.name.padEnd(36)} ${costOf(t.name) || "-"} tok`);
    }
    if (res.rewrites.length) {
      console.log("\n書き換え:");
      for (const r of res.rewrites) {
        console.log(`  [${r.applied ? "適用" : "対象なし"}] ${r.id} ${r.tool}: ${r.what}`);
      }
    }
  } finally {
    await mcp.close();
  }
}

/**
 * 保存済みセッションを、エージェントを回し直さずに採点し直す。
 *
 * - 判定ロジックを直したとき
 * - toolDefTokens の測り方を直したとき（モードA′ は書き換え後の定義で測る必要がある）
 *
 * finalAnswer やツール呼び出しの記録には一切触らない。生データは不変。
 */
async function cmdRejudge(): Promise<void> {
  const sessions = loadAllSessions();
  if (sessions.length === 0) {
    console.log("experiments/raw/ にセッションがありません。");
    return;
  }
  const costs = loadToolCosts();
  const anthropic = hasAnthropicCredentials() ? new Anthropic() : null;

  const mcp = new DpfMcpClient();
  await mcp.connect();
  try {
    const allTools = await mcp.listTools();
    const rewritten = rewriteTools(allTools).tools;

    for (const s of sessions) {
      const q = QUESTIONS.find((x) => x.id === s.questionId);
      if (!q) continue;

      const before = { verdict: s.verdict, tokens: s.toolDefTokens };

      // 判定のやり直し
      const hitMax = s.verdict === "未解決";
      s.extractedValue = extractNumber(s.finalAnswer, q.expectedValue);
      const { verdict, reason } = judge(
        q,
        s.extractedValue,
        s.sawToolError,
        s.finalAnswer,
        hitMax,
      );
      s.verdict = verdict;
      s.verdictReason = reason;

      // toolDefTokens の測り直し（A′ は書き換え後の定義で測る）
      if (anthropic) {
        const source = s.mode === "a-prime" ? rewritten : allTools;
        const names = s.toolNames.filter((n) => n !== "select_tool_group");
        s.toolDefTokens = await measureSubset(anthropic, source, names, costs.baseline);
      }

      saveSession(s);
      const changed =
        before.verdict !== s.verdict || before.tokens !== s.toolDefTokens;
      console.log(
        `${changed ? "*" : " "} ${s.mode.padEnd(8)} ${s.questionId}  ` +
          `${before.verdict}→${s.verdict}  ${before.tokens}→${s.toolDefTokens} tok`,
      );
      if (changed && before.verdict !== s.verdict) {
        console.log(`    ${s.verdictReason}`);
      }
    }
  } finally {
    await mcp.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  switch (cmd) {
    case "tools":
      return cmdTools(argv);
    case "run":
      return cmdRun(argv);
    case "gate":
      return cmdGate(argv);
    case "rejudge":
      return cmdRejudge();
    case "report":
      return writeReport();
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
