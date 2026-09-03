# mcp-lab-mlit

**個人の試作です。** 動作保証はありません。MCP（Model Context Protocol）の構成パターンを
検証する連作 `mcp-lab` の2本目。

- 1本目: [mcp-lab-jma](https://github.com/sasonoda/mcp-lab-jma) — 気象庁 API をラップした MCP **サーバー**
- 2本目（これ）— 国土交通データプラットフォーム MCP を消費する **クライアント/ホスト**

## 何を検証しているか

1本目でこう結論した。

> ツール定義の占有コストを決めるのは、ツールの**数**ではなく定義の**総量**。
> 総量を短く保つ手段は、サーバー側が正規化を引き受けて説明文を短くできる状態を作ること。

2本目はその裏返しを見る。**受け取る側で、相手のツール定義は変更できない**という状況で、
クライアントに何ができるか。

対象は[国土交通データプラットフォーム MCP サーバー](https://github.com/MLIT-DATA-PLATFORM/mlit-dpf-mcp)（α版・ツール18個）。
Anthropic API の `mcp_servers` パラメータはリモート URL のサーバーしか受け付けず、
DPF は stdio のみなので、この経路では消費できない。だから自前でホストを書いている。

### 4条件 × 5問

| 条件 | 渡すツール |
| --- | --- |
| A | 18個そのまま |
| B | トークン予算3,000で絞る |
| C | 二段階（用途群を選ばせてから該当群だけ） |
| A′ | 18個 + 定義の書き換え |

測るのは3つ。ツール定義のトークン量／ツール選択の正誤／解決までのターン数。

正誤は **○（正解）／△（有音の失敗）／×（無音の失敗）の3段階**で採る。
「間違った答えを自信満々に返す」と「エラーが出て気づける」は実害の重さが違うため。

設計の詳細は [docs/experiment-design-v1.md](docs/experiment-design-v1.md)、
調査の記録は [docs/survey-2026-09-03.md](docs/survey-2026-09-03.md) にある。

## セットアップ

### 1. DPF MCP サーバーを用意する

このリポジトリと**兄弟の位置**に clone する想定。

```bash
git clone https://github.com/MLIT-DATA-PLATFORM/mlit-dpf-mcp
```

```bash
cd mlit-dpf-mcp && uv venv --python 3.12 && uv pip install -e .
```

> **`pip install -e .` だけにすること。**
> DPF の README 手順4の2行目（`pip install ... mcp ...`）はバージョン無指定で、
> `pyproject.toml` の `mcp>=1.2,<2.0` を上書きして 2.x を入れてしまう。
> MCP Python SDK 2.0 で `@server.list_tools()` が無くなったため、import 時点で落ちる。
> 詳細は [docs/survey-2026-09-03.md](docs/survey-2026-09-03.md) §5-1。

別の場所に置く場合は `.env` の `MLIT_MCP_DIR` / `MLIT_MCP_PYTHON` で指定する。

### 2. 鍵を設定する

```bash
cp .env.example .env
```

- `MLIT_API_KEY` — [国土交通データプラットフォーム](https://data-platform.mlit.go.jp/api_docs/usage/introduction.html)で取得
- `ANTHROPIC_API_KEY` — 実験の実行に必要（`tools` コマンドだけなら不要）

### 3. 依存をインストールする

```bash
npm install
```

## 使い方

ツール18個をダンプする（Anthropic の鍵は不要）。

```bash
npm run tools
```

ツール定義のトークン量を実測して `experiments/tool-costs.json` に保存する。
モードB の予算判定はこの実測値を使う。

```bash
npm run tools -- --measure
```

> トークン数は Anthropic の `countTokens` API で測る。tiktoken は使わない
> （OpenAI のトークナイザなので Claude では日本語でとくに大きくずれる）。

実験を回す。

```bash
npm start -- run --mode all --question all
```

モードや質問を絞る場合。

```bash
npm start -- run --mode a-prime --question Q1
```

ゲートの出力だけ確認する（モードA/A′/C は鍵なしで見られる）。

```bash
npx tsx src/index.ts gate --mode a-prime
```

レポートを生成する。

```bash
npm run report
```

## 構成

```
src/
├─ index.ts        CLI エントリ
├─ mcp-client.ts   DPF MCP を stdio で子プロセス起動
├─ tool-gate.ts    ★ 実験の本体。第1段=書き換え / 第2段=選択
├─ agent-loop.ts   tool calling ループ（最大8ターン）
├─ metrics.ts      トークン実測・採点・保存
├─ questions.ts    質問5問と正解列
└─ report.ts       experiments/report.html を生成
```

`tool-gate.ts` は**書き換えと選択を別の段に分けている**。混ぜると
「絞ったから良くなった」のか「書き換えたから良くなった」のかが測れなくなるため。

## v1 でやらないこと

- ファイルの実ダウンロード（URL 取得まで）
- 対話画面、地図表示、会話履歴の永続化
- 複数 MCP を束ねること
- 公開・デプロイ（ローカル実行のみ）

## 出典・ライセンス

- データ: [国土交通データプラットフォーム](https://data-platform.mlit.go.jp/)（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja)）
- 本リポジトリのコード: MIT

本リポジトリは個人の試作であり、国土交通省とは無関係です。
DPF MCP サーバー自体もα版であり、予告なく変更・削除される可能性があります。
