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
 *   POST   /environments/test                → 测试连接(#151:只探测不落
 *          存储,给新增/编辑弹层用;体 {ip, port?, form?, backend_password},
 *          密码是用户现输的;200 {ok:true} 或 {ok:false, reason})
 *   POST   /environments/:id/probe           → 对已存条目探测一次并持久化
 *          (#151;返回更新后的视图;未知 404)
 *
 * 探测走注入的传输层连接器(probeConnector,缺省 ssh2 实现);测试注入
 * 假连接器,绝不真连 SSH。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  EnvironmentIpConflictError,
  EnvironmentNotFoundError,
  EnvironmentRegistryError,
  type EnvironmentForm,
  type EnvironmentRegistry,
} from "./environmentRegistry.ts";
import {
  buildProbeTarget,
  probeEnvironmentEntry,
  sshProbeConnector,
  type ProbeConnector,
} from "./environmentProbe.ts";

export interface EnvironmentViewer {
  username: string;
  role?: string;
}

export interface EnvironmentRouteOptions {
  registry?: EnvironmentRegistry;
  viewer?: EnvironmentViewer;
  /** 会话鉴权是否启用(测试直连形态没有 auth)。 */
  authEnabled: boolean;
  /** 探活传输层(#151):缺省 ssh2 连接器;测试注入假连接器。 */
  probeConnector?: ProbeConnector;
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

/** 测试连接(表单草稿)的入参校验:与台账录入同一套口径与人话文案
 * (400 走 EnvironmentRegistryError 既有映射),但绝不落任何存储。 */
function probeIp(value: unknown): string {
  const ip = String(value ?? "").trim();
  if (!ip) throw new EnvironmentRegistryError("主 IP不能为空");
  return ip;
}

function probePort(value: unknown): number {
  if (value === undefined || value === null || value === "") return 22;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EnvironmentRegistryError("端口必须是 1-65535");
  }
  return port;
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
  const connector = routeOptions.probeConnector ?? sshProbeConnector;
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
    // 测试连接(#151):弹层里用户现输的值当场验一次,只探测、不落任何
    // 存储——台账、探活状态都不碰。form 字段收下不参与探测:两种形态
    // 的探法都是对主 IP 的 SSH 认证(ADR-0020),探哪个 IP 由录入的
    // 主 IP 决定。探测失败是正常结论不是 HTTP 错误:一律 200 带 ok。
    if (parts.length === 2 && parts[1] === "test" && method === "POST") {
      const body = await readBody(request);
      const password = String(body.backend_password ?? "").trim();
      if (!password) {
        throw new EnvironmentRegistryError("后台密码不能为空");
      }
      const outcome = await connector(
        buildProbeTarget(probeIp(body.ip), probePort(body.port), password),
      );
      return done(200, outcome);
    }
    const id = parts.length === 2 ? decodeURIComponent(parts[1]) : undefined;
    // 已存条目手动探活(#151):用台账后台密码(sopuser)探一次并持久化
    // 三态,返回更新后的视图;未知条目按既有映射 404。
    if (parts.length === 3 && parts[2] === "probe" && method === "POST") {
      const entryId = decodeURIComponent(parts[1]);
      return done(200, await probeEnvironmentEntry(registry, entryId, connector));
    }
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
