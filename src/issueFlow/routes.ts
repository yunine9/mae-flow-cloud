/**
 * 问题流 HTTP 路由(/issues/*)。
 *
 * 与任务 API(/tasks/*)平行的独立命名空间:鉴权沿用会话 cookie,
 * 归属校验"只有本人(或管理员只读)能碰自己的问题会话"。SSE 事件
 * 尾随与任务侧同款(300ms 轮询 + 字节偏移增量),只是终态判定换成
 * 问题域的状态集。
 *
 *   GET  /issues                      → 我的会话列表
 *   POST /issues                      → 登记(201 摘要)
 *   GET  /issues/dts                  → DTS 名下问题单(拉单)
 *   GET  /issues/dts/:ticket          → 单张问题单详情(拉单页签展开用)
 *   GET  /issues/dts-file?path=…      → 描述内嵌图代理(后端带回二进制)
 *   GET  /issues/:id                  → 详情(状态 + 消息 + 问题卡)
 *   GET  /issues/:id/materials        → 材料清单(变更/日志/人工台账/推送记录)
 *   GET  /issues/:id/materials/diff   → 单文件 diff(?path=,对 HEAD)
 *                                      / 单仓切片(?repo=,无标记)
 *                                      / 聚合(缺省,带仓库分段标记)
 *   GET  /issues/:id/materials/file   → 读工作区文件(?path=)
 *   PUT  /issues/:id/materials/file   → 快速修改(仅归属者;入人工台账)
 *   GET  /issues/:id/materials/log    → 读拉取日志(?name=,任意深度
 *                                      相对路径,超长读尾)
 *   POST /issues/:id/materials/log-extract → 解压压缩包日志(body
 *                                      {path};仅归属者;幂等)
 *   GET  /issues/:id/materials/events → 原始事件尾随(?limit=,现场页签)
 *   GET  /issues/:id/timeline         → 耗时与卡点(纯函数归纳,只读)
 *   GET  /issues/:id/documents        → 过程文档清单(分析报告+Agent 落
 *                                      的其他 .md)
 *   GET  /issues/:id/documents/read   → 读一份过程文档(?name=;缺失为
 *                                      200 {unavailable},不 404)
 *   GET  /issues/:id/dialogue         → 过程问答(事件账本投影的对话)
 *   GET  /issues/:id/reviews          → 检视面板(意见+锚点检测+回合标记)
 *   POST /issues/:id/reviews          → 记一条检视草稿(悬停圈注)
 *   POST /issues/:id/reviews/send     → 提交检视(整体回退到问题分析)
 *   DELETE /issues/:id/reviews/:rid   → 移除一条意见(软删留痕)
 *   GET  /issues/:id/export           → 现场记录导出(单文件 Markdown:
 *                                      事件流逐字 + 台账,复盘用)
 *   GET  /issues/:id/events           → SSE:事件流尾随
 *   POST /issues/:id/reply            → 续聊
 *   POST /issues/:id/decision         → 问题卡作答
 *   POST /issues/:id/environment      → 网管环境配置(env_needed 闸的作答口)
 *   POST /issues/:id/interrupt        → 补充(运行中送达 AI)
 *   POST /issues/:id/ticket           → 绑定单号
 *   POST /issues/:id/control          → 归档/取消
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IssueFlowService } from "./service.ts";
import {
  DtsGatewayUnconfiguredError,
  toHttpError,
} from "./errors.ts";
import {
  extractLog,
  listMaterials,
  readSessionWorkspaceFile,
  recentEvents,
  readLog,
  saveSessionWorkspaceFile,
  sessionWorkspaceDiffAll,
  sessionWorkspaceFileDiff,
  sessionWorkspaceRepoDiff,
} from "./materials.ts";
import {
  listSessionDocuments,
  projectDialogue,
  readSessionDocument,
} from "./documents.ts";
import type { DtsGateway } from "./gateways.ts";
import { isTerminal } from "./state.ts";
import { listBusinessModules } from "../businessModuleLibrary.ts";

export interface IssueViewer {
  username: string;
  role?: string;
}

export interface IssueRouteOptions {
  issueFlow?: IssueFlowService;
  /** DTS 网关直连(拉单/单据详情/内嵌图代理;收窄票 #7:服务不再
   * 转手)。缺席时按原透传层的同一句 fail-loud 打回。 */
  dts?: DtsGateway;
  viewer?: IssueViewer;
  /** 会话鉴权是否启用(测试直连形态没有 auth)。 */
  authEnabled: boolean;
  /** 人工修改的台账日志(口径与问题服务一致:快速修改动了谁的现场,
   * 控制台要有痕迹;账本本体在 materials 的 manual-edits.jsonl)。 */
  log?: (message: string) => void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("请求体超过 2MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(new Error(`JSON 解析失败: ${String(error)}`));
      }
    });
    request.on("error", reject);
  });
}

function streamIssueEvents(
  issueFlow: IssueFlowService,
  id: string,
  response: ServerResponse,
): void {
  const path = join(issueFlow.session(id).root, "events.jsonl");
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  let offset = 0;
  let carry = Buffer.alloc(0);
  let closed = false;
  response.on("close", () => (closed = true));
  const push = () => {
    if (closed) return;
    if (existsSync(path) && statSync(path).size > offset) {
      const fd = openSync(path, "r");
      let read = 0;
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(statSync(path).size - offset);
        read = readSync(fd, chunk, 0, chunk.length, offset);
      } finally {
        closeSync(fd);
      }
      offset += read;
      carry = Buffer.concat([carry, chunk.subarray(0, read)]);
      const cut = carry.lastIndexOf(0x0a);
      if (cut >= 0) {
        const complete = carry.subarray(0, cut).toString("utf-8");
        carry = Buffer.from(carry.subarray(cut + 1));
        for (const line of complete.split("\n")) {
          if (line.trim()) response.write(`data: ${line}\n\n`);
        }
      }
    }
    const issue = issueFlow.get(id);
    if (issue && isTerminal(issue.status)) {
      response.end();
      return;
    }
    setTimeout(push, 300);
  };
  push();
}

/** DTS 网关直连的缺席守卫:缺席即"未配置",是环境档(409),不是
 * 上游故障——按 #9 的口径抛 DtsGatewayUnconfiguredError。 */
function requireDts(dts: DtsGateway | undefined): DtsGateway {
  if (!dts) {
    throw new DtsGatewayUnconfiguredError(
      "DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
  }
  return dts;
}

/** DTS 单据自动匹配业务模块:用 sFeatureNoName / sModuleNoName 拆出
 * 关键词,与模块库的 name/id/description 做匹配。唯一高置信命中时
 * 返回模块 ID;多候选或零候选返回 undefined(留给 Agent 后续处理)。 */
function matchDtsToModule(
  featureName: string | undefined,
  moduleName: string | undefined,
  dataDir: string,
): string | undefined {
  if (!dataDir) return undefined;
  const keywords = extractDtsKeywords(featureName, moduleName);
  if (!keywords.length) return undefined;
  const { modules } = listBusinessModules(dataDir);
  const active = modules.filter((m) => m.status === "active");
  if (!active.length) return undefined;

  interface Scored { id: string; name: string; score: number; matchedBy: string[] }
  const scored: Scored[] = [];
  for (const mod of active) {
    const nameLower = mod.name.toLowerCase();
    const descLower = mod.description.toLowerCase();
    const idLower = mod.id.toLowerCase();
    let score = 0;
    const matchedBy: string[] = [];
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (nameLower === kwLower) { score += 100; matchedBy.push(`name=「${kw}」`); continue; }
      if (nameLower.includes(kwLower)) { score += 50; matchedBy.push(`name∋「${kw}」`); continue; }
      if (idLower === kwLower) { score += 90; matchedBy.push(`id=「${kw}」`); continue; }
      if (idLower.includes(kwLower)) { score += 40; matchedBy.push(`id∋「${kw}」`); continue; }
      if (descLower.includes(kwLower)) { score += 20; matchedBy.push(`desc∋「${kw}」`); continue; }
      // 中文逐字匹配
      const chars = [...kwLower];
      let charHits = 0;
      for (const ch of chars) {
        if (nameLower.includes(ch) || descLower.includes(ch)) charHits++;
      }
      if (charHits >= chars.length * 0.6 && charHits > 0) {
        score += Math.round(charHits / chars.length * 10);
        matchedBy.push(`部分字∋「${kw}」(${charHits}/${chars.length})`);
      }
    }
    if (score > 0) scored.push({ id: mod.id, name: mod.name, score, matchedBy });
  }
  scored.sort((a, b) => b.score - a.score);
  // 唯一高置信命中(得分 >= 40 且远超第二名):自动绑定
  if (scored.length === 1 && scored[0].score >= 40) return scored[0].id;
  if (scored.length >= 2 && scored[0].score >= 40
      && scored[0].score > scored[1].score * 2) return scored[0].id;
  return undefined;
}

/** 从 DTS 的 sFeatureNoName / sModuleNoName 中提取关键词。
 * 中英文混合拆分:"【Access】跟踪管理Fars" → ["Access", "跟踪管理", "Fars"] */
function extractDtsKeywords(
  featureName?: string,
  moduleName?: string,
): string[] {
  const parts: string[] = [];
  for (const text of [featureName, moduleName]) {
    if (!text?.trim()) continue;
    const cleaned = text.replace(/[【】\[\]()（）]/g, " ").replace(/\s+/g, " ").trim();
    const rawParts = cleaned.split(/[\s,，、：:；;]+/);
    for (const part of rawParts) {
      const segments = part.match(/[\u4e00-\u9fff]+|[A-Za-z][A-Za-z0-9._-]*/g);
      if (segments) {
        for (const seg of segments) { if (seg.length >= 2) parts.push(seg); }
      } else if (part.length >= 2) { parts.push(part); }
    }
  }
  return parts;
}

/** 处理 /issues/* 请求;返回 false 表示与问题域无关。 */
export async function handleIssueRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  routeOptions: IssueRouteOptions,
): Promise<boolean> {
  if (parts[0] !== "issues") return false;
  const { issueFlow } = routeOptions;
  if (!issueFlow) {
    json(response, 404, { error: "问题流服务未启用" });
    return true;
  }
  const viewer = routeOptions.viewer;
  if (routeOptions.authEnabled && !viewer) {
    json(response, 401, { error: "请先登录" });
    return true;
  }
  const method = request.method ?? "GET";
  const done = (status: number, body: unknown): true => {
    json(response, status, body);
    return true;
  };
  /** 归属:开发者只能碰自己的会话;管理员只读(问题处理是开发者的活,
   * 与"管理员不发起任务"同一角色边界)。 */
  const guard = (account: string): boolean =>
    viewer ? (viewer.username === account
      || viewer.role === "admin") : true;
  const own = (account: string): boolean =>
    viewer ? viewer.username === account : true;

  try {
    if (method === "GET" && parts.length === 1) {
      const mine = issueFlow.list(
        viewer && viewer.role !== "admin" ? viewer.username : undefined);
      return done(200, { issues: mine });
    }

    if (method === "POST" && parts.length === 1) {
      if (viewer?.role === "admin") {
        return done(403, {
          error: "管理员不发起问题会话——用开发者账号登录处理问题",
        });
      }
      const body = await readBody(request);
      const source = body.source === "dts" ? "dts" as const : "manual" as const;
      const ticket = body.ticket ? String(body.ticket) : undefined;
      // DTS 来源自动匹配业务模块:前端未显式选模块时,用 DTS 单据的
      // sFeatureNoName/sModuleNoName 与模块库做匹配;唯一高置信命中时
      // 自动绑定,多候选或零候选时留给 Agent 在 prep_repo 阶段处理。
      let autoModuleId: string | undefined;
      if (source === "dts" && ticket && !body.module_id && routeOptions.dts) {
        try {
          const detail = await routeOptions.dts.detail(ticket);
          autoModuleId = matchDtsToModule(
            detail.featureName, detail.moduleName,
            routeOptions.issueFlow?.dataDir ?? "",
          );
        } catch {
          // 匹配失败不阻断发起,留给 Agent 处理。
        }
      }
      const created = issueFlow.create({
        account: String(body.account ?? viewer?.username ?? ""),
        title: String(body.title ?? ""),
        description: body.description === undefined
          ? undefined : String(body.description),
        source,
        ...(ticket ? { ticket } : {}),
        ...(body.repo_url ? { repoUrl: String(body.repo_url) } : {}),
        ...(Array.isArray(body.repo_urls)
          ? { repoUrls: body.repo_urls.map(String) } : {}),
        ...(body.baseline ? { baseline: String(body.baseline) } : {}),
        ...(body.module ? { module: String(body.module) } : {}),
        ...(body.module_id ? { moduleId: String(body.module_id) } : {}),
        ...(autoModuleId ? { moduleId: autoModuleId } : {}),
        ...(body.environment ? {
          environment: {
            name: body.environment.name === undefined
              ? undefined : String(body.environment.name),
            hosts: Array.isArray(body.environment.hosts)
              ? body.environment.hosts.map(String) : [],
            ...(body.environment.port !== undefined
              ? { port: Number(body.environment.port) } : {}),
            ...(body.environment.page_account !== undefined
              ? { pageAccount: String(body.environment.page_account) } : {}),
            ...(body.environment.page_password !== undefined
              ? { pagePassword: String(body.environment.page_password) } : {}),
            backendPassword: String(body.environment.backend_password ?? ""),
          },
        } : {}),
      });
      return done(201, created);
    }

    if (method === "GET" && parts[1] === "dts" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      // 直连 DTS 网关(收窄票 #7):服务不再转手拉单。
      const tickets = await requireDts(routeOptions.dts)
        .listByOwner(String(viewer?.username ?? ""));
      return done(200, { tickets, mock: routeOptions.dts?.mock === true });
    }

    // 单张问题单详情(页签展开用):登录即可查本人名下任意单。
    if (method === "GET" && parts[1] === "dts" && parts.length === 3) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const ticket = decodeURIComponent(parts[2]);
      if (!ticket) return done(400, { error: "缺少问题单号" });
      const detail = await requireDts(routeOptions.dts).detail(ticket);
      return done(200, detail);
    }

    // DTS 文件代理(GET /issues/dts-file?path=/v1/nfs/...):描述内嵌
    // 图的浏览器直连跨域且无 cookie,由后端带同源 token 回取二进制。
    // path 只收站内绝对路径(/开头),不成为任意外链跳板。
    if (method === "GET" && parts[1] === "dts-file" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const path = String(
        new URL(request.url ?? "", "http://x").searchParams.get("path") ?? "");
      if (!path || !path.startsWith("/")) {
        return done(400, { error: "缺少合法 path 参数(须为站内绝对路径)" });
      }
      // 直连 DTS 网关代理回取(收窄票 #7)。失败不再本地包 502(#9):
      // 网关查询失败 502、未配置 409,与拉单/详情/关联转正同走尾部
      // toHttpError 单点出码。
      const file = await requireDts(routeOptions.dts).proxyFile(path);
      response.writeHead(200, {
        "content-type": file.contentType,
        "cache-control": "public, max-age=86400",
      });
      response.end(file.data);
      return true;
    }

    const id = parts[1];
    if (!id) return done(404, { error: "未知问题接口" });
    const brief = issueFlow.list().find((item) => item.id === id);
    if (brief && !guard(brief.account)) {
      return done(403, { error: "只能访问自己的问题会话" });
    }

    if (method === "GET" && parts.length === 2) {
      return done(200, issueFlow.get(id));
    }

    // ---- 会话材料(交付材料页签):路由直连 materials.ts,服务不再
    // 转手(收窄票 #7);issueFlow.session 只负责"哪个会话、现场在哪"。
    // 读:本人或管理员;写(快速修改):仅会话归属者。路径防穿越在
    // materials 层双保险,这里只做归属与参数兜底。fail-open 语义:读类
    // 故障以 400 带人话返回,页面给空态,不拖垮会话。
    if (parts[2] === "materials" && parts.length === 3) {
      const session = issueFlow.session(id);
      return done(200, listMaterials(session.state, session.root));
    }
    if (method === "PUT" && parts[2] === "materials"
        && parts[3] === "file" && parts.length === 4) {
      if (brief && !own(brief.account)) {
        return done(403, { error: "只能修改自己会话的工作区" });
      }
      const body = await readBody(request);
      const rel = String(body.path ?? "");
      // 会话定位在 try 外(#9):未知会话是 404 域错误族,不该被下面
      // "写失败回 400"的本地兜底吞掉。
      const session = issueFlow.session(id);
      try {
        const result = saveSessionWorkspaceFile(
          session.state, session.root, rel, String(body.content ?? ""));
        routeOptions.log?.(
          `[issue-flow] ${id} 人工修改 ${rel}(${result.size}B)`);
        return done(200, result);
      } catch (reason) {
        return done(400, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
    }
    if (parts[2] === "materials" && parts.length === 4 && method === "GET") {
      const query = new URL(request.url ?? "/", "http://x").searchParams;
      // 会话定位在 try 外(#9):未知会话按 404 出码,不被读类 fail-open
      // 的 400 吞掉;材料读本身失败才回 400 带人话,页面给空态。
      const session = issueFlow.session(id);
      try {
        if (parts[3] === "diff") {
          // 带 path = 单文件;带 repo = 单仓切片(#32,服务端只回该仓,
          // 前端逐仓审阅不再解析分段标记);都不带 = 聚合 diff(带
          // 「===== 仓库 =====」标记,合并视图照旧)。
          const repo = query.get("repo");
          const path = query.get("path");
          return done(200, {
            diff: repo
              ? sessionWorkspaceRepoDiff(session.state, session.root, repo)
              : path
                ? sessionWorkspaceFileDiff(session.state, session.root, path)
                : sessionWorkspaceDiffAll(session.state, session.root),
          });
        }
        if (parts[3] === "file") {
          return done(200, readSessionWorkspaceFile(
            session.state, session.root, String(query.get("path") ?? "")));
        }
        if (parts[3] === "log") {
          return done(200, readLog(
            session.root, String(query.get("name") ?? "")));
        }
        if (parts[3] === "events") {
          const raw = Number(query.get("limit") ?? 200);
          const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 200;
          return done(200, { events: recentEvents(session.root, limit) });
        }
      } catch (reason) {
        return done(400, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
    }
    // 解压压缩包日志(#47):写操作,仅归属者(与快速修改同一口子)。
    // 数据面在 materials.extractLog(预检 + 系统命令解压 + 属主交接),
    // 失败 400 带人话——解压是写,错误必须让人知道发生了什么。
    if (method === "POST" && parts[2] === "materials"
        && parts[3] === "log-extract" && parts.length === 4) {
      if (brief && !own(brief.account)) {
        return done(403, { error: "只能解压自己会话的日志" });
      }
      const body = await readBody(request);
      // 会话定位在 try 外(#9):未知会话按 404 出码,不被写失败兜底吞掉。
      const session = issueFlow.session(id);
      try {
        return done(200, await extractLog(
          session.root, String(body.path ?? ""),
          issueFlow.logOwnershipInputs()));
      } catch (reason) {
        return done(400, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
    }

    // 耗时与卡点(只读):消息账 + 转移账归纳成"时间去哪了、卡在谁身上"。
    // 归纳是纯函数(sessionView.ts),路由只负责门禁与投影——口径同
    // 需求侧 /tasks/:id/timeline:能看会话就能看它经历了什么。
    if (method === "GET" && parts[2] === "timeline" && parts.length === 3) {
      return done(200, issueFlow.timeline(id));
    }

    // 过程文档(只读旁路,数据面在 documents.ts):清单 + 单份读取。
    // 读取缺失为 200 {unavailable}——"还没生成"不是"没有这个接口",
    // 前端据此出空态而不是报错。
    if (method === "GET" && parts[2] === "documents" && parts.length === 3) {
      const session = issueFlow.session(id);
      return done(200, { documents: listSessionDocuments(session.root) });
    }
    if (method === "GET" && parts[2] === "documents"
        && parts[3] === "read" && parts.length === 4) {
      const session = issueFlow.session(id);
      const name = String(
        new URL(request.url ?? "", "http://x").searchParams.get("name") ?? "");
      const read = readSessionDocument(session.root, name);
      if (!read) return done(200, { unavailable: "文档不存在" });
      return done(200, {
        name: read.meta.name,
        label: read.meta.label,
        content: read.content,
        ...(read.truncated ? { truncated: true } : {}),
      });
    }

    // 过程问答(只读):事件账本投影成对话,复盘阅读面(现场页签仍
    // 是原始事件直播)。
    if (method === "GET" && parts[2] === "dialogue" && parts.length === 3) {
      const session = issueFlow.session(id);
      const dialogue = projectDialogue(session.root);
      return done(200, {
        turns: dialogue.turns,
        ...(dialogue.truncated ? { truncated: true } : {}),
      });
    }

    // 检视(ADR-0007):意见账本 + 提交重跑。读:本人或管理员;记/
    // 删/提交:仅归属人。提交是"整体回退"这一有后果动作的人工触发
    // 源,服务层把门(固定流程/未终态/非转正继承/不可叠加/状态在
    // 等或闲置);这里的轻量确认在页面层,服务端只认状态守卫。
    if (method === "GET" && parts[2] === "reviews" && parts.length === 3) {
      return done(200, issueFlow.listReviews(id));
    }
    if (method === "POST" && parts[2] === "reviews" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能记检视意见" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.addReview(id, {
        line: Number(body.line),
        anchor: String(body.anchor ?? ""),
        note: String(body.note ?? ""),
      }));
    }
    if (method === "POST" && parts[2] === "reviews"
        && parts[3] === "send" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能提交检视" });
      }
      return done(200, issueFlow.submitReviews(id));
    }
    if (method === "DELETE" && parts[2] === "reviews" && parts.length === 4) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能移除检视意见" });
      }
      return done(200, issueFlow.dropReview(id, String(parts[3])));
    }

    // 现场记录导出(GET /issues/:id/export):事件流逐字 + 台账 → 单文件
    // Markdown,人粗读 + 喂 AI 复盘(2026-08-28 拍板)。内容不脱敏,
    // 文件头自带传播提示;disposition 双文件名(ASCII 兜底 + UTF-8 中文)。
    if (method === "GET" && parts[2] === "export" && parts.length === 3) {
      const record = issueFlow.exportWorksite(id);
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${record.filenameAscii}"`
          + `; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
      });
      response.end(record.markdown);
      return true;
    }

    if (method === "GET" && parts[2] === "events" && parts.length === 3) {
      streamIssueEvents(issueFlow, id, response);
      return true;
    }

    if (method === "POST" && parts[2] === "reply" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能续聊" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.reply(id, String(body.text ?? "")));
    }

    if (method === "POST" && parts[2] === "decision" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能作答" });
      }
      const body = await readBody(request);
      const answers = body.answers && typeof body.answers === "object"
        ? Object.fromEntries(Object.entries(body.answers)
          .map(([key, value]) => [key, String(value)]))
        : undefined;
      return done(200, issueFlow.answer(id, {
        state_version: Number(body.state_version),
        decision: String(body.decision ?? ""),
        // 决策码(平台闸的裁决协议):与 decision 并行携带,文案不是匹配键。
        ...(body.code !== undefined ? { code: String(body.code) } : {}),
        ...(answers ? { answers } : {}),
        ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      }));
    }

    // 网管环境配置(env_needed 闸的作答口):登记时没配环境,拉日志/
    // 换库现场举闸后在这里补地址与网管后台密码。密码只经此进 vault(与
    // 登记同一条存储路径),状态/事件里永远只有引用——成功即清闸并开
    // 平台回合让 Agent 重试。闸只收地址+后台密码:页面凭据是登记侧的
    // 四件套,现场补配的流程(抓日志/换库)碰不到网管页面。
    if (method === "POST" && parts[2] === "environment" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能配置网管环境" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.attachEnvironment(id, {
        hosts: Array.isArray(body.hosts) ? body.hosts.map(String) : [],
        ...(body.port !== undefined ? { port: Number(body.port) } : {}),
        backendPassword: String(body.backend_password ?? ""),
      }));
    }

    if (method === "POST" && parts[2] === "interrupt" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能补充" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.steer(id, String(body.text ?? "")));
    }

    if (method === "POST" && parts[2] === "ticket" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能绑定单号" });
      }
      const body = await readBody(request);
      return done(200, issueFlow.bindTicket(id, String(body.ticket ?? "")));
    }

    // 挂起会话关联 DTS 单号转正(固定流程无单场景的收口动作)。
    // 两段式:不带 confirm=校验单号存在并回详情过目;带 confirm=转正
    // 生成新会话(继承分析报告,直接进问题修改)。
    if (method === "POST" && parts[2] === "associate" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能关联单号转正" });
      }
      const body = await readBody(request);
      const result = await issueFlow.associate(id, {
        ticket: String(body.ticket ?? ""),
        ...(body.confirm === true ? { confirm: true } : {}),
      });
      return done(200, result);
    }

    if (method === "POST" && parts[2] === "control" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能操作会话" });
      }
      const body = await readBody(request);
      const kind = ["non_issue", "fixed", "delivered", "issue", "converted"]
        .includes(String(body.kind))
        ? String(body.kind) as "non_issue" | "fixed" | "delivered"
          | "issue" | "converted" : undefined;
      return done(200, issueFlow.control(id, {
        action: body.action === "cancel" ? "cancel" : "archive",
        ...(kind ? { kind } : {}),
        ...(body.summary !== undefined
          ? { summary: String(body.summary) } : {}),
      }));
    }

    return done(404, { error: "未知问题接口" });
  } catch (error) {
    // 单点映射(#9):域错误族 → 状态码 + 对外消息,错误族与口径见
    // errors.ts 的映射表。未登记的失败原样上抛,交服务器兜底 500——
    // 不猜码,也不在路径上各自包一层。
    const mapped = toHttpError(error);
    if (!mapped) throw error;
    return done(mapped.status, { error: mapped.message });
  }
}
