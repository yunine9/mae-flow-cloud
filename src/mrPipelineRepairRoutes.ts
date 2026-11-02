import type { IncomingMessage, ServerResponse } from "node:http";
import { MrPipelineRepairs, PipelineRepairError } from "./mrPipelineRepair.ts";

export async function pipelineRepairRoute(request: IncomingMessage, response: ServerResponse,
  parts: string[], service: MrPipelineRepairs | undefined, account: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<any>,
  json: (response: ServerResponse, status: number, body: unknown) => unknown) {
  if (!service) return json(response, 503, { error: "执行服务尚未启用独立流水线修复" });
  try {
    if (request.method === "GET" && parts.length === 1) return json(response, 200, service.list(account));
    if (request.method === "POST" && parts.length === 1) {
      const body = await readBody(request, 8192);
      return json(response, 202, service.start(body.mr_url, account));
    }
    const id = decodeURIComponent(parts[1] ?? "");
    if (request.method === "GET" && parts.length === 2) return json(response, 200, service.get(id, account));
    if (request.method === "POST" && parts.length === 3) {
      if (parts[2] === "stop") return json(response, 200, service.stop(id, account));
      if (parts[2] === "retry") return json(response, 202, service.retry(id, account));
    }
    return json(response, 404, { error: "未知流水线修复操作" });
  } catch (error) {
    return json(response, error instanceof PipelineRepairError ? error.status : 400,
      { error: error instanceof Error ? error.message : "流水线修复操作失败" });
  }
}
