import Anthropic from "@anthropic-ai/sdk";
import type { DpfMcpClient, McpTool } from "./mcp-client.js";
import { MAX_TURNS, MODEL } from "./config.js";
import {
  GROUP_NAMES,
  TOOL_GROUPS,
  gate,
  type GroupName,
  type Mode,
} from "./tool-gate.js";
import type { Question } from "./questions.js";
import {
  extractNumber,
  judge,
  type SessionRecord,
  type ToolCosts,
  type TurnRecord,
} from "./metrics.js";

const SYSTEM_PROMPT = [
  "あなたは国土交通データプラットフォーム(DPF)のデータを調べるアシスタントです。",
  "与えられたツールだけを使って質問に答えてください。",
  "件数を聞かれた場合は、最終回答に件数の数値を必ず含めてください。",
  "推測で数値を答えてはいけません。ツールの結果に基づいて答えてください。",
  "出典: 国土交通データプラットフォーム (CC BY 4.0)",
].join("\n");

/** モードC の第1段で使う擬似ツール */
const SELECTOR_TOOL: Anthropic.Tool = {
  name: "select_tool_group",
  description: [
    "作業に必要なツール群を選ぶ。最初に必ず1回呼ぶこと。",
    "選んだ群のツールだけが以降で使えるようになる。",
    "",
    "群の一覧:",
    "- 検索: キーワード/属性/位置でデータを探す",
    "- 詳細取得: ID が分かっているデータやカタログの中身を取る",
    "- 集計・一括: 件数を数える、大量データを一括で取る",
    "- ダウンロード: ファイルやサムネイルのURLを取る",
    "- 地域コード: 都道府県名・市区町村名をコードに正規化する",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: { type: "string", enum: GROUP_NAMES },
        description: "必要な群の名前。複数選択可",
      },
    },
    required: ["groups"],
  },
};

function toAnthropicTool(t: McpTool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  };
}

export interface RunOptions {
  anthropic: Anthropic;
  mcp: DpfMcpClient;
  allTools: McpTool[];
  costs: ToolCosts;
  mode: Mode;
  question: Question;
  /** モードB で使うツール名（起動時に1度だけ決める） */
  modeBTools: string[];
  /**
   * ツール集合を実際に渡したときのトークン増分を実測する。
   *
   * **必ず「実際に送った定義」を渡すこと。** モードA′ は書き換え後の定義を送るので、
   * 生の定義で測ると書き換えの効果が 0 に見えてしまう。
   */
  measureSubset: (tools: McpTool[], names: string[]) => Promise<number>;
  verbose?: boolean;
}

export async function runSession(opts: RunOptions): Promise<SessionRecord> {
  const { anthropic, mcp, allTools, mode, question, verbose } = opts;

  const startedAt = new Date().toISOString();
  const turns: TurnRecord[] = [];
  let sawToolError = false;
  let totalToolResultChars = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let selectedGroups: GroupName[] | undefined;

  // モードC は最初セレクタだけ、それ以外は最初から確定
  let gateResult = gate(allTools, mode, opts.modeBTools, mode === "c" ? [] : undefined);
  let activeTools: Anthropic.Tool[] =
    mode === "c" ? [SELECTOR_TOOL] : gateResult.tools.map(toAnthropicTool);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question.prompt },
  ];

  let finalAnswer = "";
  let hitMaxTurns = false;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: activeTools,
      messages,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    const turnRec: TurnRecord = {
      turn,
      toolCalls: [],
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    if (response.stop_reason === "refusal") {
      finalAnswer = "(モデルが応答を拒否しました)";
      turns.push(turnRec);
      break;
    }

    const textOf = (msg: Anthropic.Message) =>
      msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

    if (response.stop_reason === "end_turn") {
      finalAnswer = textOf(response);
      turns.push(turnRec);
      break;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      finalAnswer = textOf(response);
      turns.push(turnRec);
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      // モードC の第1段: 群を選ばせる
      if (use.name === SELECTOR_TOOL.name) {
        const input = use.input as { groups?: string[] };
        const picked = (input.groups ?? []).filter((g): g is GroupName =>
          (GROUP_NAMES as string[]).includes(g),
        );
        selectedGroups = picked;
        gateResult = gate(allTools, mode, opts.modeBTools, picked);
        activeTools = gateResult.tools.map(toAnthropicTool);

        const names = picked.flatMap((g) => [...TOOL_GROUPS[g]]);
        const body =
          picked.length === 0
            ? "群が選ばれませんでした。もう一度 select_tool_group を呼んでください。"
            : `以下のツールが使えるようになりました: ${names.join(", ")}`;
        results.push({ type: "tool_result", tool_use_id: use.id, content: body });
        turnRec.toolCalls.push({
          name: use.name,
          input: use.input,
          isError: false,
          resultChars: body.length,
        });
        if (verbose) console.log(`  [${turn}] select_tool_group -> ${picked.join(", ")}`);
        continue;
      }

      const outcome = await mcp.callTool(
        use.name,
        (use.input ?? {}) as Record<string, unknown>,
      );
      if (outcome.isError) sawToolError = true;
      totalToolResultChars += outcome.text.length;

      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: outcome.text || "(空のレスポンス)",
        is_error: outcome.isError,
      });
      turnRec.toolCalls.push({
        name: use.name,
        input: use.input,
        isError: outcome.isError,
        resultChars: outcome.text.length,
      });
      if (verbose) {
        console.log(
          `  [${turn}] ${use.name}(${JSON.stringify(use.input)}) -> ${outcome.isError ? "ERROR " : ""}${outcome.text.length} chars`,
        );
      }
    }

    messages.push({ role: "user", content: results });
    turns.push(turnRec);

    if (turn === MAX_TURNS) hitMaxTurns = true;
  }

  const extractedValue = extractNumber(finalAnswer, question.expectedValue);
  const { verdict, reason } = judge(
    question,
    extractedValue,
    sawToolError,
    finalAnswer,
    hitMaxTurns,
  );

  // 実際に送ったツール定義の実測トークン（モードC は最終的に有効だった集合）。
  // 単体値の足し算では固定オーバーヘッドを重複計上するので、集合として測り直す。
  const finalToolNames = activeTools.map((t) => t.name);
  const toolDefTokens = await opts.measureSubset(
    gateResult.tools,
    finalToolNames.filter((n) => n !== SELECTOR_TOOL.name),
  );

  return {
    mode,
    questionId: question.id,
    model: MODEL,
    startedAt,
    toolDefTokens,
    toolNames: finalToolNames,
    rewrites: gateResult.rewrites,
    turns,
    turnCount: turns.length,
    totalToolResultChars,
    finalAnswer,
    extractedValue,
    expectedValue: question.expectedValue,
    verdict,
    verdictReason: reason,
    sawToolError,
    selectedGroups,
    totalInputTokens,
    totalOutputTokens,
  };
}
