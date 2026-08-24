import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IssueEnvironmentVault,
  type IssueEnvironmentAdapter,
} from "../src/issueEnvironment.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function repository(root: string): string {
  const path = join(root, "business-repo");
  execFileSync("git", ["init", "-q", "-b", "master", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty", "-m", "init"],
    { env: GIT_ENV });
  return path;
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

test("问题单环境保险箱:API 引用无密码、宿主可解密、文件不是明文", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-vault-"));
  const vault = new IssueEnvironmentVault(dataDir);
  const refs = vault.store("task-1", [{
    name: "灰度 A",
    purpose: "logs",
    host: "10.0.0.8",
    port: 22,
    accounts: [
      { username: "sopuser", password: "secret-sop" },
      { username: "ossuser", password: "secret-oss" },
      { username: "ossadm", password: "secret-adm" },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].accounts.map((account) => account.username),
    ["sopuser", "ossuser", "ossadm"]);
  assert.equal(refs[0].accounts.some((account) => "password" in account), false);
  assert.deepEqual(vault.credential("task-1", refs[0].id, "ossadm"), {
    username: "ossadm",
    password: "secret-adm",
  });
  assert.equal(vault.credentials("task-1", refs[0].id).length, 3);
  const ciphertext = readFileSync(
    join(dataDir, ".issue-environments", "task-1.json"), "utf8");
  assert.doesNotMatch(ciphertext, /secret-sop|secret-oss|secret-adm|sopuser|10\.0\.0\.8/);
  vault.remove("task-1");
  assert.equal(existsSync(join(dataDir, ".issue-environments", "task-1.json")), false);
});

test("DTS 最小闭环:Cloud 诊断举卡，确认后同任务切入内核 hotfix", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-flow-"));
  const repo = repository(dataDir);
  const ticket = "DTS20260824001";
  const artifact = join(".mae-flow-work", ticket, "issue-analysis.md");
  const script: Scene[] = [
    {
      text: "读取代码与宿主采集日志，形成根因分析。",
      tool: { name: "bash", input: { command:
        `mkdir -p "${join(".mae-flow-work", ticket)}" && `
        + `printf '%s' '# 根因分析\n\n证据、修改范围与验证方案已核对。\n' > "${artifact}"` } },
    },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "是否确认上述根因、修改范围与验证方案？",
      options: ["需要调整", "确认根因与修改方案"],
    }] } } },
    { text: "已确认，诊断会话收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const seenPasswords: string[] = [];
  const adapter: IssueEnvironmentAdapter = {
    async fetchLogs(request) {
      seenPasswords.push(...request.credentials.map((item) => item.password));
      return { content: "ERROR playback init failed", source: "/var/log/app.log" };
    },
  };
  const kernelRoot = discoverKernelRoot(process.cwd());
  assert.ok(kernelRoot, "仓内应带可用内核快照");
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot },
    issueEnvironmentAdapter: adapter,
  });
  try {
    const created = service.create("启动播放器后偶发黑屏", {
      entryKind: "dts",
      title: "播放器偶发黑屏",
      account: "dev",
      repo,
      ticket,
      issueEnvironments: [{
        name: "灰度 A",
        purpose: "logs",
        host: "10.0.0.8",
        accounts: [
          { username: "sopuser", password: "dts-password-sop" },
          { username: "ossuser", password: "dts-password-oss" },
          { username: "ossadm", password: "dts-password-adm" },
        ],
      }],
    });
    assert.equal(created.entry_kind, "dts");
    assert.equal(created.issue_context?.stage, "triage");
    assert.equal(created.issue_context?.adapter.logs, true);
    assert.deepEqual(created.issue_context?.environments[0].accounts
      .map((account) => account.username), ["sopuser", "ossuser", "ossadm"]);
    assert.equal(created.lane, "已定位问题修复",
      "Cloud 诊断确认后应进入内核 hotfix，不走完整需求链");

    const waiting = await until(() => {
      const task = service.get(created.id)!;
      if (task.status === "failed") throw new Error(task.detail);
      return task.status === "waiting_for_human" ? task : undefined;
    }, "DTS 根因确认卡");
    assert.deepEqual(waiting.progress?.phases, [
      "问题受理", "证据与根因分析", "人工确认", "代码修复",
      "推送前验证", "流水线与合入", "完成",
    ]);
    assert.equal(waiting.progress?.current_phase, "人工确认");
    assert.equal(waiting.progress?.step, "等待确认诊断问题");
    assert.equal(waiting.waiting?.step, "问题诊断 / 根因确认",
      "Web 与小鲁班应拿到 DTS 专属审批阶段，而不是空的当前步骤");
    assert.deepEqual(seenPasswords,
      ["dts-password-sop", "dts-password-oss", "dts-password-adm"],
      "只有宿主适配器能拿到同一环境的三套密码");
    const requestText = JSON.stringify(model.requests[0]);
    assert.doesNotMatch(requestText, /dts-password-sop|dts-password-oss|dts-password-adm/);
    assert.match(requestText, /sopuser、ossuser、ossadm/);
    assert.match(requestText, /问题诊断前置阶段/);
    assert.ok(existsSync(join(dataDir, created.id, "repositories",
      ".mae-flow-work", ticket, "environment-logs",
      `${created.issue_context!.environments[0].id}.log`)));
    assert.equal(existsSync(join(dataDir, created.id, "repositories",
      "1-business-repo", ".mae-flow.json")), false,
    "诊断阶段不能提前初始化 Mae-Flow 内核");

    const confirmed = await service.decide(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "确认根因与修改方案",
    });
    assert.equal(confirmed.issue_context?.stage, "delivery");
    assert.equal(service.get(created.id)?.progress?.current_phase, "代码修复",
      "诊断交给 hotfix 后产品级进度不能倒退回问题受理");
    assert.ok(existsSync(join(dataDir, created.id, "issue-analysis.md")),
      "人工背书的诊断文档应随同一任务交给内核");
    const orderPath = await until(() => {
      const path = join(dataDir, created.id, "business-repo",
        ".mae-flow-order.json");
      return existsSync(path) ? path : undefined;
    }, "Mae-Flow hotfix 下单事实");
    const order = JSON.parse(readFileSync(orderPath, "utf8")) as Record<string, unknown>;
    assert.equal(order["交付方式"], "已定位问题修复");
    assert.equal(order["需求文档"], ".mae-flow-issue.md");
    assert.ok(existsSync(join(dataDir, created.id, "business-repo",
      ".mae-flow-issue.md")), "内核应直接消费已确认的诊断文档");
    const taskJson = readFileSync(join(dataDir, created.id, "task.json"), "utf8");
    assert.doesNotMatch(taskJson, /dts-password-sop|dts-password-oss|dts-password-adm/);

    await service.cancel(created.id, "tester");
    assert.equal(existsSync(join(dataDir, ".issue-environments",
      `${created.id}.json`)), false, "取消/任务结束后临时密码必须清理");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("DTS 输入边界:必须一单一仓，普通需求不能夹带环境密码", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-input-"));
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: discoverKernelRoot(process.cwd())! },
  });
  assert.throws(() => service.create("问题", {
    entryKind: "dts", ticket: "DTS1",
    repos: ["https://codehub/a.git", "https://codehub/b.git"],
  }), /一张问题单对应一个代码仓/);
  assert.throws(() => service.create("普通需求", {
    entryKind: "requirement", ticket: "REQ1", repo: "https://codehub/a.git",
    issueEnvironments: [{
      name: "x", purpose: "logs", host: "h",
      accounts: [{ username: "sopuser", password: "p" }],
    }],
  }), /只有 DTS 问题单入口/);
  const accounts = [
    { username: "sopuser", password: "p1" },
    { username: "ossuser", password: "p2" },
    { username: "ossadm", password: "p3" },
  ];
  assert.throws(() => service.create("问题", {
    entryKind: "dts", ticket: "DTS2", repo: "https://codehub/a.git",
    issueEnvironments: [
      { name: "日志一", purpose: "logs", host: "h1", accounts },
      { name: "日志二", purpose: "logs", host: "h2", accounts },
    ],
  }), /日志环境和换库环境都只能各配置一个/);
  assert.throws(() => service.create("问题", {
    entryKind: "dts", ticket: "DTS3", repo: "https://codehub/a.git",
    issueEnvironments: [{
      name: "日志", purpose: "logs", host: "h",
      accounts: [{ username: "sopuser", password: "p" }],
    }],
  }), /必须配置 sopuser、ossuser、ossadm/);
});

test("DTS 恢复:服务在确认卡期间重启，决定仍能交给内核 hotfix", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-recovery-"));
  const repo = repository(dataDir);
  const ticket = "DTS20260824002";
  const artifact = join(".mae-flow-work", ticket, "issue-analysis.md");
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command:
      `mkdir -p "${join(".mae-flow-work", ticket)}" && `
      + `printf '%s' '# 根因分析\n\n重启恢复测试。\n' > "${artifact}"` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "是否确认上述根因、修改范围与验证方案？",
      options: ["需要调整", "确认根因与修改方案"],
    }] } } },
  ]);
  await model.start();
  const kernelRoot = discoverKernelRoot(process.cwd())!;
  const service1 = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1, host: { kernelRoot },
  });
  let service2: TaskService | undefined;
  try {
    const created = service1.create("恢复后仍应修复同一问题", {
      entryKind: "dts", title: "诊断恢复", account: "dev", repo, ticket,
    });
    await until(() => service1.get(created.id)?.status === "waiting_for_human"
      ? true : undefined, "重启前根因确认卡");
    await service1.shutdown();

    service2 = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), maxConcurrent: 1, host: { kernelRoot },
    });
    service2.recover();
    const recovered = service2.get(created.id)!;
    assert.equal(recovered.status, "waiting_for_human");
    assert.ok(recovered.waiting);
    await service2.decide(created.id, {
      state_version: recovered.waiting!.state_version,
      decision: "确认根因与修改方案",
    });
    const orderPath = await until(() => {
      const path = join(dataDir, created.id, "business-repo",
        ".mae-flow-order.json");
      return existsSync(path) ? path : undefined;
    }, "恢复后的 Mae-Flow hotfix 下单事实");
    const order = JSON.parse(readFileSync(orderPath, "utf8")) as Record<string, unknown>;
    assert.equal(order["交付方式"], "已定位问题修复");
    assert.equal(order["需求文档"], ".mae-flow-issue.md");
    await service2.cancel(created.id, "tester");
  } finally {
    await service1.shutdown().catch(() => undefined);
    await service2?.shutdown().catch(() => undefined);
    await model.stop();
  }
});
