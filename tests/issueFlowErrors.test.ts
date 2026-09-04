/**
 * 错误族映射表直测(#9 错误族映射统一)。
 *
 * 两层钉死:
 * 1. toHttpError 纯函数:每族域错误 → 确定的 HTTP 码,未登记的族不猜
 *    (返回 undefined 交服务器兜底 500);
 * 2. 真路由直调:DTS 网关查询失败(原 500/502/409 三种出口)在拉单/
 *    详情/图代理/关联转正四条路归一为 502;未配置归一为 409;既有
 *    404/409 与材料层 400 不漂移。
 *
 * 路由测试手搓请求/响应对象,不养 HTTP 服务器(测试 seam 评审口径)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DtsGatewayUnconfiguredError,
  IssueControlError,
  IssueNotFoundError,
  McpGatewayError,
  toHttpError,
} from "../src/issueFlow/errors.ts";
import { StateConflictError } from "../src/humanGate.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { DtsGateway } from "../src/issueFlow/gateways.ts";

test("映射表直测:每族域错误对应确定的 HTTP 码,未登记的族不猜", () => {
  const notFound = toHttpError(new IssueNotFoundError("issue-1"));
  assert.equal(notFound?.status, 404);
  assert.equal(notFound?.message, "问题会话 issue-1 不存在");

  const control = toHttpError(new IssueControlError("问题标题必填"));
  assert.equal(control?.status, 409);
  assert.equal(control?.message, "问题标题必填", "控制类打回人话直出");

  const conflict = toHttpError(
    new StateConflictError("待办 w-1 版本不匹配(内部细节)"));
  assert.equal(conflict?.status, 409);
  assert.equal(conflict?.message, "问题卡状态已变化(先到决定生效)",
    "冲突固定提示,待办 id/版本号等内部细节不透传");

  const gateway = toHttpError(new McpGatewayError("MCP 网关 HTTP 502: boom"));
  assert.equal(gateway?.status, 502);
  assert.equal(gateway?.message, "MCP 网关 HTTP 502: boom");

  // 未配置是网关失败的子类(凡按网关类处理的地方不必分档),但映射
  // 时子类先判:环境档 409,不落父类的 502。
  assert.ok(new DtsGatewayUnconfiguredError("x") instanceof McpGatewayError);
  const unconfigured = toHttpError(
    new DtsGatewayUnconfiguredError("DTS MCP 网关未配置"));
  assert.equal(unconfigured?.status, 409);
  assert.equal(unconfigured?.message, "DTS MCP 网关未配置");

  assert.equal(toHttpError(new Error("随便什么运行时故障")), undefined,
    "未登记的族不猜码,交服务器兜底 500");
  assert.equal(toHttpError("一段字符串"), undefined);
});

/** 拉单/详情/图代理/关联转正都要撞的假网关:三个方法同一失败。 */
const unreachableGateway: DtsGateway = {
  listByOwner: async () => {
    throw new McpGatewayError("DTS 网关不可达(连接超时)");
  },
  detail: async () => {
    throw new McpGatewayError("DTS 网关不可达(连接超时)");
  },
  proxyFile: async () => {
    throw new McpGatewayError("DTS 网关不可达(连接超时)");
  },
};

/** 走一遍真路由拿 {status, body}——手搓响应对象,不养 HTTP 服务器。 */
function issueCall(
  method: "GET" | "POST" | "PUT",
  parts: string[],
  options: {
    service?: IssueFlowService;
    dts?: DtsGateway;
    payload?: unknown;
    url?: string;
  } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = method === "GET"
      ? { method, url: options.url } as any
      : new EventEmitter() as any;
    request.method = method;
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string | Buffer) => {
          try {
            const text = Buffer.isBuffer(output)
              ? output.toString("utf-8") : output ?? "{}";
            resolve({ status, body: JSON.parse(text) });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      {
        issueFlow: options.service,
        ...(options.dts !== undefined ? { dts: options.dts } : {}),
        authEnabled: false,
      },
    ).catch(reject);
    if (method !== "GET") {
      request.emit("data", Buffer.from(JSON.stringify(options.payload ?? {})));
      request.emit("end");
    }
  });
}

/** 盘上摆一个无单固定流程的挂起会话(关联转正的前置状态)。 */
function seedSuspendedSession(dataDir: string): void {
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-28T08:00:00Z", updated_at: "2026-08-28T09:00:00Z",
    title: "t", description: "", source: "manual",
    scenario: "no_ticket",
    status: "suspended", stage: "conclude", stage_note: "",
    stage_at: "2026-08-28T09:00:00Z",
  }));
}

test("DTS 网关查询失败:拉单/详情/图代理/关联转正四条路同码 502", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-err-502-"));
  seedSuspendedSession(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    dts: unreachableGateway,
  });
  try {
    const list = await issueCall("GET", ["issues", "dts"],
      { service, dts: unreachableGateway });
    assert.equal(list.status, 502, "拉单原来是 500");
    assert.match(list.body.error, /DTS 网关不可达/);

    const detail = await issueCall("GET", ["issues", "dts", "DTS-2026-1001"],
      { service, dts: unreachableGateway });
    assert.equal(detail.status, 502, "详情原来是 500");

    const file = await issueCall("GET", ["issues", "dts-file"],
      { service, dts: unreachableGateway,
        url: "/issues/dts-file?path=%2Fv1%2Fnfs%2Fx.png" });
    assert.equal(file.status, 502, "图代理本来就是 502,不漂移");

    const associate = await issueCall("POST",
      ["issues", "issue-1", "associate"],
      { service, dts: unreachableGateway, payload: { ticket: "DTS-2026-1001" } });
    assert.equal(associate.status, 502,
      "关联转正原来是包一层 409,现与网关失败同码");
    assert.match(associate.body.error, /DTS 网关不可达/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("DTS 网关未配置:同一批路径归一 409(环境档,补配置即成功)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-err-409-"));
  seedSuspendedSession(dataDir);
  // 服务与路由都不给网关:路由走 requireDts 守卫,服务走 associate 的
  // 未配置档——两处都必须是 DtsGatewayUnconfiguredError(409)。
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const list = await issueCall("GET", ["issues", "dts"], { service });
    assert.equal(list.status, 409, "拉单本来就是 409,不漂移");

    const detail = await issueCall("GET", ["issues", "dts", "DTS-2026-1001"],
      { service });
    assert.equal(detail.status, 409, "详情本来就是 409,不漂移");

    const file = await issueCall("GET", ["issues", "dts-file"],
      { service, url: "/issues/dts-file?path=%2Fv1%2Fnfs%2Fx.png" });
    assert.equal(file.status, 409, "图代理原来是 502,现归一到环境档");

    const associate = await issueCall("POST",
      ["issues", "issue-1", "associate"],
      { service, payload: { ticket: "DTS-2026-1001" } });
    assert.equal(associate.status, 409,
      "关联转正的未配置档保持 409(原先按控制错误也是 409)");
    assert.match(associate.body.error, /网关未配置/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("既有族不漂移:404/409/材料层 400 逐分支保持", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-err-keep-"));
  seedSuspendedSession(dataDir);
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const missing = await issueCall("GET", ["issues", "issue-404"], { service });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "问题会话 issue-404 不存在");

    const missingDiff = await issueCall("GET",
      ["issues", "issue-404", "materials", "diff"], { service });
    assert.equal(missingDiff.status, 404,
      "未知会话在材料路径同样按 404 出码(原来被读类 400 兜底吞掉)");

    const noTitle = await issueCall("POST", ["issues"], { service, payload: {} });
    assert.equal(noTitle.status, 409);
    assert.match(noTitle.body.error, /归属账号/);

    const badWrite = await issueCall("PUT",
      ["issues", "issue-1", "materials", "file"],
      { service, payload: { path: "x.md", content: "hi" } });
    assert.equal(badWrite.status, 400,
      "材料层写失败(无已克隆仓)保持 fail-open 400 带人话");
    assert.match(badWrite.body.error, /还没有已克隆的代码仓/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
