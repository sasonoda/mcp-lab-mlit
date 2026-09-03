import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  MCP_SERVER_DIR,
  MCP_SERVER_PYTHON,
  MCP_SERVER_PYTHON_POSIX,
  requireMlitApiKey,
} from "./config.js";

/** MCP の tools/list が返すツール1件（name / description / inputSchema のみ。§5-3 で確認済み） */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

function resolvePython(): string {
  if (fs.existsSync(MCP_SERVER_PYTHON)) return MCP_SERVER_PYTHON;
  if (fs.existsSync(MCP_SERVER_PYTHON_POSIX)) return MCP_SERVER_PYTHON_POSIX;
  throw new Error(
    [
      `DPF MCP の venv が見つかりません。探した場所:`,
      `  ${MCP_SERVER_PYTHON}`,
      `  ${MCP_SERVER_PYTHON_POSIX}`,
      ``,
      `次の手順で用意してください（docs/experiment-design-v1.md §6）:`,
      `  git clone https://github.com/MLIT-DATA-PLATFORM/mlit-dpf-mcp`,
      `  cd mlit-dpf-mcp && uv venv --python 3.12 && uv pip install -e .`,
      ``,
      `※ README 手順4の2行目 (pip install ... mcp ...) は実行しないこと。`,
      `   mcp 2.x が入り server.py が import 時に落ちます。`,
      ``,
      `別の場所にある場合は .env の MLIT_MCP_DIR / MLIT_MCP_PYTHON で指定できます。`,
    ].join("\n"),
  );
}

/**
 * DPF MCP を stdio で子プロセス起動して繋ぐ。
 *
 * Anthropic API の mcp_servers パラメータはリモート URL のサーバーしか受け付けないため、
 * stdio の DPF はこの経路では消費できない。だから自前でホストを書いている（引き継ぎ資料 §4）。
 */
export class DpfMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private protocolVersion: string | undefined;

  async connect(): Promise<void> {
    const python = resolvePython();
    const apiKey = requireMlitApiKey();

    // 親の環境変数を引き継いだうえで上書きする。
    // 最小構成にすると Windows で APPDATA / TEMP / PATHEXT などが落ち、
    // 子プロセスが起動直後に死んで "Connection closed" だけが残る。
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Anthropic の鍵は DPF サーバーには不要なので渡さない
      if (v !== undefined && !k.startsWith("ANTHROPIC_")) childEnv[k] = v;
    }
    Object.assign(childEnv, {
      MLIT_API_KEY: apiKey,
      MLIT_BASE_URL:
        process.env.MLIT_BASE_URL ?? "https://data-platform.mlit.go.jp/api/v1/",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      // サーバーのログは stderr に出る。stdio(JSON-RPC) は汚さない（§5-1 で確認済み）
      LOG_LEVEL: process.env.MLIT_LOG_LEVEL ?? "WARNING",
    });

    this.transport = new StdioClientTransport({
      command: python,
      args: ["-m", "src.server"],
      cwd: MCP_SERVER_DIR,
      env: childEnv,
      // "ignore" にすると子プロセスが死んだ理由が一切分からなくなる。
      // 握りつぶさず拾って、失敗時にそのまま見せる。
      stderr: "pipe",
    });

    // stderr は start() で子プロセスが spawn された後にしか生えない。
    // connect() が内部で start() を呼ぶので、その直後に横入りして拾う。
    const transport = this.transport;
    const originalStart = transport.start.bind(transport);
    transport.start = async () => {
      await originalStart();
      this.attachStderr();
    };

    // Transport は setProtocolVersion (setter) しか持たず getter が無いので、
    // 交渉結果を横取りして記録する。
    const t = this.transport as Transport;
    const original = t.setProtocolVersion?.bind(t);
    t.setProtocolVersion = (version: string) => {
      this.protocolVersion = version;
      original?.(version);
    };

    this.client = new Client(
      { name: "mcp-lab-mlit", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await this.client.connect(this.transport);
    } catch (err) {
      // 子プロセスが起動直後に死ぬと MCP からは "Connection closed" としか見えない。
      // Python 側の stderr を添えて、何が起きたか分かる形にして投げ直す。
      const detail = this.stderrBuffer.join("").trim();
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        [
          `DPF MCP への接続に失敗しました: ${msg}`,
          ``,
          `起動コマンド: ${python} -m src.server`,
          `作業ディレクトリ: ${MCP_SERVER_DIR}`,
          ``,
          detail
            ? `--- Python 側の stderr ---\n${detail}`
            : `Python 側の stderr は空でした。よくある原因:\n` +
              `  - venv に依存が入っていない → cd ${MCP_SERVER_DIR} && uv pip install -e .\n` +
              `  - mcp 2.x が入っている（README 手順4の2行目を実行した）→ uv pip install "mcp>=1.2,<2.0"`,
        ].join("\n"),
      );
    }
  }

  /** 子プロセスの stderr を保持する（失敗時の診断用。多すぎる場合は末尾だけ残す） */
  private stderrBuffer: string[] = [];

  private attachStderr(): void {
    const stream = this.transport?.stderr;
    if (!stream) return;
    stream.on("data", (chunk: Buffer) => {
      this.stderrBuffer.push(chunk.toString("utf-8"));
      if (this.stderrBuffer.length > 200) this.stderrBuffer.shift();
    });
  }

  /** 直近の Python 側 stderr（デバッグ用） */
  get serverStderr(): string {
    return this.stderrBuffer.join("");
  }

  /** 交渉されたプロトコル版。DPF は要求版をそのまま返す（上限は先方 SDK 次第、実測 2025-11-25） */
  get negotiatedProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  get serverInfo(): { name: string; version: string } | undefined {
    const v = this.client?.getServerVersion();
    return v ? { name: v.name, version: String(v.version) } : undefined;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.client) throw new Error("connect() を先に呼んでください");
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    if (!this.client) throw new Error("connect() を先に呼んでください");
    try {
      const res = await this.client.callTool({ name, arguments: args });
      const content = Array.isArray(res.content) ? res.content : [];
      const text = content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("");
      return { text, isError: Boolean(res.isError) };
    } catch (err) {
      // ツールが存在しない・引数が不正など、プロトコル層のエラー。
      // 「有音の失敗」として扱えるようモデルに返す。
      return {
        text: `ツール呼び出しに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }
}
