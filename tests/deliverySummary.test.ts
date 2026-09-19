import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliverySummaries, DELIVERY_SUMMARY_FILE, DELIVERY_SUMMARY_ARTIFACT } from "../src/deliverySummary.ts";
import { deliverySourceTool, runDeliverySummaryAgent, validateSummaryDiagrams, type DeliverySummaryInput } from "../src/deliverySummaryAgent.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { listArtifactDocuments, readArtifact } from "../src/artifacts.ts";

const diagram = '## 改动图\n```plantuml\n@startuml\ncomponent "查询接口\\n修改" as api #LightBlue\ncomponent "配置组件\\n既有" as config\napi --> config : 查询网元配置\n@enduml\n```\n\n## 改动要点\n- 查询复用配置组件。\n\n## 测试情况\n| 业务场景 | 用例变化 | 执行情况 |\n|---|---|---|\n| 空结果 | 新增 UT | 未确认 |';
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "delivery-summary-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "service.cpp"), "// initial\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(repo, "service.cpp"), "// first delivery\n"); git("commit", "-qam", "first");
  const head = git("rev-parse", "HEAD");
  const task: any = { cwd: repo, summary: { id: "task-15", workspace: repo, status: "verifying", requirement: "查询", delivery: {
    git_push: { sha: head }, mr_url: "https://code.example/mr/15", target_branch: "main",
  } } };
  return { repo, git, base, head, task, dispose: () => rmSync(repo, { recursive: true, force: true }) };
}

test("首次旁路不等待，冻结输入，完成后可读；循环和重启不重复生成", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let runs = 0, notified = 0;
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} }, onPublished: () => { notified++; } }), async input => {
      runs++;
      assert.equal(input.head, f.head);
      assert.equal(input.base, f.base);
      assert.equal(JSON.parse(input.context).test_records.pipeline, undefined);
      await blocked;
      return diagram;
    });
    summaries.start(f.task);
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    f.task.summary.delivery.pipeline = "success";
    f.task.summary.delivery.git_push.sha = "b".repeat(40);
    summaries.start(f.task);
    release(); await summaries.flush();
    assert.equal(runs, 1); assert.equal(notified, 1);
    assert.equal(f.task.summary.status, "verifying");
    const content = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    assert.match(content, new RegExp(f.head)); assert.match(content, /首次交付快照/);
    const sources = { taskMaterialRoot: f.repo };
    assert.ok(listArtifactDocuments(f.repo, sources).some(item => item.name === DELIVERY_SUMMARY_ARTIFACT));
    assert.equal(readArtifact(f.repo, DELIVERY_SUMMARY_ARTIFACT, sources)?.content, content);
    new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => { runs++; return "bad"; }).start(f.task);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
    assert.equal(readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8"), content);
  } finally { f.dispose(); }
});

test("源码读取固定首次版本，不受主 Agent 后续改动影响", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "service.cpp"), "// subsequent loop\n"); f.git("commit", "-qam", "loop");
    const input = { repo: f.repo, base: f.base, head: f.head } as DeliverySummaryInput;
    const tool = deliverySourceTool(input);
    const current = await tool.execute("call", { action: "read", path: "service.cpp" });
    assert.match(current.content[0].text, /first delivery/); assert.doesNotMatch(current.content[0].text, /subsequent/);
    const before = await tool.execute("call", { action: "read", path: "service.cpp", revision: "base" });
    assert.match(before.content[0].text, /initial/);
    const diff = await tool.execute("call", { action: "diff", path: "service.cpp" });
    assert.match(diff.content[0].text, /first delivery/); assert.doesNotMatch(diff.content[0].text, /subsequent/);
    await assert.rejects(tool.execute("call", { action: "read", path: "../secret" }), /非法/);
  } finally { f.dispose(); }
});

test("失败不改变交付状态，不发布半份文档，也不随 loop 重试", async () => {
  const f = fixture();
  try {
    let runs = 0;
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => { runs++; throw new Error("model unavailable"); });
    summaries.start(f.task); await summaries.flush(); summaries.start(f.task); await summaries.flush();
    assert.equal(runs, 1); assert.equal(f.task.summary.status, "verifying");
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).status, "failed");
  } finally { f.dispose(); }
});

test("shutdown 取消独立子会话，不留下后台发布", async () => {
  const f = fixture();
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async (_input, signal) => {
      started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return diagram;
    });
    summaries.start(f.task); await ready; await summaries.shutdown();
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    assert.equal(f.task.summary.status, "verifying");
  } finally { f.dispose(); }
});

test("交付摘要 PlantUML 使用真实渲染器校验", async () => {
  assert.equal(await validateSummaryDiagrams(diagram), undefined);
  assert.match((await validateSummaryDiagrams("no diagram"))!, /缺少/);
  assert.match((await validateSummaryDiagrams("```plantuml\n@startuml\nthis is invalid ???\n@enduml\n```"))!, /语法错误/);
});

for (const failed of [false, true]) {
  test(`小鲁班通知责任人一次，通知失败=${failed} 不影响摘要或任务`, async () => {
    const f = fixture();
    try {
      f.task.summary.luban_account = "owner";
      const calls: any[] = [];
      const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} }, taskLink: "https://cloud.example/work/task-15",
        notifier: { notifyOutcome: async (input: any) => {
          calls.push(input);
          assert.ok(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), "先发布再通知");
          if (failed) throw new Error("notifier unavailable");
          return {} as any;
        } },
      }), async () => diagram);
      summaries.start(f.task); await summaries.flush(); summaries.start(f.task); await summaries.flush();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].account, "owner");
      assert.match(calls[0].summary, /Committer/);
      assert.equal(calls[0].link, "https://cloud.example/work/task-15?deliverySummary=1");
      assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).status, "completed");
      assert.equal(f.task.summary.status, "verifying");
    } finally { f.dispose(); }
  });
}


test("真实 Pi 子会话只读首次 diff/源码，修正图后发布并通知", async () => {
  const f = fixture();
  const model = new ScriptedModelServer([
    { tool: { name: "delivery_source", input: { action: "diff", path: "service.cpp" } } },
    { tool: { name: "delivery_source", input: { action: "read", path: "service.cpp" } } },
    { text: "暂缺图" },
    { text: diagram },
  ], "scripted-v1", { linear: true });
  try {
    await model.start();
    let notified = 0;
    f.task.summary.luban_account = "owner";
    const summaries = new DeliverySummaries<any>(() => ({
      model: { choice: { provider: "maeflow", model: "scripted-v1" }, json: model.modelsJson() as Record<string, unknown> },
      notifier: { notifyOutcome: async () => { notified++; return {} as any; } }, taskLink: "https://cloud.example/work/task-15",
    }), runDeliverySummaryAgent);
    summaries.start(f.task); await summaries.flush();
    const state = JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8"));
    assert.equal(state.status, "completed", state.error);
    assert.equal(notified, 1);
    const events = new EventLog(join(f.repo, "delivery-summary/events.jsonl")).replay();
    const finished = events.filter(e => e.kind === "tool_finished");
    assert.equal(finished.length, 2);
    assert.ok(finished.every(e => !e.payload.is_error), JSON.stringify(finished));
    assert.match(JSON.stringify(finished), /first delivery/);
    const names = (model.requests[0].tools as Array<{ name: string }>).map(tool => tool.name);
    assert.deepEqual(names, ["delivery_source"]);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
  } finally { await model.stop(); f.dispose(); }
});
