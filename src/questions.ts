/**
 * 質問5問と正解列（docs/experiment-design-v1.md §3）。
 * 正解値はすべて 2026-09-03 に実データで確認済み。
 */

export interface Question {
  id: string;
  prompt: string;
  /** 正解のツール列（順序を含む） */
  expectedTools: string[];
  /** 最終回答に現れるべき数値。null は数値ではなく文字列一致で見る */
  expectedValue: number | null;
  /** 無音の失敗の典型値。ここに一致したら × 確定 */
  silentWrongValues: number[];
  /** 何を見るための問いか */
  targets: string;
  notes: string;
}

export const QUESTIONS: Question[] = [
  {
    id: "Q1",
    prompt: "東京都のバス停のデータは何件ありますか？件数だけ教えてください。",
    expectedTools: ["search_by_attribute"],
    expectedValue: 2,
    silentWrongValues: [959],
    targets: "★1 存在しない引数が黙って捨てられる",
    notes:
      "search(term='バス停', prefecture_code='13') は全国959件を返す。" +
      "prefecture_code は inputSchema に無く、pydantic の extra='ignore' で消える。約480倍。",
  },
  {
    id: "Q2",
    prompt:
      "橋梁のデータは全国で何件ありますか？データそのものは要りません、件数だけです。",
    expectedTools: ["get_count_data"],
    expectedValue: 748706,
    silentWrongValues: [10000],
    targets: "追補1 search の totalNumber が 10000 で頭打ち + 決定2",
    notes:
      "search(term='橋梁') の totalNumber は 10000 で頭打ち（真値 748,706 の約74分の1）。" +
      "モードB には get_count_data が無いため、必ず罠に落ちる想定。",
  },
  {
    id: "Q3",
    prompt: "千代田区にあるデータを検索して、件数を教えてください。",
    expectedTools: ["normalize_codes", "search_by_attribute"],
    expectedValue: 3086,
    silentWrongValues: [115],
    targets: "追補2・3 市区町村コードの5桁/6桁",
    notes:
      "normalize_codes(prefecture='東京都', municipality='千代田区') → 131016 が正しい。" +
      "ツール説明の例 '13101'(5桁) を使うと115件。どちらもエラーにならない。27倍。" +
      "市区町村名だけで normalize_codes を呼ぶと null + warnings（有音）。",
  },
  {
    id: "Q4",
    prompt:
      "東京駅（緯度35.681236、経度139.767125）から半径500m以内にあるデータは何件ありますか？",
    expectedTools: ["search_by_location_point_distance"],
    expectedValue: 668,
    silentWrongValues: [],
    targets: "★2 位置検索の prefecture_code が無視される / ★3 記述の矛盾",
    notes:
      "term を省略しても term='' でも 668 件。位置単独での検索は可能。" +
      "prefecture_code を併せて渡しても無視される（モードA′ ではスキーマから削除済み）。",
  },
  {
    id: "Q5",
    prompt:
      "データセット nlni_ksj-p14 の中のデータを1件選んで、そのタイトルだけ教えてください。詳細情報は要りません。",
    expectedTools: ["search_by_attribute", "get_data_summary"],
    expectedValue: null,
    silentWrongValues: [],
    targets: "get_data vs get_data_summary（required が同一で引数から区別できない）",
    notes:
      "get_data_summary のレスポンスは約114文字、get_data は約1,377文字（12倍）。" +
      "答えは合うが無駄。補助指標（受信文字数）で差を見る。",
  },
];

export function getQuestion(id: string): Question {
  const q = QUESTIONS.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!q) {
    throw new Error(
      `質問 ${id} は存在しません。使えるのは: ${QUESTIONS.map((x) => x.id).join(", ")}`,
    );
  }
  return q;
}
