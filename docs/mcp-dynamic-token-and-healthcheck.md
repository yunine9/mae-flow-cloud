# MCP 动态 Token 读取、参数适配与健康检查实现指南

## 背景

MCP 网关调用需要 `x-auth-token` 认证。原实现存在三个问题：

1. **token 固定**：启动时一次性读取 token 文件并固定在内存中，token 轮换后必须重启服务
2. **参数不兼容**：华为 MCP 网关的 `inputSchema` 使用 `arg0/arg1/arg2` 而非命名参数，导致命名参数传递后值被丢弃为 `null`
3. **无健康检查**：缺少验证 MCP 网关连通性的手段

本次改造：
1. **token 动态读取**：每次 MCP 请求时从文件重新读取，token 轮换无需重启
2. **argN 自动映射**：`call()` 方法自动将命名参数按声明顺序映射为 `arg0/arg1/arg2...`，同时保留原始命名参数以兼容标准 MCP 实现
3. **健康检查端点**：`GET /mcp-health` 验证网关连通性、token 有效性、返回可用工具清单及 inputSchema

## 变更文件

| 文件                        | 变更                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `src/issueFlow/gateways.ts` | `McpGatewayConfig` 支持 `tokenProvider`；`call()` 自动映射 argN；新增 `healthCheck()`；`McpDtsGateway` 工具名对齐真实网关（listByVersionAndHead / batchQueryTicket）并解析真实返回形状（status/result.datas，dtsBizNo/briefDesc/dtsStatusName） |
| `src/serve.ts`              | token 读取改为动态闭包；自动加载 /etc/mae-flow-cloud/serve.json（存在才装，显式 --config 优先）；暴露 `mcpGateway` 实例给路由层 |
| `src/server.ts`             | 新增 `GET /mcp-health` 路由                                  |
| `/etc/mae-flow-cloud/serve.json`（部署侧） | 固化 dts-mcp-url 与 mcp-token-file，裸起即接通网关           |

## 关键发现：华为 MCP 网关的 argN 参数映射

华为 MCP 网关将 Java 方法参数映射为 `arg0/arg1/arg2...`，**不保留原始参数名**。

例如 `getTicket` 工具的 `inputSchema`：
```json
{"type": "object", "properties": {"arg0": {"type": "string"}}, "required": ["arg0"]}
```

如果用标准 MCP 协议传 `{"dtsNo": "DTS2026082671269"}`，网关丢弃为 `null`；必须传 `{"arg0": "DTS2026082671269"}`。

`listByVersionAndHead` 的 14 个参数映射：

| arg序号 | 参数名            | 类型               | 说明                                                         |
| ------- | ----------------- | ------------------ | ------------------------------------------------------------ |
| arg0    | pageIndex         | integer            | 分页页码，默认1                                              |
| arg1    | pageSize          | integer            | 分页条数，默认20，最大200                                    |
| arg2    | pbiId             | string             | 产品ID                                                       |
| arg3    | productType       | string             | 产品类型(PBI/EAMAP等)                                        |
| arg4    | filterId          | string             | 过滤器(myTodos/myCreate/myProcessed/myFollowed/ccToMe/myOverdue) |
| arg5    | workBenchViewId   | string             | 工作台视图ID                                                 |
| arg6    | brief             | string             | 简要描述搜索                                                 |
| arg7    | dtsNos            | array\<string\>    | 问题单号列表                                                 |
| arg8    | dtsStatus         | array\<string\>    | 状态列表                                                     |
| arg9    | severity          | array\<string\>    | 严重程度列表                                                 |
| arg10   | convertAttachment | boolean            | 是否转换附件地址                                             |
| arg11   | fields            | array\<string\>    | 其他字段key组合                                              |
| arg12   | otherConditions   | array\<Condition\> | 其他过滤条件                                                 |
| arg13   | orderBy           | array\<Sort\>      | 排序参数                                                     |

**Condition 结构**：`{fieldName, operator, value}`，operator 枚举值首字母大写（`Equal/EqualName/Include/LeftLike/...`）

**因此 `call()` 方法自动将命名参数映射为 argN 格式**，调用方可继续使用语义化参数名：

```typescript
// 调用方代码（语义化参数）
await gateway.call("getTicket", { dtsNo: "DTS2026082671269" });

// 实际发送（自动映射 arg0）
// params: { name: "getTicket", arguments: { dtsNo: "DTS2026082671269", arg0: "DTS2026082671269" } }
```

## 详细实现

### 1. gateways.ts — 动态 Token + argN 映射 + 健康检查

#### 1.1 McpGatewayConfig 支持 tokenProvider

```typescript
export interface McpGatewayConfig {
  url: string;
  /** 静态 token(与 tokenProvider 二选一)。 */
  token?: string;
  /** 动态 token 读取函数:每次请求调用,支持 token 文件轮换不重启。
   * 优先级:tokenProvider > token;都未提供时请求不携带 x-auth-token。 */
  tokenProvider?: () => string;
  toolNames?: Record<string, string>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}
```

**设计要点：**
- `token` 改为可选，与 `tokenProvider` 二选一
- `tokenProvider` 是无参函数，每次 HTTP 请求时调用
- 优先级：`tokenProvider` > `token`

#### 1.2 McpGateway 内部改造

```typescript
// 新增：动态获取当前 token
private currentToken(): string | undefined {
  if (this.config.tokenProvider) return this.config.tokenProvider();
  return this.config.token;
}

// 改造：headers() 通过 currentToken() 获取
private headers(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const token = this.currentToken();
  if (token) headers["x-auth-token"] = token;
  if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;
  return headers;
}
```

**设计要点：**
- 原来直接 `this.config.token` 改为通过 `currentToken()` 间接获取
- token 为空时不设置 `x-auth-token` 头（而非报错），支持无认证场景

#### 1.3 call() 方法：argN 自动映射

```typescript
async call(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<unknown> {
  // 按声明顺序将命名参数映射为 arg0/arg1/arg2...
  const argN: Record<string, unknown> = {};
  const entries = Object.entries(args);
  for (let i = 0; i < entries.length; i++) {
    argN[`arg${i}`] = entries[i][1];
  }
  const params: Record<string, unknown> = {
    name: tool,
    arguments: { ...args, ...argN },
  };
  // ... (会话过期重试逻辑)
}
```

**设计要点：**
- 调用方使用语义化参数名（如 `dtsNo`、`dtsNos`）
- `call()` 自动按 `Object.entries(args)` 的声明顺序映射为 `arg0/arg1/...`
- **同时保留原始命名参数**（`{ ...args, ...argN }`），兼容标准 MCP 网关
- **参数顺序敏感**：调用方必须按工具文档中的参数顺序传入（JavaScript 对象保持插入序）

#### 1.4 新增 healthCheck() 方法

```typescript
async healthCheck(timeoutMs = 15_000): Promise<{
  ok: boolean;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  error?: string;
  tokenSource?: string;
}> {
  try {
    await this.ensureReady();
    const result = await this.rpc("tools/list", {}, timeoutMs) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
    };
    const tools = (result.tools ?? [])
      .filter((t) => t.name)
      .map((t) => ({
        name: t.name!,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    // ... 返回 ok:true + tools + tokenSource
  } catch (error) {
    // ... 返回 ok:false + error + tokenSource
  }
}
```

**设计要点：**
- 复用已有的 `ensureReady()` 完成初始化握手
- 调用 `tools/list` MCP 标准方法获取工具清单
- 返回 `inputSchema` 用于调试 argN 映射
- `tokenSource` 字段区分 token 来源模式，便于排障
- 失败时返回 `ok: false` + 错误信息，不抛异常（健康检查语义）

### 2. serve.ts — 动态 Token 闭包

```typescript
let mcpTokenProvider: (() => string) | undefined;
if (mcpTokenFile) {
  // 启动时校验 token 文件可读且非空
  try {
    const initial = readFileSync(mcpTokenFile, "utf-8").trim();
    if (!initial) throw new Error("token 文件为空");
    console.log(`[serve] MCP token 文件(动态读取): ${mcpTokenFile}`);
  } catch (error) {
    console.error(`[serve] MCP token 读取失败,拒绝启动: ${String(error)}`);
    process.exit(2);
  }
  // 闭包：每次调用重新读取文件
  mcpTokenProvider = () => {
    try {
      return readFileSync(mcpTokenFile, "utf-8").trim();
    } catch {
      return ""; // 文件被删或不可读时降级但不中断
    }
  };
}
```

**设计要点：**
- 启动时仍校验文件存在且非空（fail-fast），但 token 值不保存
- `mcpTokenProvider` 闭包捕获 `mcpTokenFile` 路径，每次调用 `readFileSync`
- 运行时文件被删或不可读时返回空串降级，不中断服务

#### 构造 McpGateway 时使用 tokenProvider

```typescript
let mcpGateway: McpGateway | undefined;
if (dtsMcpUrl && mcpTokenProvider) {
  mcpGateway = new McpGateway({
    url: dtsMcpUrl, tokenProvider: mcpTokenProvider,
    log: (message) => console.log(`  [issue-dts] ${message}`),
  });
  issueDts = new McpDtsGateway(mcpGateway);
  console.log(`[serve] 问题流 DTS 网关: ${dtsMcpUrl}`);
}
```

#### 传递 mcpGateway 给路由层

```typescript
const server = createTaskServer(service, {
  webRoot, auth, lubanApproval, issueFlow, mcpGateway,
});
```

### 3. server.ts — 健康检查路由

```typescript
export function createTaskServer(
  service: TaskService,
  options: {
    webRoot?: string;
    auth?: LocalAuth;
    lubanApproval?: LubanApprovalGateway;
    issueFlow?: import("./issueFlow/service.ts").IssueFlowService;
    mcpGateway?: import("./issueFlow/gateways.ts").McpGateway;
  } = {},
): Server {
```

```typescript
if (request.method === "GET" && url.pathname === "/mcp-health") {
  if (!options.mcpGateway) {
    return json(response, 200, {
      ok: false,
      error: "MCP 网关未配置(需 --dts-mcp-url 与 --mcp-token-file)",
    });
  }
  const result = await options.mcpGateway.healthCheck();
  return json(response, result.ok ? 200 : 502, result);
}
```

**设计要点：**
- 未配置网关时返回 `200 + ok: false`（服务本身正常，MCP 未启用不是 5xx）
- 连接失败时返回 `502`（网关错误）
- 成功时返回 `200`

## API 规格

### GET /mcp-health

**成功响应 (200)：**

```json
{
  "ok": true,
  "tools": [
    {
      "name": "batchQueryTicket",
      "description": "批量获取问题单详情...",
      "inputSchema": {"type":"object","properties":{"arg0":{"type":"array","items":{"type":"string"}},"arg1":{"type":"array","items":{"type":"string"}},"arg2":{"type":"boolean"}}}
    }
  ],
  "tokenSource": "动态文件读取"
}
```

**未配置 (200)：**

```json
{"ok": false, "error": "MCP 网关未配置(需 --dts-mcp-url 与 --mcp-token-file)"}
```

**连接失败 (502)：**

```json
{"ok": false, "error": "MCP 网关 HTTP 401: ...", "tokenSource": "动态文件读取"}
```

## 启动命令

```bash
# 带 MCP 网关启动
npm run serve -- --dts-mcp-url http://mcpgateway.his.huawei.com/mcp/<id>

# token 文件默认路径 /etc/mae-flow-cloud/mcp-token，可通过 --mcp-token-file 覆盖
npm run serve -- --dts-mcp-url <URL> --mcp-token-file /path/to/token

# 不带 MCP 网关（原有行为不变）
npm run serve
```

## 常用 DTS MCP 调用示例

### 查询问题单详情

```typescript
// getTicket: arg0 = dtsNo
await gateway.call("getTicket", { dtsNo: "DTS2026082671269" });

// batchQueryTicket: arg0 = dtsNos, arg1 = fields, arg2 = attachmentView
await gateway.call("batchQueryTicket", {
  dtsNos: ["DTS2026082671269"],
  fields: [],
  attachmentView: false,
});
```

### 查询某人的问题单

```typescript
// listByVersionAndHead: 14 个参数按顺序映射为 arg0-arg13
await gateway.call("listByVersionAndHead", {
  pageIndex: 1,           // arg0
  pageSize: 50,           // arg1
  pbiId: "",              // arg2
  productType: "PBI",     // arg3
  filterId: "",           // arg4
  workBenchViewId: "",    // arg5
  brief: "",              // arg6
  dtsNos: [],             // arg7
  dtsStatus: [],          // arg8
  severity: [],           // arg9
  convertAttachment: false, // arg10
  fields: [],             // arg11
  otherConditions: [{     // arg12
    fieldName: "currentHandler",
    operator: "EqualName",
    value: ["yanning 00965296"],
  }],
  orderBy: [],            // arg13
});
```

### 查询用户信息

```typescript
// getUserInfo: 无参数
await gateway.call("getUserInfo", {});
```

## 验证方法

```bash
# 健康检查
curl http://127.0.0.1:8787/mcp-health

# token 轮换验证：更新 token 文件后无需重启
echo "new-token" | sudo tee /etc/mae-flow-cloud/mcp-token
curl http://127.0.0.1:8787/mcp-health  # tokenSource 仍为"动态文件读取"
```

## 兼容性

- **向后兼容**：`McpGatewayConfig.token` 仍可用（静态 token 场景），`tokenProvider` 为新增可选字段
- **argN + 原始参数双发**：`arguments` 中同时包含命名参数和 argN 映射，标准 MCP 网关忽略 argN，华为网关使用 argN
- **`McpDtsGateway` 已对齐真实网关**：工具名从占位（list_issues / get_issue_detail）改为真实名（listByVersionAndHead / batchQueryTicket），参数与返回解析按真实形状实现；通用 `parseTicketList` 保留为 fallback。`UnconfiguredDtsGateway` 无变更
- **serve.json 自动装载**：不带 `--config` 时自动读 `/etc/mae-flow-cloud/serve.json`（不存在不报错）；显式 `--config` 行为不变；命令行参数永远压过文件
- **原有 `npm run serve` 行为不变**：不加 `--dts-mcp-url` 时走 `UnconfiguredDtsGateway`