/**
 * 问题流的 MCP 网关客户端(最小实现 + 留缝)。
 *
 * 背景:Pi 运行时按设计不带 MCP(README:"No MCP"),问题流的
 * "AI 调 DTS-MCP / Codehub-MCP" 因此走宿主桥——平台在宿主侧终结
 * MCP 协议,以会话工具的形态把能力递给 Agent。好处是 x-auth-token
 * 止步于宿主进程,不进容器、不进模型上下文、不进事件流。
 *
 * 【遗留事项(用户待提供后接线)】DTS MCP 的 URL 与工具名尚未给出。
 * 本模块把协议实现好、把配置面留成显式注入,未配置时 fail-loud
 * (人话报错),绝不静默假装成功。
 *
 * 协议形态:streamable HTTP(JSON-RPC 2.0 over HTTP POST,响应可能
 * 是 application/json 单体,也可能回 text/event-stream 流)。初始化
 * 握手(initialize → notifications/initialized)按需建立,服务端返回
 * 的 Mcp-Session-Id 在后续请求回带;会话过期按一次性重试处理。
 */

export interface McpGatewayConfig {
  url: string;
  token: string;
  /** 能力 → 工具名。真实工具名待 DTS 集成时对拍;缺省给常用名。 */
  toolNames?: Record<string, string>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export class McpGatewayError extends Error {}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class McpGateway {
  private mcpSessionId?: string;
  private ready = false;
  private callSeq = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: McpGatewayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  toolName(capability: string, fallback: string): string {
    return this.config.toolNames?.[capability] ?? fallback;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // streamable HTTP 觅音:两种响应形态都要声明可收。
      accept: "application/json, text/event-stream",
      "x-auth-token": this.config.token,
    };
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;
    return headers;
  }

  /** 单次 HTTP 往返:JSON 体直接解,SSE 体读首个带匹配 id 的 data 帧。 */
  private async post(body: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sessionHeader = response.headers.get("mcp-session-id");
      if (sessionHeader) this.mcpSessionId = sessionHeader;
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new McpGatewayError(
          `MCP 网关 HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await this.readSseResponse(response, body);
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new McpGatewayError(`MCP 网关返回非 JSON: ${text.slice(0, 400)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSseResponse(
    response: Response,
    request: unknown,
  ): Promise<JsonRpcResponse> {
    const wantId = (request as { id?: number | string }).id;
    const reader = response.body?.getReader();
    if (!reader) throw new McpGatewayError("MCP 网关 SSE 无响应体");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            const parsed = JSON.parse(data) as JsonRpcResponse;
            if (parsed.id !== undefined && parsed.id === wantId) {
              return parsed;
            }
          } catch {
            // 非 JSON 帧通知(心跳/进度)继续读。
          }
        }
        cut = buffer.indexOf("\n\n");
      }
    }
    throw new McpGatewayError("MCP 网关 SSE 流结束仍未等到应答");
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = ++this.callSeq;
    const reply = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (reply.error) {
      throw new McpGatewayError(
        `MCP ${method} 失败(${reply.error.code ?? "?"}): `
        + String(reply.error.message ?? "").slice(0, 400));
    }
    return reply.result;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mae-flow-cloud-issue-flow", version: "1" },
    }, 30_000);
    await this.post({
      jsonrpc: "2.0", method: "notifications/initialized",
    }, 15_000).catch(() => undefined);
    this.ready = true;
  }

  /** tools/call,返回 MCP 结果。会话过期只重试一次(重建握手)。 */
  async call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    try {
      await this.ensureReady();
      return await this.rpc("tools/call", { name: tool, arguments: args }, timeoutMs);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const sessionLost = /404|session|expired|not found/i.test(message);
      if (!sessionLost || this.ready === false) throw error;
      this.ready = false;
      this.mcpSessionId = undefined;
      await this.ensureReady();
      return await this.rpc("tools/call", { name: tool, arguments: args }, timeoutMs);
    }
  }
}

/** MCP 工具结果 → 人话文本。content 可能是文本块数组;结构化字段
 * 原样带回(fallback),调用方按能力自行解析。 */
export function mcpResultText(result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((block): block is { type: string; text?: string } =>
          Boolean(block) && typeof block === "object")
        .map((block) => String(block.text ?? ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if ("isError" in record && record.isError) {
      return `工具报错: ${JSON.stringify(result).slice(0, 400)}`;
    }
  }
  return JSON.stringify(result, null, 1).slice(0, 4_000);
}

// ---- DTS 问题单网关 ----

export interface DtsTicketBrief {
  ticket: string;
  title: string;
  status?: string;
}

export interface DtsTicketDetail {
  ticket: string;
  title: string;
  content: string;
}

export interface DtsGateway {
  listByOwner(account: string): Promise<DtsTicketBrief[]>;
  detail(ticket: string): Promise<DtsTicketDetail>;
}

/** 从网关文本里尽力解出单据列表。真实形状待 DTS 对拍(遗留),
 * 解不动时如实报错并把原文带给用户,不静默返回空列表。 */
function parseTicketList(raw: string): DtsTicketBrief[] {
  const candidate = raw.trim().startsWith("[") || raw.trim().startsWith("{")
    ? JSON.parse(raw) : undefined;
  const rows = Array.isArray(candidate)
    ? candidate
    : Array.isArray((candidate as Record<string, unknown>)?.items)
      ? ((candidate as Record<string, unknown>).items as unknown[])
      : Array.isArray((candidate as Record<string, unknown>)?.data)
        ? ((candidate as Record<string, unknown>).data as unknown[])
        : undefined;
  if (!rows) {
    throw new McpGatewayError(
      `DTS 列表返回形状未识别(集成时需对拍解析): ${raw.slice(0, 300)}`);
  }
  return rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      ticket: String(record.ticket ?? record.id ?? record["单号"] ?? ""),
      title: String(record.title ?? record.subject ?? record["标题"] ?? ""),
      status: record.status === undefined ? undefined : String(record.status),
    };
  }).filter((item) => item.ticket);
}

export class McpDtsGateway implements DtsGateway {
  constructor(private readonly gateway: McpGateway) {}

  async listByOwner(account: string): Promise<DtsTicketBrief[]> {
    const result = await this.gateway.call(
      this.gateway.toolName("list", "list_issues"),
      { owner: account, assignee: account },
    );
    return parseTicketList(mcpResultText(result));
  }

  async detail(ticket: string): Promise<DtsTicketDetail> {
    const result = await this.gateway.call(
      this.gateway.toolName("detail", "get_issue_detail"),
      { ticket, issue_id: ticket },
    );
    const text = mcpResultText(result);
    return { ticket, title: "", content: text };
  }
}

// ---- Codehub MR 网关 ----

export interface CodehubGateway {
  call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  text(result: unknown): string;
}

export class McpCodehubGateway implements CodehubGateway {
  constructor(private readonly gateway: McpGateway) {}
  call(tool: string, args: Record<string, unknown>, timeoutMs?: number) {
    // CodeHub 网关对 create 的超时较短(约 5s,skill 实战记录),
    // 缺省预算给到 30s,由调用方按需收紧。
    return this.gateway.call(tool, args, timeoutMs ?? 30_000);
  }
  text(result: unknown): string {
    return mcpResultText(result);
  }
}

// ---- 未配置网关:fail-loud 的占位 ----

export class UnconfiguredDtsGateway implements DtsGateway {
  readonly reason: string;
  constructor(reason = "DTS MCP 网关未配置(启动需 --dts-mcp-url 与 --mcp-token-file,"
    + "正式服务器 token 在 /etc/mae-flow-cloud/mcp-token)") {
    this.reason = reason;
  }
  async listByOwner(_account: string): Promise<DtsTicketBrief[]> {
    throw new McpGatewayError(this.reason);
  }
  async detail(_ticket: string): Promise<DtsTicketDetail> {
    throw new McpGatewayError(this.reason);
  }
}

export class UnconfiguredCodehubGateway implements CodehubGateway {
  readonly reason: string;
  constructor(reason = "Codehub MCP 网关未配置(启动需 --codehub-mcp-url;"
    + "与 DTS 共用 --mcp-token-file 的 token)") {
    this.reason = reason;
  }
  async call(_tool: string, _args: Record<string, unknown>): Promise<unknown> {
    throw new McpGatewayError(this.reason);
  }
  text(): string {
    return this.reason;
  }
}
