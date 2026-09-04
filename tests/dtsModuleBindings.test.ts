/**
 * DTS 单号→模块人工预绑(spec #57,T1 后端纵切):
 * - 绑定存储:写读往返/持久化/解绑幂等/last-write-wins 留痕/校验打回
 * - 路由:GET 全量、PUT 单条(绑定与解绑),人工 module_id 发起烙印锁
 * - 锁死语义:预绑会话里 bind_module 被拒(回执经模型请求可见);
 *   无预绑会话 AI 绑模块维持现状
 * - 开场词渲染锁定语义(经模型请求断言,提示词与工具双保险)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { loadState, type IssueSessionState } from "../src/issueFlow/state.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import {
  createBusinessModule,
  updateBusinessModule,
} from "../src/businessModuleLibrary.ts";
import {
  createIssueTools,
  type IssueToolContext,
} from "../src/issueFlow/tools.ts";
import { FIXED_TICKET_STAGES } from "../src/issueFlow/stageRegistry.ts";
import {
  DtsModuleBindingError,
  readDtsModuleBindings,
  setDtsModuleBinding,
} from "../src/dtsModuleBindings.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(模块绑定的仓),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return join(root, "origin.git");
}

async function makeModelService(dataDir: string, script: Scene[]): Promise<{
  model: ScriptedModelServer;
  service: IssueFlowService;
}> {
  const model = new ScriptedModelServer(script);
  // modelsJson() 需要 baseUrl:start 之后再构造服务。
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  return { model, service };
}

/** 走一遍真路由(无 HTTP 服务器):GET 版。 */
function issueGet(
  parts: string[],
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url: `/${parts.join("/")}` } as any,
      {
        writeHead: (code: number) => { status = code; },
        end: (payload?: string) => {
          try {
            resolve({ status, body: JSON.parse(payload ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" } },
    ).catch(reject);
  });
}

/** PUT 版(带 JSON 体)。 */
function issuePut(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "PUT";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" } },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

/** POST 版(带 JSON 体)。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" } },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("绑定存储:写读往返、持久化、解绑幂等、last-write-wins 留痕", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  createBusinessModule(dataDir, {
    id: "msg-gate", name: "消息网关", description: "消息路由与限流",
    owner: "dev", repositories: [origin],
  }, "tester");

  assert.deepEqual(readDtsModuleBindings(dataDir), {}, "缺席=空映射");

  setDtsModuleBinding(dataDir, "DTS20260901001", "pay-core", "alice");
  const first = readDtsModuleBindings(dataDir);
  assert.equal(first["DTS20260901001"]?.module_id, "pay-core");
  assert.equal(first["DTS20260901001"]?.updated_by, "alice");
  assert.ok(first["DTS20260901001"]?.updated_at);

  // 重新从盘上读(模拟另一个进程/重启):绑定仍在。
  assert.equal(
    readDtsModuleBindings(dataDir)["DTS20260901001"]?.module_id, "pay-core");

  // last-write-wins:bob 改绑覆盖 alice,留痕更新。
  setDtsModuleBinding(dataDir, "DTS20260901001", "msg-gate", "bob");
  const rebound = readDtsModuleBindings(dataDir)["DTS20260901001"];
  assert.equal(rebound?.module_id, "msg-gate");
  assert.equal(rebound?.updated_by, "bob");

  // 解绑幂等:清一次删除,再清一次不报错。
  setDtsModuleBinding(dataDir, "DTS20260901001", null, "bob");
  assert.equal(readDtsModuleBindings(dataDir)["DTS20260901001"], undefined);
  setDtsModuleBinding(dataDir, "DTS20260901001", null, "bob");

  // 单号格式打回(与问题流服务端同一把尺)。
  assert.throws(() => setDtsModuleBinding(dataDir, "坏 单号", "pay-core", "a"),
    DtsModuleBindingError);
  // 缺操作人打回。
  assert.throws(() => setDtsModuleBinding(dataDir, "DTS1", "pay-core", " "),
    DtsModuleBindingError);
  // 模块不存在打回。
  assert.throws(
    () => setDtsModuleBinding(dataDir, "DTS1", "ghost", "a"),
    /不存在或元数据不可读/);
  assert.ok(!existsSync(join(dataDir, "dts-module-bindings.json.tmp")),
    "原子写不留半截临时文件");
});

test("绑定校验:已归档模块打回,不能绑到单号上", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-arch-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "old-mod", name: "退役模块", description: "已归档",
    owner: "dev", repositories: [origin],
  }, "tester");
  updateBusinessModule(dataDir, "old-mod", { status: "archived" },
    "tester", false, true);
  assert.throws(
    () => setDtsModuleBinding(dataDir, "DTS1", "old-mod", "a"),
    /已归档/);
  assert.deepEqual(readDtsModuleBindings(dataDir), {},
    "打回不留半截绑定");
});

test("绑定路由:PUT 绑定/解绑、GET 全量;域校验打回 409", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-api-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const put = await issuePut(
      ["issues", "dts-bindings", "DTS20260901002"],
      { module_id: "pay-core" }, service);
    assert.equal(put.status, 200);
    assert.equal(put.body.module_id, "pay-core");

    const list = await issueGet(["issues", "dts-bindings"], service);
    assert.equal(list.status, 200);
    assert.equal(list.body.bindings["DTS20260901002"]?.module_id, "pay-core");

    const clear = await issuePut(
      ["issues", "dts-bindings", "DTS20260901002"], { module_id: "" }, service);
    assert.equal(clear.status, 200);
    assert.equal(clear.body.cleared, true);
    assert.equal(
      (await issueGet(["issues", "dts-bindings"], service))
        .body.bindings["DTS20260901002"], undefined);

    const badTicket = await issuePut(
      ["issues", "dts-bindings", encodeURIComponent("坏 单号")],
      { module_id: "pay-core" }, service);
    assert.equal(badTicket.status, 409);
    assert.match(badTicket.body.error, /格式不合法/);

    const ghost = await issuePut(
      ["issues", "dts-bindings", "DTS20260901003"],
      { module_id: "ghost" }, service);
    assert.equal(ghost.status, 409);
    assert.match(ghost.body.error, /不存在/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("人工预绑发起:落盘含模块/仓/锁定烙印;开场词锁定语义到达模型", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-lock-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 最小剧本:开场后一句收口,回合自然落地。
  const script: Scene[] = [
    { text: "收到,模块已预绑,直接开始研究。" },
  ];
  const { model, service } = await makeModelService(dataDir, script);
  try {
    const created = await issuePost(["issues"], {
      account: "dev",
      title: "支付对账偶发不平",
      source: "dts",
      ticket: "DTS20260901010",
      module_id: "pay-core",
    }, service);
    assert.equal(created.status, 201);

    await until(() => {
      const issue = service.get(created.body.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "预绑会话首轮收口");

    const state = loadState(join(dataDir, "issues", created.body.id));
    assert.equal(state?.module_id, "pay-core", "预绑模块落盘");
    assert.equal(state?.module_locked, true, "人工预绑必须烙印锁定");
    assert.deepEqual(state?.repo_urls, [origin], "仓来自模块绑定");

    // 锁定语义经开场词到达模型(提示词保险;硬闸在工具直调里测)。
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /人工在发起时预绑并锁定/);
    assert.match(requestText, /不要调用 bind_module/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("工具级锁:锁定会话 bind_module 被拒;未锁会话可绑可改绑(现状不变)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-tool-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  createBusinessModule(dataDir, {
    id: "msg-gate", name: "消息网关", description: "消息路由与限流",
    owner: "dev", repositories: [origin],
  }, "tester");
  const now = new Date().toISOString();
  const base: IssueSessionState = {
    id: "issue-x", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: "DTS20260901013",
    scenario: "ticket" as const, round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending" as const),
    status: "idle" as const, stage: "prep_repo" as const,
    stage_note: "", stage_at: now,
  };
  const textOf = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0].text;

  // 锁定:改绑被拒,状态原地不动,回执指路 AskUserQuestion。
  const locked: IssueSessionState = {
    ...base,
    module_id: "pay-core", module: "支付核心", module_locked: true,
    repo_url: origin, repo_urls: [origin],
  };
  const lockedCtx: IssueToolContext = {
    state: locked, workspace: "/tmp/ws", dataRoot: dataDir,
    persist: () => undefined,
    pullRepo: async () => ({ dir: "repo/origin", cloned: true,
      head: "a".repeat(12) }),
  };
  const lockedBind = (createIssueTools(lockedCtx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>).find((tool) => tool.name === "bind_module");
  assert.ok(lockedBind, "应注册 bind_module");
  await assert.rejects(
    () => lockedBind.execute("x", { module_id: "msg-gate" }),
    /人工预绑锁定,不能调用 bind_module 改绑/);
  assert.match(await lockedBind.execute("x", { module_id: "msg-gate" })
    .then(() => "").catch((error: Error) => error.message),
    /AskUserQuestion/, "回执必须指路人工通道");
  assert.equal(locked.module_id, "pay-core", "改绑尝试不生效");
  assert.deepEqual(locked.repo_urls, [origin], "仓清单不被改绑尝试污染");

  // 对照:未锁会话(无预绑)AI 自己绑与改绑维持现状。
  const unlocked: IssueSessionState = { ...base };
  const unlockedCtx: IssueToolContext = {
    state: unlocked, workspace: "/tmp/ws", dataRoot: dataDir,
    persist: () => undefined,
    pullRepo: async () => ({ dir: "repo/origin", cloned: true,
      head: "a".repeat(12) }),
  };
  const unlockedTools = createIssueTools(unlockedCtx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const unlockedBind = unlockedTools.find((tool) => tool.name === "bind_module");
  assert.ok(unlockedBind);
  const receipt = textOf(await unlockedBind.execute(
    "x", { module_id: "msg-gate" }));
  assert.match(receipt, /已绑定业务模块「消息网关」/);
  assert.equal(unlocked.module_id, "msg-gate");
  assert.equal(unlocked.module_locked, undefined, "AI 自绑不锁");
  await unlockedBind.execute("x", { module_id: "msg-gate" });
  assert.ok((unlocked.transitions ?? []).some((entry) =>
    /改绑为「消息网关」/.test(entry.note)),
    "未锁会话可改绑(现状不变),改绑入账");
  assert.equal(unlocked.module_id, "msg-gate");
});

test("服务端自动匹配(matchDtsToModule 路径)不带锁:机器猜测不等于人工预绑", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-bind-auto-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 直接走服务层:路由里 autoModuleId 传 moduleId 但不带 moduleLocked。
    const created = service.create({
      account: "dev", title: "t", source: "dts",
      ticket: "DTS20260901012", moduleId: "pay-core",
    });
    const state = loadState(join(dataDir, "issues", created.id));
    assert.equal(state?.module_id, "pay-core");
    assert.equal(state?.module_locked, undefined,
      "自动匹配是机器猜测,不得烙印人工预绑锁");
    assert.equal(created.module, "支付核心");
  } finally {
    // 回合会因假 provider 失败,不影响登记字段落盘断言。
    void service.shutdown().catch(() => undefined);
  }
  assert.ok(readFileSync(
    join(dataDir, "issues", "issue-1", "issue.json"), "utf-8"));
});
