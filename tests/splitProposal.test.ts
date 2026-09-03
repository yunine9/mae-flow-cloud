/**
 * Agent 在开发中提议拆分(docs/delivery-unit-split-design.md 2026-09-03 勘误)。
 *
 * 2026-09-03 用户拍板:下单时的「大需求先分析再拆分」开关取消——拆不拆是
 * 分析的产物,下单的人在信息最少的时刻判不准;读完仓的 Agent 才判得准。
 * 这里真跑一遍接力:单仓直接开发会话里剧本模型调 propose_split → 宿主
 * 受理、掐掉会话、按分析单重新排队 → 分析会话写方案与机读图、举确认卡
 * → 人确认后按单元生成两个串行子任务。宿主模式无内核跑:编码会话用假件
 * 顶替(真编码会话要内核+容器,那条链由 rejectionPaths 等覆盖),分析会话
 * 真跑只读克隆与剧本模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function until<T>(
  probe: () => T | undefined, what: string, timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("单仓直接开发的 Agent 提议拆分:受理→掐会话→按分析单重启→确认卡两单元→串行子任务", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-split-proposal-"));
  const repo = join(dataDir, "svc-core");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const ticket = "REQ2026090301";
  const artifactDir = join(".mae-flow-work", ticket);
  const graphJson = JSON.stringify({
    repositories: [
      { id: "unit-contract", name: "svc-core", url: repo,
        responsibility: "接口契约骨架,整体编译得过",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-filter", name: "svc-core", url: repo,
        responsibility: "过滤模块实现",
        scope: { name: "过滤实现", paths: ["src/filter/"] } },
    ],
    dependencies: [],
  });
  // 分析会话的剧本:写方案与机读图,举确认卡。编码会话用假件顶替
  // (真编码会话要内核+容器,那条链由 rejectionPaths 等覆盖),这里
  // 只验"提议→转身→分析单真跑→确认→拆单"这段接力。
  const analysisScenes: Scene[] = [
    { text: "分析现场:写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-core && mkdir -p "${artifactDir}" && ` +
        `printf '%s' '# 拆分方案\n契约先行,过滤在后。\n' ` +
        `> "${join(artifactDir, `CHAIN-${ticket}.md`)}" && ` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(analysisScenes);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 0,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    // 下单没有开关:单仓就是普通任务,退化图 stage=confirmed。
    const parent = service.create("通知按用户偏好过滤", {
      account: "cloudbot", ticket, repos: [repo],
    });
    assert.equal(parent.requirement_analysis_requested, undefined);
    assert.equal(parent.requirement_graph?.stage, "confirmed");
    const internal = service as any;
    const state = internal.tasks.get(parent.id);
    assert.equal(internal.splitTools(state).length, 1,
      "单仓直接开发的主任务挂 propose_split");

    // 假装编码会话正在跑:running + 假 driver,只记有没有被掐掉。
    internal.queue = internal.queue.filter((id: string) => id !== parent.id);
    let aborted = false;
    let disposed = false;
    state.summary.status = "running";
    state.cwd = join(dataDir, "old-coding-clone");
    state.mission = "旧使命";
    state.driver = {
      abort: async () => { aborted = true; },
      dispose: () => { disposed = true; },
      pendingSteers: () => [], takeUndeliveredSteers: () => [],
    };
    const reply = internal.proposeSplit(state, {
      reason: "要改 14 处:偏好存储 3 个文件、过滤逻辑 5 个、装配与构建 6 处",
      suggested_units: ["契约骨架:接口与注册占位", "过滤实现"],
    });
    assert.match(reply, /已受理/);
    assert.match(reply, /不要再调用任何工具/);
    const escalated = service.get(parent.id)!;
    assert.match(escalated.split_escalation!.reason, /14 处/);
    assert.deepEqual(escalated.split_escalation!.suggested_units,
      ["契约骨架:接口与注册占位", "过滤实现"]);
    assert.equal(escalated.requirement_analysis_requested, true,
      "受理即落盘:重启后仍是分析单");
    assert.equal(escalated.requirement_graph?.stage, "analysis",
      "退化图退回分析态,等 Agent 写新图");
    // 再提就是拒绝,不抛错、不重复转身。
    assert.match(internal.proposeSplit(state, { reason: "再来一次" }),
      /已经是分析拆分单|已受理/);
    assert.equal(internal.splitTools(state).length, 0,
      "分析单不再挂 propose_split");

    // 转身在下一拍:掐会话、清现场指针、按分析单排队。
    const queued = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "queued" ? now : undefined;
    }, "转身排队");
    assert.ok(aborted && disposed, "旧编码会话必须被掐掉并释放");
    assert.equal(state.driver, undefined);
    assert.equal(state.cwd, undefined, "旧编码现场作废,分析单重新只读克隆");
    assert.equal(state.mission, undefined);
    assert.equal(state.resume, false);
    assert.match(queued.detail, /已转为先分析再拆分:要改 14 处/);
    assert.ok(internal.queue.includes(parent.id));

    // 放开并发,分析单真跑:只读克隆到 repositories/,分析剧本写图、举卡。
    internal.options.maxConcurrent = 1;
    void internal.pump();
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human"
        && (now.requirement_graph?.repositories.length ?? 0) === 2 ? now : undefined;
    }, "拆分确认卡");
    assert.deepEqual(card.requirement_graph!.repositories.map((node) => node.scope?.name),
      ["契约骨架", "过滤实现"]);
    assert.match(state.cwd ?? "", /repositories$/, "分析现场在 workspace/repositories");
    // 分析提示词把上一位 Agent 的判断当起点,不当结论。
    const prompt = internal.requirementAnalysisPrompt(state, state.cwd);
    assert.match(prompt, /上一位 Agent.*判断改动面过大/);
    assert.match(prompt, /偏好存储 3 个文件/);
    assert.match(prompt, /它建议的切法:\n1\. 契约骨架:接口与注册占位\n2\. 过滤实现/);
    assert.match(prompt, /切法可以推翻/);

    // 人确认:单号逐单元定(父单号不下传),同仓两单元串行。
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: { "unit-contract": "cloudbot", "unit-filter": "cloudbot" },
      repository_tickets: { "unit-contract": "REQ2026090302", "unit-filter": "REQ2026090303" },
    });
    assert.equal(confirmed.status, "coordinating");
    const graph = service.get(parent.id)!.requirement_graph!;
    const contractChild = service.get(graph.repositories[0].task_id!)!;
    const filterChild = service.get(graph.repositories[1].task_id!)!;
    await service.cancel(contractChild.id, "tester");
    await service.cancel(filterChild.id, "tester");
    assert.deepEqual(filterChild.blocked_by, [contractChild.id],
      "同仓第二个单元必须等第一个合入(串行不变)");
    assert.equal(contractChild.ticket, "REQ2026090302");
    assert.equal(internal.splitTools(internal.tasks.get(filterChild.id)).length, 0,
      "子任务不挂 propose_split");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("拒绝口径:子任务、多仓、已推送、非运行中都不受理,只回一句话", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-split-proposal-guard-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const internal = service as any;
  const fake = (summary: Record<string, unknown>) => ({
    summary: { status: "running", repositories: ["git@x:a/b.git"], ...summary },
    controlEpoch: 0,
  });
  try {
    assert.match(internal.proposeSplit(fake({ parent_task_id: "task-1" }),
      { reason: "x" }), /子任务/);
    assert.match(internal.proposeSplit(fake({ repositories: ["a", "b"] }),
      { reason: "x" }), /分析拆分单|单仓/);
    assert.match(internal.proposeSplit(fake({ delivery: { sha: "abc" } }),
      { reason: "x" }), /已有推送/);
    assert.match(internal.proposeSplit(fake({ status: "queued" }),
      { reason: "x" }), /queued/);
    assert.match(internal.proposeSplit(fake({}), { reason: "   " }), /不能为空/);
    assert.equal(internal.splitTools(fake({ parent_task_id: "task-1" })).length, 0);
    assert.equal(internal.splitTools(fake({ repositories: ["a", "b"] })).length, 0);
    assert.equal(internal.splitTools(fake({})).length, 1,
      "单仓直接开发的主任务挂 propose_split");
  } finally {
    void service.shutdown();
  }
});
