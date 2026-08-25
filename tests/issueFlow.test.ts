/**
 * 问题处理流程(task_type=issue)端到端:every-skill 流程的云端形态。
 *
 * 剧本假模型扮演 Agent 的手,真实链路走全:克隆 → 建分支 → 对齐卡 →
 * RequestDelivery 卡 → 决定 → 宿主推送 + 假平台建 MR。断言的不是
 * 剧本说了什么,而是现场长什么样:远端分支 SHA、MR 落单、待办卡形状、
 * 交付台账跨落盘。退回路径单独一幕:被拒后继续修,再申请才交付。
 * 校验路径:单号必填、单仓限制、lane 不适用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import {
  DELIVERY_APPROVE_OPTION,
  DELIVERY_REJECT_OPTION,
} from "../src/sessionDriver.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const TICKET = "DTS2026082401";
const BRANCH = `master_bot_${TICKET}`;

/** 宿主推送链(cloneRepo 的 safe-git 视图)要建目录符号链接;
 * 未开开发者模式的 Windows 会 EPERM(delivery 等既有交付用例在
 * 同一台机器上同样跑不动)。没条件就显式 skip 并明说,不静默假装测过。 */
const SYMLINK_SKIP: string | undefined = (() => {
  const probe = join(tmpdir(), `mfc-symprobe-${process.pid}`);
  try {
    symlinkSync(tmpdir(), probe, "dir");
    rmSync(probe);
    return undefined;
  } catch {
    return "目录符号链接不可用(Windows 未开开发者模式?)," +
      "宿主克隆/推送链无法执行——同机 delivery.test.ts 亦然";
  }
})();

function kernelRootOrDie(): string {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  return found;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-isrc-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

/** 交付申请卡的问题原文要和 sessionDriver 的工具拼法一致——
 * 断言"卡是真的"而不是"凑巧有张卡"。 */
const DELIVERY_QUESTION =
  `交付申请:推送分支 ${BRANCH} 并创建 MR,是否通过?`;

function walkScript(withRejectLoop: boolean): Scene[] {
  const commit = (label: string) =>
    `git config user.email bot@test && git config user.name bot && ` +
    `git checkout --quiet -b ${BRANCH} 2>/dev/null || true; ` +
    `echo "${label}" > fix.txt && git add fix.txt && ` +
    `git commit --quiet -m "[${TICKET}][fix] ${label}"`;
  const scenes: Scene[] = [
    { tool: { name: "bash", input: { command: commit("第一版修复") } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "对齐·问题根因:空指针来自缓存未清理,确认吗?",
        options: ["确认,按此继续", "不对,以我的答复为准"] },
    ] } } },
  ];
  if (withRejectLoop) {
    scenes.push(
      { tool: { name: "RequestDelivery",
        input: { branch: BRANCH, summary: "第一版:删缓存" } } },
      { tool: { name: "bash", input: { command:
        `echo "第二版修复" > fix.txt && git add fix.txt && `
        + `git commit --quiet -m "[${TICKET}][fix] 第二版:补齐边界"` } } },
    );
  }
  scenes.push(
    { tool: { name: "RequestDelivery",
      input: { branch: BRANCH, summary: "修复缓存未清理导致的空指针" } } },
    { text: "对齐结论已确认,修复已提交,申请交付。" },
  );
  return scenes;
}

interface IssueFixture {
  platform: FakeGitPlatform;
  model: ScriptedModelServer;
  service: TaskService;
  dataDir: string;
}

async function setupIssueFixture(scenes: Scene[]): Promise<IssueFixture> {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-iplat-")));
  await platform.start();
  const model = new ScriptedModelServer(scenes);
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-"));
  // 播种技能(与 serve 同源):真 SKILL.md 经 pi 装载进系统提示,
  // 测试因此覆盖"技能目录能被任务会话真实加载"这一环。
  cpSync(join(REPO_ROOT, "assets", "skills-dts"),
    join(dataDir, "skills-dts"), { recursive: true });
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: kernelRootOrDie(),
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: { platformUrl: platform.baseUrl },
  });
  return { platform, model, service, dataDir };
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
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

function runningTask(service: TaskService, id: string) {
  const task = service.get(id)!;
  if (task.status === "failed") {
    throw new Error(`任务意外失败: ${task.detail}`);
  }
  return task;
}

test("问题处理:对齐卡→交付申请通过→宿主推送+MR,不走内核流水线",
  { skip: SYMLINK_SKIP }, async () => {
  const fixture = await setupIssueFixture(walkScript(false));
  try {
    const created = fixture.service.create(
      `处理 ${TICKET}:删除好友时偶发崩溃,疑似会话缓存未清理。`,
      { taskType: "issue", ticket: TICKET, repo: fixture.platform.barePath });

    // 第一停:对齐卡(grill-question 技能指示的人工闸门)。
    const alignCard = await until(() => {
      const task = runningTask(fixture.service, created.id);
      return task.status === "waiting_for_human"
        && !(task.waiting!.question as any).kind ? task : undefined;
    }, "对齐卡");
    await fixture.service.decide(created.id, {
      state_version: alignCard.waiting!.state_version,
      answers: { "对齐·问题根因:空指针来自缓存未清理,确认吗?":
        "确认,按此继续" },
    });

    // 第二停:交付申请卡——kind 锚定身份,选项是协议原文。
    const deliveryCard = await until(() => {
      const task = runningTask(fixture.service, created.id);
      return task.status === "waiting_for_human"
        && (task.waiting!.question as any).kind === "delivery_request"
        ? task : undefined;
    }, "交付申请卡");
    const card = deliveryCard.waiting!.question as Record<string, any>;
    assert.equal(card.branch, BRANCH);
    assert.deepEqual(card.questions[0].options,
      [DELIVERY_APPROVE_OPTION, DELIVERY_REJECT_OPTION]);
    assert.equal(card.questions[0].question, DELIVERY_QUESTION);
    await fixture.service.decide(created.id, {
      state_version: deliveryCard.waiting!.state_version,
      answers: { [DELIVERY_QUESTION]: DELIVERY_APPROVE_OPTION },
    });

    // 决定通过→Agent 收口→宿主推送+MR→completed。
    const done = await until(() => {
      const task = fixture.service.get(created.id)!;
      return ["completed", "failed"].includes(task.status) ? task : undefined;
    }, "交付收口");
    assert.equal(done.status, "completed", done.detail);
    assert.match(done.delivery?.mr_url ?? "", /\/mr\/\d+$/);
    assert.equal(done.delivery?.mr_state, "已创建");
    // 忠实原流程:不触发权威流水线(质量口径=人工验证,不是 CI)。
    assert.equal(done.delivery?.pipeline, undefined);

    // 平台侧:一张 MR,单号按独立字段递到(不只拼 title)。
    assert.equal(fixture.platform.mergeRequests.length, 1);
    const mr = fixture.platform.mergeRequests[0];
    assert.equal(mr.source_branch, BRANCH);
    assert.equal(mr.target_branch, "master");
    assert.equal(mr.e2e_issues, TICKET);
    assert.equal(fixture.platform.branchSha(BRANCH),
      done.delivery?.git_push?.sha,
      "宿主推送收据必须与远端反查 SHA 一致");

    // 交付台账随 task.json 落盘:重启窗口不丢决定。
    const saved = JSON.parse(
      readFileSync(join(done.workspace, "task.json"), "utf-8"));
    assert.equal(saved.delivery_request?.state, "approved");
    assert.equal(saved.delivery_request?.branch, BRANCH);

    // 技能已物化进工作区(含 Go 工具 bin,会话装载与执行共用这一份)。
    assert.ok(existsSync(join(done.workspace, "skills-dts", "playbook",
      "SKILL.md")));
    assert.ok(existsSync(join(done.workspace, "skills-dts", "fetch-logs",
      "bin", "config.toml")));

    // 不建内核现场:没有下单事实、没有状态文件。
    const repoDir = join(done.workspace, "origin");
    assert.ok(!existsSync(join(repoDir, ".mae-flow-order.json")),
      "问题处理任务不写内核下单事实");
    assert.ok(!existsSync(join(repoDir, ".mae-flow.json")),
      "问题处理任务不进内核流程");

    // transcript 里交付申请成对登记(审计能看见这次申请)。决定经
    // resumeWithDecision 回注,tool_result 记的是**用户决定原文**
    // (renderDecision)——审计账本记人的决定,提示性文案只给模型。
    const rows = readFileSync(join(done.workspace, "transcript.jsonl"),
      "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const names: string[] = [];
    for (const row of rows) {
      for (const block of row.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "RequestDelivery") {
          names.push(`use:${block.input?.branch}`);
        }
        if (block.type === "tool_result"
            && String(block.content ?? "").includes(DELIVERY_APPROVE_OPTION)) {
          names.push("result:approved");
        }
      }
    }
    assert.ok(names.includes(`use:${BRANCH}`), JSON.stringify(names));
    assert.ok(names.includes("result:approved"), JSON.stringify(names));
  } finally {
    await fixture.model.stop();
    await fixture.platform.stop();
  }
});

test("问题处理:交付申请被退回→继续修→再申请通过",
  { skip: SYMLINK_SKIP }, async () => {
  const fixture = await setupIssueFixture(walkScript(true));
  try {
    const created = fixture.service.create(
      `处理 ${TICKET}:删除好友时偶发崩溃。`,
      { taskType: "issue", ticket: TICKET, repo: fixture.platform.barePath });

    const alignCard = await until(() => {
      const task = runningTask(fixture.service, created.id);
      return task.status === "waiting_for_human"
        && !(task.waiting!.question as any).kind ? task : undefined;
    }, "对齐卡");
    await fixture.service.decide(created.id, {
      state_version: alignCard.waiting!.state_version,
      answers: { "对齐·问题根因:空指针来自缓存未清理,确认吗?":
        "确认,按此继续" },
    });

    // 第一次申请:退回。
    const first = await until(() => {
      const task = runningTask(fixture.service, created.id);
      return task.status === "waiting_for_human"
        && (task.waiting!.question as any).kind === "delivery_request"
        ? task : undefined;
    }, "第一次交付申请卡");
    await fixture.service.decide(created.id, {
      state_version: first.waiting!.state_version,
      answers: { [DELIVERY_QUESTION]: DELIVERY_REJECT_OPTION },
      notes: "修复不彻底,边界场景没覆盖,继续改",
    });

    // 第二次申请:通过。
    const second = await until(() => {
      const task = runningTask(fixture.service, created.id);
      return task.status === "waiting_for_human"
        && (task.waiting!.question as any).kind === "delivery_request"
        && task.waiting!.waiting_id !== first.waiting!.waiting_id
        ? task : undefined;
    }, "第二次交付申请卡");
    await fixture.service.decide(created.id, {
      state_version: second.waiting!.state_version,
      answers: { [DELIVERY_QUESTION]: DELIVERY_APPROVE_OPTION },
    });

    const done = await until(() => {
      const task = fixture.service.get(created.id)!;
      return ["completed", "failed"].includes(task.status) ? task : undefined;
    }, "退回后交付收口");
    assert.equal(done.status, "completed", done.detail);
    assert.equal(fixture.platform.mergeRequests.length, 1,
      "退回重修只产生一张 MR");
    // 两笔提交都在推上去的分支里。
    const repoDir = join(done.workspace, "origin");
    const log = git(repoDir, "log", "--format=%s", `${BRANCH}`);
    assert.match(log, /第一版修复/);
    assert.match(log, /第二版:补齐边界/);
  } finally {
    await fixture.model.stop();
    await fixture.platform.stop();
  }
});

test("问题处理下单校验:单号必填、单仓限制、lane 不适用", async () => {
  const fixture = await setupIssueFixture([]);
  try {
    assert.throws(
      () => fixture.service.create("没有单号的问题", {
        taskType: "issue", repo: fixture.platform.barePath }),
      /问题单号/);
    assert.throws(
      () => fixture.service.create("多仓问题", {
        taskType: "issue", ticket: TICKET,
        repos: [fixture.platform.barePath, makeSourceRepo()] }),
      /一个代码仓/);
    assert.throws(
      () => fixture.service.create("带交付方式的问题", {
        taskType: "issue", ticket: TICKET,
        repo: fixture.platform.barePath, lane: "完整开发" }),
      /不适用交付方式/);
  } finally {
    await fixture.model.stop();
    await fixture.platform.stop();
  }
});
