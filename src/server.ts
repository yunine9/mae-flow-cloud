/**
 * 任务 API(主 spec §5.1/§5.2):REST 命令 + SSE 事件流,零框架依赖。
 *
 *   POST /tasks                {requirement}            → 201 摘要
 *   GET  /tasks                                         → 列表
 *   GET  /tasks/:id                                     → 详情(含待办)
 *   POST /tasks/:id/decision   {state_version,decision,notes?}
 *        → 200;版本冲突/已被抢先 → 409 "任务状态已变化"(先到决定生效)
 *   GET  /tasks/:id/events                              → SSE:重放事件日志后持续跟进
 *   GET  /tasks/:id/timeline                            → 人话交付时间线(只读现场)
 *
 * Web 不自行推断状态:详情与列表只是 TaskService 状态的镜像,
 * 事件流只是 events.jsonl 的镜像——真相都在文件与状态机里。
 */

import { createServer, type Server } from "node:http";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { StateConflictError } from "./humanGate.ts";
import { NotFoundError, type TaskService } from "./taskService.ts";
import { buildTimeline } from "./timeline.ts";
import { WEB_PAGE } from "./webPage.ts";
import {
  cookieValue,
  type AuthUser,
  type LocalAuth,
} from "./auth.ts";

/** 正式前端静态文件的最小类型表:Vite 产物就这几种。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

function readBody(request: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

export function createTaskServer(
  service: TaskService,
  options: { webRoot?: string; auth?: LocalAuth } = {},
): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const sessionToken = cookieValue(
        request.headers.cookie,
        "mae_flow_session",
      );
      const viewer = options.auth?.sessionUser(sessionToken);

      // 登录页资产公开，身份 API 自己决定是否需要会话。
      if (parts[0] === "auth") {
        if (request.method === "POST" && parts[1] === "login") {
          if (!options.auth) {
            return json(response, 404, { error: "未启用本地登录" });
          }
          const body = await readBody(request);
          const result = options.auth.authenticate(
            String(body.username ?? ""),
            String(body.password ?? ""),
            request.socket.remoteAddress ?? "unknown",
          );
          if (result.blockedForMs) {
            response.setHeader(
              "retry-after",
              String(Math.ceil(result.blockedForMs / 1000)),
            );
            return json(response, 429, {
              error: "登录失败次数过多，请稍后再试",
            });
          }
          if (!result.user) {
            return json(response, 401, { error: "账号或密码错误" });
          }
          const token = options.auth.createSession(result.user);
          response.setHeader("set-cookie", sessionCookie(token, request));
          return json(response, 200, result.user);
        }
        if (request.method === "GET" && parts[1] === "me") {
          return viewer
            ? json(response, 200, viewer)
            : json(response, 401, { error: "尚未登录" });
        }
        if (request.method === "POST" && parts[1] === "logout") {
          options.auth?.endSession(sessionToken);
          response.setHeader("set-cookie", sessionCookie("", request, true));
          return json(response, 200, { ok: true });
        }
        if (parts[1] === "users") {
          if (!viewer) return json(response, 401, { error: "尚未登录" });
          if (viewer.role !== "admin") {
            return json(response, 403, { error: "只有管理员可以管理账号" });
          }
          if (request.method === "GET" && parts.length === 2) {
            return json(response, 200, options.auth?.listUsers() ?? []);
          }
          if (request.method === "POST" && parts.length === 2) {
            const body = await readBody(request);
            try {
              const user = options.auth!.createUser(
                String(body.username ?? ""),
                String(body.password ?? ""),
                String(body.role ?? "developer") as "admin" | "developer",
              );
              return json(response, 201, user);
            } catch (error) {
              return json(response, 400, { error: String(error) });
            }
          }
        }
        return json(response, 404, { error: "未知身份接口" });
      }

      const protectedRoute =
        url.pathname === "/history" || parts[0] === "tasks";
      if (options.auth && protectedRoute && !viewer) {
        return json(response, 401, { error: "请先登录" });
      }

      // 历史读侧(§11):任务摘要投影来自 PG,跨进程生命周期。
      // 必须先于静态托管兜底判定——非 /tasks 前缀的 GET 会被它接管。
      if (request.method === "GET" && url.pathname === "/history") {
        const projection = service.options.projection;
        if (!projection) {
          return json(response, 404,
            { error: "未配置 PostgreSQL 投影(--pg),没有历史可查" });
        }
        return json(response, 200, await projection.listTaskHistory());
      }
      // 静态前端(webRoot=React 构建产物):/ 与非 API 路径出文件;
      // 没配 webRoot 时零构建演示页兜底——两种形态永远有一个能用。
      if (request.method === "GET"
          && (url.pathname === "/" || parts[0] !== "tasks")) {
        const file = options.webRoot
          ? staticFile(options.webRoot, url.pathname)
          : undefined;
        if (file) {
          response.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
          });
          return response.end(readFileSync(file));
        }
        if (url.pathname === "/") {
          response.writeHead(200,
            { "content-type": "text/html; charset=utf-8" });
          return response.end(WEB_PAGE);
        }
        return json(response, 404, { error: "未知路径" });
      }
      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readBody(request);
        const requirement = String(body.requirement ?? "").trim();
        if (!requirement) {
          return json(response, 400, { error: "requirement 不能为空" });
        }
        const requested = body.account ? String(body.account) : undefined;
        const account = viewer?.role === "developer"
          ? viewer.username
          : requested;
        return json(response, 201, service.create(requirement, { account }));
      }
      if (request.method === "GET" && url.pathname === "/tasks") {
        return json(response, 200, service.list());
      }
      if (parts[0] === "tasks" && parts.length >= 2) {
        const id = parts[1];
        if (request.method === "GET" && parts.length === 2) {
          const task = service.get(id);
          if (!task) return json(response, 404, { error: `任务 ${id} 不存在` });
          return json(response, 200, task);
        }
        if (request.method === "POST" && parts[2] === "decision") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能处理分配给自己的任务" });
          }
          const body = await readBody(request);
          const task = await service.decide(id, {
            state_version: Number(body.state_version),
            decision: body.decision !== undefined
              ? String(body.decision) : undefined,
            answers: body.answers && typeof body.answers === "object"
              ? body.answers : undefined,
            notes: body.notes ? String(body.notes) : undefined,
          });
          return json(response, 200, task);
        }
        if (request.method === "GET" && parts[2] === "events") {
          return streamEvents(service, id, response);
        }
        // 重跑一单(run7 实测的运维刚需):环境故障被迫收口的任务,
        // 修好环境后续接内核当前步骤,不从头再来。终态校验在服务层。
        if (request.method === "POST" && parts[2] === "retry") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          if (!canOperate(viewer, target.luban_account, !!options.auth)) {
            return json(response, 403, { error: "只能重跑分配给自己的任务" });
          }
          return json(response, 200, service.retry(id));
        }
        // 交付时间线(只读):现场文件读成人话,权限口径同任务详情
        // ——能看任务就能看它经历了什么。纯展示,不参与判定。
        if (request.method === "GET" && parts[2] === "timeline") {
          const target = service.get(id);
          if (!target) return json(response, 404, { error: `任务 ${id} 不存在` });
          // 代码工作区经现成的公开方法反推:面板在 <cwd>/.mae-flow-work/
          // 之下,拿不到就交给 buildTimeline 自己在工作区里找。
          const panel = service.panelFile(id, "panel.html")
            ?? service.panelFile(id, "panel-pulse.js");
          const cwd = panel ? dirname(dirname(panel)) : undefined;
          return json(response, 200,
            buildTimeline(target.workspace, cwd));
        }
        // 审计读侧(§11):外部动作台账来自 PG 投影。没配投影时
        // 明说,而不是空数组装作"没有动作"。
        if (request.method === "GET" && parts[2] === "actions") {
          const projection = service.options.projection;
          if (!projection) {
            return json(response, 404,
              { error: "未配置 PostgreSQL 投影(--pg),没有台账可查" });
          }
          return json(response, 200, await projection.listActions(id));
        }
        // 内核现场面板(铁原则:请用户检视的东西必须在面板可见)。
        // panel 是内核生成的单文件 HTML,pulse/stamp 是它的自动刷新
        // 探针(相对路径 script src),同前缀一起放行。
        if (request.method === "GET" && parts.length === 3
            && ["panel", "panel-pulse.js", "panel-stamp.js"]
              .includes(parts[2])) {
          const name = parts[2] === "panel" ? "panel.html" : parts[2];
          const file = service.panelFile(id, name);
          if (!file) {
            return json(response, 404, {
              error: "这个任务还没有现场面板(流程未初始化或演练模式)",
            });
          }
          response.writeHead(200, {
            "content-type": name.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
          });
          return response.end(readFileSync(file));
        }
      }
      return json(response, 404, { error: "未知路径" });
    } catch (error) {
      if (error instanceof StateConflictError) {
        // 先到决定生效:后到的提交必须知道自己没生效,不能静默吞掉。
        return json(response, 409, { error: `任务状态已变化: ${error.message}` });
      }
      if (error instanceof NotFoundError) {
        return json(response, 404, { error: error.message });
      }
      return json(response, 500, { error: String(error) });
    }
  });
}

function canOperate(
  viewer: AuthUser | undefined,
  taskAccount: string | undefined,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) return true;
  return viewer?.role === "admin"
    || (!!viewer && !!taskAccount && viewer.username === taskAccount);
}

function sessionCookie(
  token: string,
  request: import("node:http").IncomingMessage,
  expired = false,
): string {
  const secure = request.headers["x-forwarded-proto"] === "https"
    ? "; Secure"
    : "";
  const age = expired ? 0 : 8 * 60 * 60;
  return `mae_flow_session=${encodeURIComponent(token)}; Path=/; HttpOnly; `
    + `SameSite=Strict; Max-Age=${age}${secure}`;
}

/** webRoot 内定位静态文件:/ → index.html。resolve 后必须仍在
 * webRoot 里——路径穿越不是 404 的一种,是攻击,直接不认。 */
function staticFile(
  webRoot: string,
  pathname: string,
): string | undefined {
  const root = resolve(webRoot);
  const target = resolve(
    join(root, pathname === "/" ? "index.html" : pathname));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return existsSync(target) && statSync(target).isFile()
    ? target
    : undefined;
}

/** SSE:先重放事件日志,再轮询追加行;客户端断开即停。
 *
 * 增量读:按字节偏移只取新增部分——整文件重读在长日志下是
 * O(n²) 读放大(run7 现场几百 KB,每 300ms 全量读一遍)。
 * 事件行必须完整推送:尾部没换行的半行(写入方还在写)连同
 * 可能被读界切开的 UTF-8 多字节字符一起留在 carry(按字节存,
 * 提前解码就是乱码),凑齐换行才出手。 */
function streamEvents(
  service: TaskService,
  id: string,
  response: import("node:http").ServerResponse,
): void {
  if (!service.get(id)) {
    return json(response, 404, { error: `任务 ${id} 不存在` });
  }
  const path = service.eventLogPath(id);
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
    const status = service.get(id)?.status;
    if (status === "completed" || status === "failed") {
      response.end();
      return;
    }
    setTimeout(push, 300);
  };
  push();
}
