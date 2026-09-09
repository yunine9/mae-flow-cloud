/**
 * 环境管理 HTTP 路由(/environments/*;票 #149,ADR-0020)。
 *
 * 台账是全局团队资源:四条路由都只要已登录会话——不做 own() 归属闸、
 * 不做 admin 403("管理员不处理问题单"约束的是问题会话写路由,对环境
 * 台账不适用,admin 同样可管理);写操作记 updated_by(取会话账号)。
 * 机密只出"已配置"布尔与非密元信息;密码本体永远只在密封信封里,
 * 解密路径(registry.secrets)只供服务端消费方直连,不经任何 HTTP 面。
 *
 *   GET    /environments      → 台账列表(非密字段)
 *   POST   /environments      → 录入(201 视图;IP 撞车 409 带 existing_id)
 *   PUT    /environments/:id  → 编辑(密码留空=不变;IP 撞车 409;未知 404)
 *   DELETE /environments/:id  → 删除(未知 404)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EnvironmentIpConflictError,
  EnvironmentNotFoundError,
  EnvironmentRegistryError,
  type EnvironmentForm,
  type EnvironmentRegistry,
} from "./environmentRegistry.ts";

export interface EnvironmentViewer {
  username: string;
  role?: string;
}

export interface EnvironmentRouteOptions {
  registry?: EnvironmentRegistry;
  viewer?: EnvironmentViewer;
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

/** 处理 /environments/* 请求;返回 false 表示与环境管理无关。 */
export async function handleEnvironmentRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  routeOptions: EnvironmentRouteOptions,
): Promise<boolean> {
  if (parts[0] !== "environments") return false;
  const { registry } = routeOptions;
  if (!registry) {
    json(response, 404, { error: "环境管理服务未启用" });
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
  const actor = String(viewer?.username ?? "");
  try {
    if (parts.length === 1 && method === "GET") {
      return done(200, { environments: registry.list() });
    }
    if (parts.length === 1 && method === "POST") {
      const body = await readBody(request);
      return done(201, registry.create({
        ip: String(body.ip ?? ""),
        ...(body.port !== undefined ? { port: Number(body.port) } : {}),
        form: String(body.form ?? "") as EnvironmentForm,
        backendPassword: String(body.backend_password ?? ""),
        ...(body.root_password === undefined
          ? {} : { rootPassword: body.root_password as string | null }),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
      }, actor));
    }
    const id = parts.length === 2 ? decodeURIComponent(parts[1]) : undefined;
    if (id !== undefined && method === "PUT") {
      const body = await readBody(request);
      return done(200, registry.update(id, {
        ...(body.ip !== undefined ? { ip: String(body.ip) } : {}),
        ...(body.port !== undefined ? { port: Number(body.port) } : {}),
        ...(body.form !== undefined
          ? { form: String(body.form) as EnvironmentForm } : {}),
        // 密码不回显、留空 = 不变:缺席就别碰,空串由模块按"不变"消化。
        ...(body.backend_password !== undefined
          ? { backendPassword: String(body.backend_password) } : {}),
        ...(body.root_password === undefined
          ? {} : { rootPassword: body.root_password as string | null }),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map(String) } : {}),
      }, actor));
    }
    if (id !== undefined && method === "DELETE") {
      registry.remove(id);
      return done(200, { ok: true });
    }
    return done(404, { error: "未知环境管理接口" });
  } catch (error) {
    if (error instanceof EnvironmentIpConflictError) {
      return done(409, { error: error.message, existing_id: error.existingId });
    }
    if (error instanceof EnvironmentNotFoundError) {
      return done(404, { error: error.message });
    }
    if (error instanceof EnvironmentRegistryError) {
      return done(400, { error: error.message });
    }
    throw error;
  }
}
