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
 *   GET  /issues/:id/materials/file   → 读工作区文件(?path=)
 *   PUT  /issues/:id/materials/file   → 快速修改(仅归属者;入人工台账)
 *   GET  /issues/:id/materials/log    → 读拉取日志(?name=,超长读尾)
 *   GET  /issues/:id/materials/events → 原始事件尾随(?limit=,现场页签)
 *   GET  /issues/:id/timeline         → 耗时与卡点(纯函数归纳,只读)
 *   GET  /issues/:id/analysis         → 结论文档 issue-analysis.md
 *                                      (缺失为 200 {unavailable},不 404)
 *   GET  /issues/:id/events           → SSE:事件流尾随
 *   POST /issues/:id/reply            → 续聊
 *   POST /issues/:id/decision         → 问题卡作答
 *   POST /issues/:id/interrupt        → 插话
 *   POST /issues/:id/ticket           → 绑定单号
 *   POST /issues/:id/control          → 归档/取消
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { IssueFlowService } from "./service.ts";
import {
  IssueControlError,
  IssueNotFoundError,
} from "./service.ts";
import { StateConflictError } from "../humanGate.ts";
import { isTerminal } from "./state.ts";

export interface IssueViewer {
  username: string;
  role?: string;
}

export interface IssueRouteOptions {
  issueFlow?: IssueFlowService;
  viewer?: IssueViewer;
  /** 会话鉴权是否启用(测试直连形态没有 auth)。 */
  authEnabled: boolean;
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
  const path = issueFlow.eventLogPath(id);
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
      const created = issueFlow.create({
        account: String(body.account ?? viewer?.username ?? ""),
        title: String(body.title ?? ""),
        description: body.description === undefined
          ? undefined : String(body.description),
        source: body.source === "dts" ? "dts" : "manual",
        ...(body.ticket ? { ticket: String(body.ticket) } : {}),
        ...(body.repo_url ? { repoUrl: String(body.repo_url) } : {}),
        ...(body.baseline ? { baseline: String(body.baseline) } : {}),
        ...(body.module ? { module: String(body.module) } : {}),
        ...(body.environment ? {
          environment: {
            name: body.environment.name === undefined
              ? undefined : String(body.environment.name),
            hosts: Array.isArray(body.environment.hosts)
              ? body.environment.hosts.map(String) : [],
            ...(body.environment.port !== undefined
              ? { port: Number(body.environment.port) } : {}),
            password: String(body.environment.password ?? ""),
          },
        } : {}),
      });
      return done(201, created);
    }

    if (method === "GET" && parts[1] === "dts" && parts.length === 2) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const tickets = await issueFlow.listDts(String(viewer?.username ?? ""));
      return done(200, { tickets });
    }

    // 单张问题单详情(页签展开用):登录即可查本人名下任意单。
    if (method === "GET" && parts[1] === "dts" && parts.length === 3) {
      if (viewer?.role === "admin") {
        return done(403, { error: "管理员不处理问题单" });
      }
      const ticket = decodeURIComponent(parts[2]);
      if (!ticket) return done(400, { error: "缺少问题单号" });
      const detail = await issueFlow.getDtsDetail(ticket);
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
      try {
        const file = await issueFlow.proxyDtsFile(path);
        response.writeHead(200, {
          "content-type": file.contentType,
          "cache-control": "public, max-age=86400",
        });
        response.end(file.data);
      } catch (reason) {
        return done(502, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
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

    // ---- 会话材料(交付材料页签)。读:本人或管理员;写(快速修改):
    // 仅会话归属者。路径防穿越在 service/materials 层双保险,这里只做
    // 归属与参数兜底。fail-open 语义:读类故障以 400 带人话返回,页面
    // 给空态,不拖垮会话。
    if (parts[2] === "materials" && parts.length === 3) {
      return done(200, issueFlow.listMaterials(id));
    }
    if (method === "PUT" && parts[2] === "materials"
        && parts[3] === "file" && parts.length === 4) {
      if (brief && !own(brief.account)) {
        return done(403, { error: "只能修改自己会话的工作区" });
      }
      const body = await readBody(request);
      try {
        return done(200, issueFlow.saveWorkspaceFile(
          id, String(body.path ?? ""), String(body.content ?? "")));
      } catch (reason) {
        return done(400, {
          error: String(reason instanceof Error ? reason.message : reason),
        });
      }
    }
    if (parts[2] === "materials" && parts.length === 4 && method === "GET") {
      const query = new URL(request.url ?? "/", "http://x").searchParams;
      try {
        if (parts[3] === "diff") {
          return done(200, {
            diff: issueFlow.workspaceFileDiff(id, String(query.get("path") ?? "")),
          });
        }
        if (parts[3] === "file") {
          return done(200, issueFlow.readWorkspaceFile(
            id, String(query.get("path") ?? "")));
        }
        if (parts[3] === "log") {
          return done(200, issueFlow.readIssueLog(id, String(query.get("name") ?? "")));
        }
        if (parts[3] === "events") {
          const raw = Number(query.get("limit") ?? 200);
          const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 200;
          return done(200, { events: issueFlow.recentEvents(id, limit) });
        }
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

    // 结论文档 issue-analysis.md(只读):404 只发生在问题号未知;
    // 文档还没生成为 200 {unavailable},前端据此出空态而不是报错。
    if (method === "GET" && parts[2] === "analysis" && parts.length === 3) {
      return done(200, issueFlow.analysis(id));
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
        ...(answers ? { answers } : {}),
        ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
      }));
    }

    if (method === "POST" && parts[2] === "interrupt" && parts.length === 3) {
      if (viewer?.role === "admin" || !brief || !own(brief.account)) {
        return done(403, { error: "只有归属人能插话" });
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
    if (error instanceof IssueNotFoundError) {
      return done(404, { error: error.message });
    }
    if (error instanceof IssueControlError) {
      return done(409, { error: error.message });
    }
    if (error instanceof StateConflictError) {
      return done(409, { error: "问题卡状态已变化(先到决定生效)" });
    }
    throw error;
  }
}
