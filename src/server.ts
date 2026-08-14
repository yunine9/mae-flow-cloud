/**
 * 任务 API(主 spec §5.1/§5.2):REST 命令 + SSE 事件流,零框架依赖。
 *
 *   POST /tasks                {requirement}            → 201 摘要
 *   GET  /tasks                                         → 列表
 *   GET  /tasks/:id                                     → 详情(含待办)
 *   POST /tasks/:id/decision   {state_version,decision,notes?}
 *        → 200;版本冲突/已被抢先 → 409 "任务状态已变化"(先到决定生效)
 *   GET  /tasks/:id/events                              → SSE:重放事件日志后持续跟进
 *
 * Web 不自行推断状态:详情与列表只是 TaskService 状态的镜像,
 * 事件流只是 events.jsonl 的镜像——真相都在文件与状态机里。
 */

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { StateConflictError } from "./humanGate.ts";
import { NotFoundError, type TaskService } from "./taskService.ts";
import { WEB_PAGE } from "./webPage.ts";

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

export function createTaskServer(service: TaskService): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(WEB_PAGE);
      }
      if (request.method === "POST" && url.pathname === "/tasks") {
        const body = await readBody(request);
        const requirement = String(body.requirement ?? "").trim();
        if (!requirement) {
          return json(response, 400, { error: "requirement 不能为空" });
        }
        return json(response, 201, service.create(requirement, {
          account: body.account ? String(body.account) : undefined,
        }));
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

/** SSE:先重放事件日志,再轮询追加行;客户端断开即停。 */
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
  let closed = false;
  response.on("close", () => (closed = true));
  const push = () => {
    if (closed) return;
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
      for (; offset < lines.length; offset += 1) {
        response.write(`data: ${lines[offset]}\n\n`);
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
