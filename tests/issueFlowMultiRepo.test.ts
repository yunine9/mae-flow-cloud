/**
 * 问题流多仓契约测试(模块带仓,2026-08-28):登记多仓 + 模块校验、
 * 克隆布局(主仓 repo/ + 参考仓 ref/<仓名>/)、无单固定流程多仓端到端
 * (提示词清单/阶段备注/转正继承)。单仓交付链路不因多仓而变:推送/
 * MR/部署默认仍作用主仓,repo 参数只扩不破。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import {
  issueRepoWorkspaces,
  loadState,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import {
  createBusinessModule,
  updateBusinessModule,
} from "../src/businessModuleLibrary.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端,名字自定(多仓重名目录测试要用)。 */
function bareOriginAt(root: string, name: string): string {
  const seed = join(root, `seed-${name.replace(/\.git$/, "")}`);
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, name);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("仓→工作区映射:主仓 repo/,参考仓 ref/<仓名>/,重名加序号,旧单仓字段兼容", () => {
  const workspace = "/ws";
  const multi = issueRepoWorkspaces({
    repo_urls: [
      "https://code.test/a/orders.git",
      "https://code.test/b/orders.git",
      "https://code.test/c/orders.git",
    ],
  } as IssueSessionState, workspace);
  assert.deepEqual(multi.map((repo) => repo.dir), [
    join(workspace, "repo"),
    join(workspace, "ref", "orders"),
    join(workspace, "ref", "orders-2"),
  ], "主仓不占 ref/ 命名空间;参考仓同名才加序号");

  const legacy = issueRepoWorkspaces(
    { repo_url: "/data/legacy.git" } as IssueSessionState, workspace);
  assert.deepEqual(legacy.map((repo) => repo.dir), [join(workspace, "repo")],
    "旧会话只有 repo_url 也读得出主仓");

  assert.equal(issueRepoWorkspaces({} as IssueSessionState, workspace).length, 0,
    "没登记仓就没有映射");
});

test("issue.json 读取迁移:repo_url 与 repo_urls 双向补齐", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-issue-multirepo-"));
  const base = {
    id: "issue-1", account: "dev", created_at: "2026-08-28T00:00:00Z",
    updated_at: "2026-08-28T00:00:00Z", title: "t", description: "",
    source: "manual", status: "idle", stage: "registered",
    stage_note: "", stage_at: "2026-08-28T00:00:00Z",
  };
  mkdirSync(join(dir, "old"), { recursive: true });
  writeFileSync(join(dir, "old", "issue.json"),
    JSON.stringify({ ...base, repo_url: "https://code.test/x.git" }));
  const loaded = loadState(join(dir, "old"))!;
  assert.deepEqual(loaded.repo_urls, ["https://code.test/x.git"],
    "旧单仓字段读进来补出权威清单");
  assert.equal(loaded.repo_url, "https://code.test/x.git");

  mkdirSync(join(dir, "new"), { recursive: true });
  writeFileSync(join(dir, "new", "issue.json"), JSON.stringify({
    ...base,
    repo_urls: ["https://code.test/x.git", "https://code.test/y.git"],
  }));
  const migrated = loadState(join(dir, "new"))!;
  assert.equal(migrated.repo_url, "https://code.test/x.git",
    "新清单的主仓回写别名,展示层不用两头兜底");
});

test("登记校验:模块必须存在且在架;仓数有上限;fixed 无仓照旧拦截", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-mr-"));
  const origin = bareOriginAt(dataDir, "origin.git");
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: {},
    issueFlowMode: () => "fixed",
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const archived = createBusinessModule(dataDir, {
      id: "old-core", name: "旧模块", description: "已下线",
      owner: "dev", repositories: [origin],
    }, "tester");
    updateBusinessModule(dataDir, archived.id,
      { status: "archived" }, "tester", true, true);

    // 模块不存在/已归档:fail-loud,不让编造的 module_id 落盘。
    assert.throws(
      () => service.create({ account: "dev", title: "t", moduleId: "nope" }),
      /不存在/,
    );
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "old-core",
      }),
      /已归档/,
    );
    // 上限:9 个仓拒(模块库允许绑 20,会话拉取封顶 8)。
    assert.throws(
      () => service.create({
        account: "dev", title: "t",
        repoUrls: Array.from({ length: 9 }, (_, index) =>
          `https://code.test/r${index}.git`),
      }),
      /最多拉取/,
    );
    // fixed 无仓:文案指向"选模块或填地址"。
    assert.throws(
      () => service.create({ account: "dev", title: "t" }),
      /选择业务模块自动带出/,
    );
    // 多仓去重:同址出现两次只落一份。
    const created = service.create({
      account: "dev", title: "重复仓登记",
      repoUrl: origin, repoUrls: [origin, origin],
    });
    const state = loadState(join(dataDir, "issues", created.id))!;
    assert.deepEqual(state.repo_urls, [origin], "去重后只留一份");
  } finally {
    void service.shutdown().catch(() => undefined);
  }
});

test("无单多仓端到端:模块带仓克隆到 repo/+ref/,提示词与阶段备注交代清单,转正全继承", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-mr-e2e-"));
  // 三个裸仓:主仓之外的参考仓们 basename 相同,钉死 ref/ 目录去重。
  const originA = bareOriginAt(join(dataDir, "a"), "origin.git");
  const originB = bareOriginAt(join(dataDir, "b"), "origin.git");
  const originC = bareOriginAt(join(dataDir, "c"), "origin.git");
  const TICKET = "DTS-2026-1002";
  const script: Scene[] = [
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:是问题。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:接口超时" } } },
    { text: "等用户确认。" },
    // 转正会话首轮(fix 阶段)。
    { text: "继承分析报告,开始修复。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    issueFlowMode: () => "fixed",
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [originA, originB, originC],
    }, "tester");
    const created = service.create({
      account: "dev", title: "下单超时",
      moduleId: "pay-core",
    });
    assert.equal(created.scenario, "no_ticket");
    assert.deepEqual(created.repo_urls, [originA, originB, originC],
      "模块绑定按序带出,首个=主仓");
    assert.equal(created.repo_url, originA, "主仓别名同步");
    assert.equal(created.module, "支付核心", "模块名称由模块库派生");
    assert.equal(created.module_id, "pay-core");

    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "无单结论闸");

    // 克隆是异步回合里做的:prep_repo 收口(结论闸在场)后布局必须齐。
    const root = join(dataDir, "issues", created.id);
    assert.ok(existsSync(join(root, "repo", ".git")), "主仓克隆在 repo/");
    assert.ok(existsSync(join(root, "ref", "origin", ".git")), "参考仓在 ref/origin/");
    assert.ok(existsSync(join(root, "ref", "origin-2", ".git")),
      "同名参考仓目录加序号");
    const entered = service.get(created.id);
    assert.ok(entered.transitions?.some((entry) =>
      /3 个代码仓已克隆/.test(entry.note ?? "")),
    "prep_repo 收口的转移账要交代多仓事实");

    // 提示词把仓清单连同工作区路径讲清楚,交付/参考角色不混淆。
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /ref\/origin-2/);
    assert.match(requestText, /交付仓/);
    assert.match(requestText, /参考仓/);

    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      decision: "确认是问题,挂起等提单",
    });
    await until(() =>
      service.get(created.id).status === "suspended" ? 1 : undefined, "挂起");

    const { converted } = await service.associate(created.id,
      { ticket: TICKET, confirm: true });
    assert.ok(converted, "确认转正返回新会话");
    assert.deepEqual(converted!.repo_urls, [originA, originB, originC],
      "转正继承多仓");
    assert.equal(converted!.module_id, "pay-core", "模块留痕继承");
    assert.equal(converted!.module, "支付核心");
    const newRoot = join(dataDir, "issues", converted!.id);
    assert.ok(existsSync(join(newRoot, "repo", ".git")), "主仓工作区继承");
    assert.ok(existsSync(join(newRoot, "ref", "origin-2", ".git")),
      "参考仓工作区继承(免二次克隆)");
    const branch = spawnSync("git", ["-C", join(newRoot, "repo"),
      "branch", "--show-current"], { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(), `master_dev_${TICKET}`,
      "宿主建分支仍只在主仓");

    await until(() => {
      const issue = service.get(converted!.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "转正会话首轮收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
