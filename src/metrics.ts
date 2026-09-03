import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { McpTool } from "./mcp-client.js";
import { MODEL, RAW_DIR, TOOL_COSTS_PATH } from "./config.js";
import type { Mode, RewriteRecord } from "./tool-gate.js";
import type { Question } from "./questions.js";

/**
 * ○ = 正解 / △ = 有音の失敗 / × = 無音の失敗（設計 §4-2）
 * 未解決 = ターン上限で打ち切り / 要確認 = 機械判定できず人手が要る
 *
 * 「要確認」は後から足した。機械判定できないものを × に倒すと
 * 無音の失敗を過大に数えることになり、実験の結論が狂うため。
 */
export type Verdict = "○" | "△" | "×" | "未解決" | "要確認";

export interface TurnRecord {
  turn: number;
  toolCalls: { name: string; input: unknown; isError: boolean; resultChars: number }[];
  inputTokens: number;
  outputTokens: number;
}

export interface SessionRecord {
  mode: Mode;
  questionId: string;
  model: string;
  startedAt: string;
  /** このモードで実際に送ったツール定義のトークン数（countTokens 実測） */
  toolDefTokens: number;
  toolNames: string[];
  rewrites: RewriteRecord[];
  turns: TurnRecord[];
  turnCount: number;
  totalToolResultChars: number;
  finalAnswer: string;
  extractedValue: number | null;
  expectedValue: number | null;
  verdict: Verdict;
  verdictReason: string;
  sawToolError: boolean;
  /** モードC で選ばれた群 */
  selectedGroups?: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ---------------------------------------------------------------------------
// ツール定義のトークン量を実測する
// ---------------------------------------------------------------------------

export interface ToolCosts {
  model: string;
  measuredAt: string;
  /** ツールを1つも渡さないときのベースライン */
  baseline: number;
  /**
   * ツール名 → そのツール**単体**を渡したときの増分。
   *
   * 注意: これは「ツール1個ぶんの大きさ」ではない。1個だけ渡しても
   * tools ブロック自体の固定オーバーヘッドが乗るため、単体値の総和は
   * まとめて渡したときの実測値より大きくなる（実測で約1.29倍）。
   * **順位付けには使えるが、部分集合のコスト見積りに足し算してはいけない。**
   */
  perTool: Record<string, number>;
  /** 全18個をまとめて渡したときの合計増分 */
  allToolsTotal: number;
  /** 単体値の総和。allToolsTotal との差が固定オーバーヘッドの重なり分 */
  perToolSum: number;
}

const PROBE_MESSAGES: Anthropic.MessageParam[] = [
  { role: "user", content: "ping" },
];

function toAnthropicTool(t: McpTool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  };
}

/**
 * countTokens でツール定義のトークン量を測る。
 *
 * tiktoken は使わない。OpenAI のトークナイザなので Claude では 15〜20% ずれ、
 * 日本語ではさらに大きくずれる。
 */
export async function measureToolCosts(
  client: Anthropic,
  tools: McpTool[],
): Promise<ToolCosts> {
  const count = async (ts: McpTool[]): Promise<number> => {
    const res = await client.messages.countTokens({
      model: MODEL,
      messages: PROBE_MESSAGES,
      ...(ts.length ? { tools: ts.map(toAnthropicTool) } : {}),
    });
    return res.input_tokens;
  };

  const baseline = await count([]);
  const allToolsTotal = (await count(tools)) - baseline;

  const perTool: Record<string, number> = {};
  for (const t of tools) {
    perTool[t.name] = (await count([t])) - baseline;
  }
  const perToolSum = Object.values(perTool).reduce((a, b) => a + b, 0);

  return {
    model: MODEL,
    measuredAt: new Date().toISOString(),
    baseline,
    perTool,
    allToolsTotal,
    perToolSum,
  };
}

/**
 * 指定した部分集合を実際に渡したときのトークン増分を1回で測る。
 *
 * 単体値の足し算では固定オーバーヘッドを重複して数えてしまうので、
 * 予算判定はこちらの実測を使う。
 */
export async function measureSubset(
  client: Anthropic,
  tools: McpTool[],
  names: string[],
  baseline: number,
): Promise<number> {
  const subset = tools.filter((t) => names.includes(t.name));
  if (subset.length === 0) return 0;
  const res = await client.messages.countTokens({
    model: MODEL,
    messages: PROBE_MESSAGES,
    tools: subset.map(toAnthropicTool),
  });
  return res.input_tokens - baseline;
}

export function saveToolCosts(costs: ToolCosts): void {
  fs.mkdirSync(path.dirname(TOOL_COSTS_PATH), { recursive: true });
  fs.writeFileSync(TOOL_COSTS_PATH, JSON.stringify(costs, null, 2), "utf-8");
}

export function loadToolCosts(): ToolCosts {
  if (!fs.existsSync(TOOL_COSTS_PATH)) {
    throw new Error(
      [
        `ツール定義のトークン実測値がありません: ${TOOL_COSTS_PATH}`,
        `先に次を実行してください:`,
        `  npm run tools -- --measure`,
        `（ANTHROPIC_API_KEY が必要です）`,
      ].join("\n"),
    );
  }
  return JSON.parse(fs.readFileSync(TOOL_COSTS_PATH, "utf-8")) as ToolCosts;
}

// ---------------------------------------------------------------------------
// 採点
// ---------------------------------------------------------------------------

/**
 * 本文中に数値 n が「数として」現れるか。3,086 のようなカンマ区切りにも対応し、
 * 桁の一部（30861 の中の 3086）には誤ヒットしないようにする。
 */
export function containsValue(text: string, n: number): boolean {
  const plain = String(n);
  const grouped = n.toLocaleString("en-US");
  for (const form of new Set([plain, grouped])) {
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\d,.])${esc}(?![\\d,.])`).test(text)) return true;
  }
  return false;
}

/**
 * 「答えとして提示された数値」を拾う。
 *
 * 単純に最初の数値を採ると、箇条書きの "1)" や見出し番号を拾って誤判定する
 * （実際に modeB×Q2 で "**1) 全国一括検索**" の 1 を答えと誤認し、
 * 正しく上限を報告していた回答を「無音の失敗」と誤判定した）。
 */
export function extractNumber(text: string, expected: number | null): number | null {
  if (expected !== null && containsValue(text, expected)) return expected;

  // 箇条書き/見出しの序数を落とす
  const cleaned = text
    .replace(/^\s*[*#>-]*\s*\**\d+[).、.]\s*/gm, " ")
    .replace(/^\s*#+\s.*$/gm, " ");

  const candidates = [...cleaned.matchAll(/(?<![\d,.])\d[\d,]*(?![\d,.])/g)]
    .map((m) => Number(m[0].replaceAll(",", "")))
    .filter((n) => Number.isFinite(n) && n >= 10); // 一桁の序数・脚注番号は答えとみなさない

  return candidates[0] ?? null;
}

/** モデルが「確たる答えを出せない」旨を明示しているか */
const HEDGE = /確定できません|特定できません|わかりません|分かりません|不明|上限|頭打ち|少なくとも|以上存在|正確な件数|概算|推定|できませんでした|取得できません/;

export function judge(
  question: Question,
  extracted: number | null,
  sawToolError: boolean,
  finalAnswer: string,
  hitMaxTurns: boolean,
): { verdict: Verdict; reason: string } {
  if (hitMaxTurns) {
    return { verdict: "未解決", reason: "最大ターン数に達して打ち切り" };
  }

  // Q5 は数値ではなくタイトル文字列で見る
  if (question.expectedValue === null) {
    if (finalAnswer.trim().length === 0) {
      return { verdict: "要確認", reason: "回答が空" };
    }
    if (sawToolError) {
      return { verdict: "△", reason: "エラーは出たが回答には到達した" };
    }
    return { verdict: "○", reason: "タイトルを回答（人手確認の対象）" };
  }

  if (containsValue(finalAnswer, question.expectedValue)) {
    return { verdict: "○", reason: `正解値 ${question.expectedValue} を回答に含む` };
  }

  const hedged = HEDGE.test(finalAnswer);
  const assertedWrong = question.silentWrongValues.filter((v) =>
    containsValue(finalAnswer, v),
  );

  // × は「誤った値を、限界に触れずに答えとして提示した」場合だけに限定する。
  // 迷ったら × にしない。無音の失敗を過大に数えると実験の結論そのものが狂う。
  if (assertedWrong.length > 0 && !hedged) {
    return {
      verdict: "×",
      reason: `無音の失敗: ${assertedWrong[0]} を正しい値として回答（正解は ${question.expectedValue}）`,
    };
  }

  if (assertedWrong.length > 0 && hedged) {
    return {
      verdict: "△",
      reason: `${assertedWrong[0]} に触れつつ、限界を明示して答えを保留（有音）`,
    };
  }

  if (sawToolError) {
    return {
      verdict: "△",
      reason: `ツールエラーが出た状態で正解値に到達せず（回答 ${extracted ?? "なし"}）`,
    };
  }

  if (hedged) {
    return {
      verdict: "△",
      reason: "限界を明示したうえで確定値を出さなかった（有音の失敗）",
    };
  }

  return {
    verdict: "要確認",
    reason: `正解値にも既知の誤答値にも一致せず（回答 ${extracted ?? "なし"} / 正解 ${question.expectedValue}）。人手で確認すること`,
  };
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

export function saveSession(rec: SessionRecord): string {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `${rec.mode}_${rec.questionId}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf-8");
  return file;
}

export function loadAllSessions(): SessionRecord[] {
  if (!fs.existsSync(RAW_DIR)) return [];
  return fs
    .readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), "utf-8")) as SessionRecord,
    );
}
