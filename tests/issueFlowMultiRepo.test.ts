/**
 * 问题流多仓契约测试(模块带仓,2026-08-28):登记多仓 + 模块校验、
 * 克隆布局(关联仓彼此平等,平铺 repo/<仓名>/)、无单固定流程多仓
 * 端到端(提示词清单/阶段备注/转正继承)。单仓交付链路不因多仓而变:
 * 推送/MR/部署缺省作用于首个登记仓(repo_url 兼容别名),repo 参数
 * 只扩不破。
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

test("仓→工作区映射:全部平铺 repo/<仓名>/,重名加序号,旧单仓字段兼容", () => {
  const workspace = "/ws";
  const multi = issueRepoWorkspaces({
    repo_urls: [
      "https://code.test/a/orders.git",
      "https://code.test/b/orders.git",
      "https://code.test/c/orders.git",
    ],
  } as IssueSessionState, workspace);
  assert.deepEqual(multi.map((repo) => repo.dir), [
    join(workspace, "repo", "orders"),
    join(workspace, "repo", "orders-2"),
    join(workspace, "repo", "orders-3"),
  ], "仓平等(2026-08-28):无主从,平铺命名,同名才加序号");

  const legacy = issueRepoWorkspaces(
    { repo_url: "/data/legacy.git" } as IssueSessionState, workspace);
  assert.deepEqual(legacy.map((repo) => repo.dir), [join(workspace, "repo", "legacy")],
    "旧会话只有 repo_url 也读得出映射(仓名派生)");

  assert.equal(issueRepoWorkspaces({} as IssueSessionState, workspace).length, 0,
    "没登记仓就没有映射");
});

test("issue.json 读取迁移:repo_url 与 repo_urls 双向补齐;push/mr/pipeline 单数账升按仓", () => {
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
    "新清单的首仓回写 repo_url 别名,展示层不用两头兜底");

  // 单数账迁移:push/mr/pipeline → pushes/mrs/pipelines(挂到当时的
  // 首个仓名下)。
  mkdirSync(join(dir, "ledger"), { recursive: true });
  writeFileSync(join(dir, "ledger", "issue.json"), JSON.stringify({
    ...base,
    repo_url: "https://code.test/x.git",
    push: { branch: "master_dev_T1", sha: "a".repeat(40), at: "2026-08-28T00:00:00Z" },
    mr: { branch: "master_dev_T1", title: "[T1] t", url: "http://mr/1", at: "2026-08-28T00:00:00Z" },
    pipeline: {
      sha: "a".repeat(40), status: "success", watching: false,
      started_at: "2026-08-28T00:00:00Z",
      deadline: "2026-08-28T00:10:00Z", round: 1,
    },
  }));
  const ledger = loadState(join(dir, "ledger"))!;
  assert.equal(ledger.pushes?.length, 1);
  assert.equal(ledger.pushes![0].repo, "https://code.test/x.git");
  assert.equal(ledger.pushes![0].branch, "master_dev_T1");
  assert.equal(ledger.mrs?.length, 1);
  assert.equal(ledger.mrs![0].url, "http://mr/1");
  assert.equal(ledger.pipelines?.["https://code.test/x.git"]?.status, "success");
  assert.equal((ledger as { push?: unknown }).push, undefined, "单数字段退役");
});

test("登记校验:无单必须带模块与环境(两模式同等);模块存在/在架/非零仓;四件套缺一打回;有单不拦", () => {
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
    // 零仓模块是存量脏数据(保存口已强制至少一仓),登记同样机械打回。
    mkdirSync(join(dataDir, "business-modules", "empty-mod"), { recursive: true });
    writeFileSync(
      join(dataDir, "business-modules", "empty-mod", "module.json"),
      `${JSON.stringify({
        id: "empty-mod", name: "空模块", description: "没绑仓",
        owner: "dev", maintainers: [], repositories: [], status: "active",
        revision: 1, assets: [],
        created_at: new Date().toISOString(), created_by: "tester",
        updated_at: new Date().toISOString(), updated_by: "tester",
      }, null, 2)}\n`,
    );

    // 登记门禁(#17):无单号必须指名业务模块并带网管环境,固定/自由
    // 两模式同等;三种模块失败各有其文案。
    assert.throws(
      () => service.create({ account: "dev", title: "t" }),
      /必须指定业务模块/,
    );
    assert.throws(
      () => service.create({ account: "dev", title: "t", mode: "free" }),
      /必须指定业务模块/, "自由探索同等拦截",
    );
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "pay-core",
      }),
      /必须配置网管环境/,
    );
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
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "empty-mod",
        environment: { hosts: ["10.0.0.8"], pagePassword: "p", backendPassword: "b" },
      }),
      /先补绑定/,
    );
    // 四件套缺一:缺地址 / 缺页面密码 / 缺后台密码各有其文案。
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "pay-core",
        environment: { hosts: [], pagePassword: "p", backendPassword: "b" },
      }),
      /服务器地址/,
    );
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "pay-core",
        environment: { hosts: ["10.0.0.8"], pagePassword: " ", backendPassword: "b" },
      }),
      /页面密码/,
    );
    assert.throws(
      () => service.create({
        account: "dev", title: "t", moduleId: "pay-core",
        environment: { hosts: ["10.0.0.8"], pagePassword: "p", backendPassword: "" },
      }),
      /后台密码/,
    );
    // 有单号登记(DTS 页签):不带模块与环境照常放行,环境可会话内
    // 经 env_needed 闸现场补。
    const deferred = service.create({ account: "dev", title: "无仓登记", ticket: "DTS1" });
    assert.equal(deferred.repo_url, undefined, "无仓登记不再拦截");
    assert.equal(deferred.scenario, "ticket");
    // 上限:9 个仓拒(模块库允许绑 20,会话拉取封顶 8)。
    assert.throws(
      () => service.create({
        account: "dev", title: "t",
        repoUrls: Array.from({ length: 9 }, (_, index) =>
          `https://code.test/r${index}.git`),
      }),
      /最多拉取/,
    );
    // 多仓去重:同址出现两次只落一份。
    const created = service.create({
      account: "dev", title: "重复仓登记", ticket: "DTS2",
      repoUrl: origin, repoUrls: [origin, origin],
    });
    const state = loadState(join(dataDir, "issues", created.id))!;
    assert.deepEqual(state.repo_urls, [origin], "去重后只留一份");
  } finally {
    void service.shutdown().catch(() => undefined);
  }
});

test("无单多仓端到端:模块带仓,AI 逐仓 pull_repo 落到 repo/<仓名>/ 平铺,转正全继承", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-mr-e2e-"));
  // 三个裸仓名相同,钉死 repo/ 平铺命名的去重序号。
  const originA = bareOriginAt(join(dataDir, "a"), "origin.git");
  const originB = bareOriginAt(join(dataDir, "b"), "origin.git");
  const originC = bareOriginAt(join(dataDir, "c"), "origin.git");
  const TICKET = "DTS-2026-1002";
  const script: Scene[] = [
    { tool: { name: "lookup_modules", input: { keyword: "支付" } } },
    { tool: { name: "bind_module", input: { module_id: "pay-core" } } },
    { tool: { name: "pull_repo", input: { url: originA } } },
    { tool: { name: "pull_repo", input: { url: originB } } },
    { tool: { name: "pull_repo", input: { url: originC } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:是问题。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:接口超时" } } },
    { text: "等用户确认。" },
    // 转正会话首轮(fix 阶段):停机白名单下以问题卡合法停机,不再裸文本收轮。
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "已继承分析报告与多仓工作区,继续修复?",
      options: ["继续", "先停"],
      recommended: "继续",
    }] } } },
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
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    assert.equal(created.scenario, "no_ticket");
    assert.deepEqual(created.repo_urls, [originA, originB, originC],
      "模块绑定按序带出登记清单");
    assert.equal(created.repo_url, originA, "首个登记仓别名同步");
    assert.equal(created.module, "支付核心", "模块名称由模块库派生");
    assert.equal(created.module_id, "pay-core");

    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "无单结论闸");

    // 克隆由 AI 逐仓 pull_repo 落地:平铺布局必须齐。
    const root = join(dataDir, "issues", created.id);
    assert.ok(existsSync(join(root, "repo", "origin", ".git")), "首仓 repo/origin/");
    assert.ok(existsSync(join(root, "repo", "origin-2", ".git")), "同名仓加序号");
    assert.ok(existsSync(join(root, "repo", "origin-3", ".git")), "第三仓齐装");
    const entered = service.get(created.id);
    assert.equal(entered.stage_states?.[1], "done", "拉仓阶段随自报收口完成");
    assert.equal(entered.stage, "conclude", "无单场景走到结论节点");
    assert.ok((entered.transitions ?? []).filter((entry) =>
      /代码仓已拉取/.test(entry.note ?? "")).length >= 3,
    "逐仓拉取各留转移账");

    // 提示词把仓清单连同工作区路径讲清楚:开场时未拉的仓如实标注
    // "待拉取"并指路 pull_repo;本地路径仓必须显式声明克隆源不可直接
    // 读(issue-24 踩坑)。
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /repo\/origin-2\//);
    assert.match(requestText, /待拉取\(调 pull_repo 拉它\)/);
    assert.match(requestText, /一律平铺在 repo\/ 下/);
    assert.match(requestText, /克隆自本地路径 [^"]*origin\.git\(那是工作区外的源,不可直接读/);

    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "issue",
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
    assert.ok(existsSync(join(newRoot, "repo", "origin", ".git")), "首仓工作区继承");
    assert.ok(existsSync(join(newRoot, "repo", "origin-2", ".git")),
      "多仓工作区继承(免二次克隆)");
    const branch = spawnSync("git", ["-C", join(newRoot, "repo", "origin"),
      "branch", "--show-current"], { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(), `master_dev_${TICKET}`,
      "转正时宿主给每个在场仓切好新单号分支");

    await until(() => {
      const issue = service.get(converted!.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "转正会话首轮以问题卡停机");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
