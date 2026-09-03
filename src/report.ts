import fs from "node:fs";
import path from "node:path";
import { EXPERIMENTS_DIR, MODE_B_BUDGET } from "./config.js";
import { loadAllSessions, type SessionRecord, type Verdict } from "./metrics.js";
import { QUESTIONS } from "./questions.js";

const MODE_LABEL: Record<string, string> = {
  a: "A（18個そのまま）",
  b: `B（予算${MODE_B_BUDGET}で絞る）`,
  c: "C（二段階）",
  "a-prime": "A′（18個 + 書き換え）",
};
const MODE_ORDER = ["a", "b", "c", "a-prime"];

const VERDICT_CLASS: Record<Verdict, string> = {
  "○": "ok",
  "△": "warn",
  "×": "bad",
  未解決: "none",
  要確認: "warn",
};

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("ja-JP");
}

/**
 * 誤答と正解の比。過大なら「N倍」、過少なら「N分の1」と読める向きで出す。
 * 10,000 対 748,706 を「0.0倍」と出しても何も伝わらないため。
 */
function formatRatio(actual: number | null, expected: number | null): string {
  if (actual === null || expected === null || actual === 0 || expected === 0) {
    return "—";
  }
  const r = actual / expected;
  if (r >= 1) return `${r.toFixed(r >= 10 ? 0 : 1)}倍`;
  const inv = expected / actual;
  return `${inv.toFixed(inv >= 10 ? 0 : 1)}分の1`;
}

export function writeReport(): void {
  const sessions = loadAllSessions();
  if (sessions.length === 0) {
    console.log(
      "experiments/raw/ にセッションがありません。先に `npm start -- run` を実行してください。",
    );
    return;
  }

  const key = (m: string, q: string) => `${m}::${q}`;
  const byKey = new Map<string, SessionRecord>();
  for (const s of sessions) byKey.set(key(s.mode, s.questionId), s);
  const modes = MODE_ORDER.filter((m) => sessions.some((s) => s.mode === m));

  // 1. サマリ表
  const summaryRows = QUESTIONS.map((q) => {
    const cells = modes
      .map((m) => {
        const s = byKey.get(key(m, q.id));
        if (!s) return `<td class="none">—</td>`;
        return `<td class="${VERDICT_CLASS[s.verdict]}" title="${esc(s.verdictReason)}">${s.verdict}</td>`;
      })
      .join("");
    return `<tr><th>${q.id}</th><td class="q">${esc(q.prompt)}</td>${cells}</tr>`;
  }).join("\n");

  // 2. トークン量
  const tokenRows = modes
    .map((m) => {
      const rows = sessions.filter((s) => s.mode === m);
      const avg =
        rows.reduce((sum, s) => sum + s.toolDefTokens, 0) / (rows.length || 1);
      const max = Math.max(...sessions.map((s) => s.toolDefTokens), 1);
      const pct = (100 * avg) / max;
      return `<tr><th>${esc(MODE_LABEL[m] ?? m)}</th><td class="num">${fmt(Math.round(avg))}</td>
        <td class="bar"><span style="width:${pct.toFixed(1)}%"></span></td></tr>`;
    })
    .join("\n");

  // 3. 無音の失敗の一覧（記事の中心図）
  const silent = sessions
    .filter((s) => s.verdict === "×")
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
  const silentRows = silent.length
    ? silent
        .map((s) => {
          const q = QUESTIONS.find((x) => x.id === s.questionId);
          const ratio = formatRatio(s.extractedValue, q?.expectedValue ?? null);
          return `<tr><th>${s.questionId}</th><td>${esc(MODE_LABEL[s.mode] ?? s.mode)}</td>
            <td class="num bad">${s.extractedValue ?? "—"}</td>
            <td class="num ok">${q?.expectedValue ?? "—"}</td>
            <td class="num">${ratio}</td>
            <td>${esc(s.verdictReason)}</td></tr>`;
        })
        .join("\n")
    : `<tr><td colspan="6" class="none">無音の失敗は記録されていません</td></tr>`;

  // 4. ターン数
  const turnRows = QUESTIONS.map((q) => {
    const cells = modes
      .map((m) => {
        const s = byKey.get(key(m, q.id));
        return `<td class="num">${s ? s.turnCount : "—"}</td>`;
      })
      .join("");
    return `<tr><th>${q.id}</th>${cells}</tr>`;
  }).join("\n");

  // 5. モードC の内訳
  const cRows = sessions
    .filter((s) => s.mode === "c")
    .map(
      (s) =>
        `<tr><th>${s.questionId}</th><td>${esc((s.selectedGroups ?? []).join(", ") || "—")}</td>
         <td class="num">${fmt(s.toolDefTokens)}</td><td class="num">${s.turnCount}</td></tr>`,
    )
    .join("\n");

  // 6. A vs A′
  const aVsRows = QUESTIONS.map((q) => {
    const a = byKey.get(key("a", q.id));
    const ap = byKey.get(key("a-prime", q.id));
    if (!a && !ap) return "";
    const diff =
      a && ap ? ap.toolDefTokens - a.toolDefTokens : null;
    return `<tr><th>${q.id}</th>
      <td class="${a ? VERDICT_CLASS[a.verdict] : "none"}">${a?.verdict ?? "—"}</td>
      <td class="${ap ? VERDICT_CLASS[ap.verdict] : "none"}">${ap?.verdict ?? "—"}</td>
      <td class="num">${a ? fmt(a.toolDefTokens) : "—"}</td>
      <td class="num">${ap ? fmt(ap.toolDefTokens) : "—"}</td>
      <td class="num">${diff === null ? "—" : (diff > 0 ? "+" : "") + fmt(diff)}</td></tr>`;
  })
    .filter(Boolean)
    .join("\n");

  const rewrites = sessions.find((s) => s.mode === "a-prime")?.rewrites ?? [];
  const rewriteRows = rewrites.length
    ? rewrites
        .map(
          (r) =>
            `<tr><th>${r.id}</th><td>${esc(r.tool)}</td><td>${esc(r.what)}</td>
             <td class="${r.applied ? "ok" : "none"}">${r.applied ? "適用" : "対象なし"}</td></tr>`,
        )
        .join("\n")
    : `<tr><td colspan="4" class="none">A′ のセッションがありません</td></tr>`;

  // 7. 生ログ
  const rawRows = sessions
    .map(
      (s) =>
        `<tr><td>${esc(MODE_LABEL[s.mode] ?? s.mode)}</td><td>${s.questionId}</td>
         <td class="${VERDICT_CLASS[s.verdict]}">${s.verdict}</td>
         <td><a href="raw/${s.mode}_${s.questionId}.json">raw/${s.mode}_${s.questionId}.json</a></td></tr>`,
    )
    .join("\n");

  const modeHeads = modes.map((m) => `<th>${esc(MODE_LABEL[m] ?? m)}</th>`).join("");

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-lab-mlit 実験結果</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --line:#d8d8d8; --muted:#666;
          --ok:#0a7a3d; --warn:#a86400; --bad:#c02020; --accent:#2b5fa8; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --line:#333; --muted:#999;
            --ok:#4ec97f; --warn:#e0a33c; --bad:#f0736a; --accent:#78a9e8; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.7 system-ui,-apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",Meiryo,sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 1.7rem; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size: 1.1rem; margin:44px 0 12px; padding-bottom:6px; border-bottom:2px solid var(--line); }
  .sub { color:var(--muted); margin:0 0 8px; font-size:.9rem; }
  .scroll { overflow-x:auto; }
  table { border-collapse: collapse; width:100%; font-size:.9rem; }
  th, td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
  thead th { background:color-mix(in srgb, var(--fg) 7%, transparent); font-weight:600; white-space:nowrap; }
  tbody th { background:color-mix(in srgb, var(--fg) 4%, transparent); white-space:nowrap; }
  td.num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
  td.q { color:var(--muted); font-size:.85rem; }
  .ok { color:var(--ok); font-weight:700; }
  .warn { color:var(--warn); font-weight:700; }
  .bad { color:var(--bad); font-weight:700; }
  .none { color:var(--muted); }
  td.bar { width:45%; padding:0 10px; }
  td.bar span { display:block; height:14px; background:var(--accent); border-radius:2px; min-width:2px; }
  .legend { font-size:.85rem; color:var(--muted); margin-top:8px; }
  footer { margin-top:56px; padding-top:14px; border-top:1px solid var(--line);
           font-size:.82rem; color:var(--muted); }
  a { color:var(--accent); }
</style>
</head>
<body><main>

<h1>mcp-lab-mlit 実験結果</h1>
<p class="sub">生成 ${new Date().toLocaleString("ja-JP")} ／ セッション ${sessions.length} 件 ／ model ${esc(sessions[0]?.model ?? "")}</p>

<h2>1. サマリ</h2>
<div class="scroll"><table>
<thead><tr><th>問</th><th>質問</th>${modeHeads}</tr></thead>
<tbody>${summaryRows}</tbody>
</table></div>
<p class="legend"><span class="ok">○</span> 正解　<span class="warn">△</span> 有音の失敗（エラーが出て気づける）　<span class="bad">×</span> 無音の失敗（誤った値を正しいものとして回答）</p>

<h2>2. ツール定義のトークン量（実測・countTokens）</h2>
<div class="scroll"><table>
<thead><tr><th>モード</th><th>平均 tokens</th><th></th></tr></thead>
<tbody>${tokenRows}</tbody>
</table></div>

<h2>3. 無音の失敗</h2>
<p class="sub">エラーが出ないまま、誤った値が最終回答に載ったケース。</p>
<div class="scroll"><table>
<thead><tr><th>問</th><th>モード</th><th>回答した値</th><th>正解値</th><th>倍率</th><th>理由</th></tr></thead>
<tbody>${silentRows}</tbody>
</table></div>

<h2>4. 解決までのターン数</h2>
<div class="scroll"><table>
<thead><tr><th>問</th>${modeHeads}</tr></thead>
<tbody>${turnRows}</tbody>
</table></div>

<h2>5. モードC の内訳</h2>
<div class="scroll"><table>
<thead><tr><th>問</th><th>選ばれた群</th><th>ツール定義 tokens</th><th>ターン</th></tr></thead>
<tbody>${cRows || `<tr><td colspan="4" class="none">モードC のセッションがありません</td></tr>`}</tbody>
</table></div>

<h2>6. A と A′ の差分</h2>
<div class="scroll"><table>
<thead><tr><th>問</th><th>A 判定</th><th>A′ 判定</th><th>A tokens</th><th>A′ tokens</th><th>差</th></tr></thead>
<tbody>${aVsRows || `<tr><td colspan="6" class="none">データなし</td></tr>`}</tbody>
</table></div>
<p class="sub" style="margin-top:16px">適用された書き換え:</p>
<div class="scroll"><table>
<thead><tr><th>#</th><th>対象</th><th>操作</th><th>結果</th></tr></thead>
<tbody>${rewriteRows}</tbody>
</table></div>

<h2>7. 生ログ</h2>
<div class="scroll"><table>
<thead><tr><th>モード</th><th>問</th><th>判定</th><th>ファイル</th></tr></thead>
<tbody>${rawRows}</tbody>
</table></div>

<footer>
出典: <a href="https://data-platform.mlit.go.jp/">国土交通データプラットフォーム</a>（<a href="https://creativecommons.org/licenses/by/4.0/deed.ja">CC BY 4.0</a>）<br>
本ページは個人の試作（mcp-lab 2本目）の実験結果であり、国土交通省とは無関係です。
</footer>

</main></body></html>
`;

  fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });
  const out = path.join(EXPERIMENTS_DIR, "report.html");
  fs.writeFileSync(out, html, "utf-8");
  console.log(`レポートを生成しました: ${out}`);
}
