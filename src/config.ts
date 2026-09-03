import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリ直下 */
export const ROOT = path.resolve(here, "..");
export const EXPERIMENTS_DIR =
  process.env.MCP_LAB_EXPERIMENTS_DIR ?? path.join(ROOT, "experiments");
export const RAW_DIR = path.join(EXPERIMENTS_DIR, "raw");
export const TOOL_COSTS_PATH = path.join(EXPERIMENTS_DIR, "tool-costs.json");

/**
 * DPF MCP サーバーの起動設定。
 *
 * 既定は「mcp-lab-mlit と兄弟の位置に mlit-dpf-mcp が clone してあり、
 * その中に venv がある」構成。docs/experiment-design-v1.md §6 と対応。
 *
 * 注意: DPF の README 手順4の2行目（`pip install ... mcp ...`）を実行すると
 * mcp 2.x が入って server.py が import 時に落ちる。`pip install -e .` だけにすること。
 */
const DEFAULT_SERVER_DIR = path.resolve(ROOT, "..", "mlit-dpf-mcp");

export const MCP_SERVER_DIR = process.env.MLIT_MCP_DIR ?? DEFAULT_SERVER_DIR;

export const MCP_SERVER_PYTHON =
  process.env.MLIT_MCP_PYTHON ??
  path.join(MCP_SERVER_DIR, ".venv", "Scripts", "python.exe");

/** POSIX 環境向けの代替パス（Windows のパスが無い場合に使う） */
export const MCP_SERVER_PYTHON_POSIX = path.join(
  MCP_SERVER_DIR,
  ".venv",
  "bin",
  "python",
);

export const MODEL = process.env.MCP_LAB_MODEL ?? "claude-opus-5";

/** 1問あたりの最大ターン数（docs/experiment-design-v1.md §2 共通条件） */
export const MAX_TURNS = Number(process.env.MCP_LAB_MAX_TURNS ?? 8);

/**
 * モードB のトークン予算（docs/experiment-design-v1.md §2 モードB）。
 *
 * 当初 3000 としたが、これは tiktoken の概算値 11,055 に対する約27%だった。
 * countTokens の実測は 16,758 で概算の約1.5倍あり、3000 では3個しか入らず
 * Q3/Q4 が回答不能になる。同じ割合(27.1%)を実測に当てはめて 4500 に再校正した。
 */
export const MODE_B_BUDGET = Number(process.env.MCP_LAB_BUDGET ?? 4500);

export function requireMlitApiKey(): string {
  const key = process.env.MLIT_API_KEY;
  if (!key) {
    throw new Error(
      "MLIT_API_KEY が未設定です。.env に設定してください（.env.example 参照）。",
    );
  }
  return key;
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
