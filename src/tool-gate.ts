import type { McpTool } from "./mcp-client.js";
import { MODE_B_BUDGET } from "./config.js";

export type Mode = "a" | "b" | "c" | "a-prime";

/** 用途群（docs/experiment-design-v1.md §2 モードC） */
export const TOOL_GROUPS = {
  検索: [
    "search",
    "search_by_attribute",
    "search_by_location_rectangle",
    "search_by_location_point_distance",
    "get_suggest",
  ],
  詳細取得: [
    "get_data",
    "get_data_summary",
    "get_data_catalog",
    "get_data_catalog_summary",
    "get_mesh",
  ],
  "集計・一括": ["get_count_data", "get_all_data"],
  ダウンロード: [
    "get_file_download_urls",
    "get_zipfile_download_url",
    "get_thumbnail_urls",
  ],
  地域コード: ["get_prefecture_data", "get_municipality_data", "normalize_codes"],
} as const satisfies Record<string, readonly string[]>;

export type GroupName = keyof typeof TOOL_GROUPS;
export const GROUP_NAMES = Object.keys(TOOL_GROUPS) as GroupName[];

export function groupOf(toolName: string): GroupName | undefined {
  return GROUP_NAMES.find((g) =>
    (TOOL_GROUPS[g] as readonly string[]).includes(toolName),
  );
}

// ---------------------------------------------------------------------------
// 第1段: 定義の書き換え（モードA′ のみ）
// ---------------------------------------------------------------------------

/** 1件の書き換えが実際に発火したかを記録する */
export interface RewriteRecord {
  id: string;
  tool: string;
  what: string;
  applied: boolean;
}

const CONTENT_REFERENCE = /:contentReference\[oaicite:\d+\]\{index=\d+\}/g;

/**
 * 渡す前にツール定義を書き換える層。
 *
 * 原則「消す」操作のみ。唯一の追記は search の size 説明（totalNumber の 10000 上限）で、
 * これは削除では表現できないため（docs/experiment-design-v1.md §2 モードA′ の表 #5）。
 */
export function rewriteTools(tools: McpTool[]): {
  tools: McpTool[];
  records: RewriteRecord[];
} {
  const records: RewriteRecord[] = [];
  const out = tools.map((t) => structuredClone(t));

  const find = (name: string) => out.find((t) => t.name === name);
  const note = (id: string, tool: string, what: string, applied: boolean) =>
    records.push({ id, tool, what, applied });

  const props = (t: McpTool | undefined) =>
    (t?.inputSchema?.["properties"] ?? {}) as Record<
      string,
      { description?: string } | undefined
    >;

  // #1 search の term 説明から、存在しない prefecture_code の匂わせを消す（★1）
  {
    const t = find("search");
    const term = props(t)["term"];
    const before = term?.description ?? "";
    const after = before.replace(
      /。属性フィルタ\(prefecture_code等\)のみで検索する場合は空文字列""を設定してください/,
      "。",
    );
    if (term && after !== before) term.description = after;
    note("R1", "search", "term 説明から prefecture_code の言及を削除", after !== before);
  }

  // #2 位置検索の prefecture_code をスキーマから削る（★2: 受け取るが使われない）
  for (const name of [
    "search_by_location_rectangle",
    "search_by_location_point_distance",
  ]) {
    const t = find(name);
    const p = props(t);
    const had = "prefecture_code" in p;
    if (had) delete (t!.inputSchema["properties"] as Record<string, unknown>)["prefecture_code"];
    note("R2", name, "使われない prefecture_code をスキーマから削除", had);
  }

  // #3 search_by_attribute の市区町村コード例を 5桁→6桁 に修正（追補2: 115件 vs 3086件）
  {
    const t = find("search_by_attribute");
    const v = props(t)["attribute_value"];
    const before = v?.description ?? "";
    const after = before.replace(/'13101'/g, "'131016'");
    if (v && after !== before) v.description = after;
    note("R3", "search_by_attribute", "市区町村コード例 13101→131016", after !== before);
  }

  // #4 normalize_codes: 5桁という誤記の訂正と、都道府県が必須である旨の明記（追補2・3）
  {
    const t = find("normalize_codes");
    const before = t?.description ?? "";
    const after = before
      .replace(/市区町村名から5桁コードを取得/, "市区町村名から6桁コードを取得")
      .replace(
        /2\. 市区町村名から6桁コードを取得/,
        "2. 市区町村名から6桁コードを取得（prefecture の同時指定が必須。市区町村名だけでは null が返る）",
      );
    if (t && after !== before) t.description = after;
    note("R4", "normalize_codes", "5桁→6桁の訂正 + prefecture 必須の明記", after !== before);
  }

  // #5 search の size 説明に totalNumber の 10000 上限を追記（追補1。唯一の追記）
  {
    const t = find("search");
    const size = props(t)["size"];
    const before = size?.description ?? "";
    const marker = "totalNumber は 10000 で頭打ち";
    const applied = Boolean(size) && !before.includes(marker);
    if (size && applied) {
      size.description =
        before +
        "。なお本ツールが返す totalNumber は 10000 で頭打ちになるため、" +
        "正確な件数が必要な場合は get_count_data を使うこと";
    }
    note("R5", "search", "totalNumber の 10000 上限を追記（唯一の追記）", applied);
  }

  // #6 ChatGPT の引用マーカー除去（§5-2 で8箇所）
  {
    let hits = 0;
    for (const t of out) {
      const scrub = (s: string | undefined) => {
        if (!s) return s;
        const m = s.match(CONTENT_REFERENCE);
        if (m) hits += m.length;
        return s.replace(CONTENT_REFERENCE, "");
      };
      t.description = scrub(t.description);
      for (const p of Object.values(props(t))) {
        if (p) p.description = scrub(p.description);
      }
    }
    note("R6", "(全ツール)", `引用マーカー :contentReference を ${hits} 箇所除去`, hits > 0);
  }

  // #7 存在しない例示 dataset_id を実在のものに差し替え（追補4）
  {
    let hits = 0;
    for (const t of out) {
      const swap = (s: string | undefined) => {
        if (!s || !s.includes("cals_construction")) return s;
        hits += 1;
        return s.replaceAll("cals_construction", "nlni_ksj-p14");
      };
      t.description = swap(t.description);
      for (const p of Object.values(props(t))) {
        if (p) p.description = swap(p.description);
      }
    }
    note("R7", "(全ツール)", `存在しない例 cals_construction を ${hits} 箇所差し替え`, hits > 0);
  }

  return { tools: out, records };
}

// ---------------------------------------------------------------------------
// 第2段: 選択
// ---------------------------------------------------------------------------

/** 質問群に必要な能力と、それを満たすツール（安い順に評価される） */
const REQUIRED_CAPABILITIES: { capability: string; candidates: string[] }[] = [
  { capability: "keyword-search", candidates: ["search"] },
  { capability: "attribute-search", candidates: ["search_by_attribute"] },
  {
    capability: "location-search",
    candidates: [
      "search_by_location_point_distance",
      "search_by_location_rectangle",
    ],
  },
  { capability: "detail-summary", candidates: ["get_data_summary", "get_data"] },
  { capability: "region-normalize", candidates: ["normalize_codes"] },
];

export interface ModeBSelection {
  selected: string[];
  totalTokens: number;
  budget: number;
  steps: string[];
}

/**
 * モードB の選定ルール（docs/experiment-design-v1.md §2 モードB）。
 *
 * 1. 上限 3,000 tokens
 * 2. 質問群に必要な能力を、能力ごとに「最も安いツール」でカバーする
 * 3. 残った予算を、安いものから順に埋める
 *
 * 結果を見てから動かさないこと。get_count_data(最重量) が落ちるのは
 * 恣意的な選別ではなくこのルールの帰結であり、それ自体が観測対象。
 */
export async function selectForModeB(
  tools: McpTool[],
  /** 順位付け用。単体実測値でよい */
  costOf: (name: string) => number,
  /** 予算判定用。部分集合を実際に渡したときの実測を返すこと */
  measureSubset: (names: string[]) => Promise<number>,
  budget: number = MODE_B_BUDGET,
): Promise<ModeBSelection> {
  const available = new Set(tools.map((t) => t.name));
  const selected: string[] = [];
  const steps: string[] = [];
  let total = 0;

  const tryAdd = async (name: string, label: string): Promise<boolean> => {
    const candidate = [...selected, name];
    const cost = await measureSubset(candidate);
    if (cost > budget) {
      steps.push(`× ${label}: ${name} を足すと ${cost} で予算超過 → 見送り`);
      return false;
    }
    selected.push(name);
    total = cost;
    steps.push(`✓ ${label}: ${name} → 集合の実測 ${cost}`);
    return true;
  };

  for (const { capability, candidates } of REQUIRED_CAPABILITIES) {
    const ordered = candidates
      .filter((c) => available.has(c) && !selected.includes(c))
      .sort((a, b) => costOf(a) - costOf(b));
    for (const c of ordered) {
      if (await tryAdd(c, capability)) break;
    }
  }

  const rest = tools
    .map((t) => t.name)
    .filter((n) => !selected.includes(n))
    .sort((a, b) => costOf(a) - costOf(b));

  for (const name of rest) {
    await tryAdd(name, "余剰枠");
  }

  return { selected, totalTokens: total, budget, steps };
}

export interface GateResult {
  tools: McpTool[];
  rewrites: RewriteRecord[];
}

/**
 * ツール供給口。書き換え（第1段）と選択（第2段）を必ず分ける。
 * 混ぜると A′ の効果が測れなくなる（設計 §6）。
 */
export function gate(
  allTools: McpTool[],
  mode: Mode,
  /** モードB で使うツール名。selectForModeB で起動時に1度だけ決めて渡す */
  modeBTools: string[],
  selectedGroups?: GroupName[],
): GateResult {
  // 第1段
  let tools = allTools;
  let rewrites: RewriteRecord[] = [];
  if (mode === "a-prime") {
    const r = rewriteTools(allTools);
    tools = r.tools;
    rewrites = r.records;
  }

  // 第2段
  if (mode === "a" || mode === "a-prime") {
    return { tools, rewrites };
  }

  if (mode === "b") {
    return {
      tools: tools.filter((t) => modeBTools.includes(t.name)),
      rewrites,
    };
  }

  // mode === "c": 選ばれた群のツールだけ
  const groups = selectedGroups ?? [];
  const names = new Set(groups.flatMap((g) => TOOL_GROUPS[g] as readonly string[]));
  return { tools: tools.filter((t) => names.has(t.name)), rewrites };
}
