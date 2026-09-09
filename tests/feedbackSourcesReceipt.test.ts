/**
 * 三种反馈来源的逐条回执都必须能登记进真内核——不是只有流水线那条。
 *
 * 2026-09-02 修掉 canonical() 把 undefined 键签进摘要的 bug 之后,用户追问
 * "是不是没别的问题了"。空口不算数:工作台批注(Cloud 平台的检视意见)和
 * MR 讨论(检视人意见)各自拼回执的代码路径不同——批注走 annotations.jsonl
 * 的 response,MR 走 review_replies.md——这里让 taskService 真实的
 * recordActiveFeedbackResult 对着真内核各走一遍,登记成功才算数。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { AnnotationStore } from "../src/annotations.ts";
import { KERNEL_UNAVAILABLE, openKernelFeedback } from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import { withLiveReviewReceipts } from "../src/liveReviewReceipts.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "sources", GIT_AUTHOR_EMAIL: "s@example.com",
  GIT_COMMITTER_NAME: "sources", GIT_COMMITTER_EMAIL: "s@example.com",
};

async function until(probe: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const readState = (cwd: string) =>
  JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));

async function watchingService(label: string) {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), `mfc-sources-${label}-`)),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create(`反馈来源回执 ${label}`, { account: "worker" }).id;
  const waiting = service.get(id)?.waiting;
  if (waiting?.step === "cloud_requirement_analysis_confirm") {
    const question = (waiting.question.questions as Array<{ question: string }>)[0].question;
    await service.decide(id, { waiting_id: waiting.waiting_id, state_version: waiting.state_version,
      selected_options: { [question]: "需求已确认，进入需求分析" } });
  }
  await until(() => service.get(id)?.status === "completed", "首轮会话收口");
  const internal = (service as any).tasks.get(id);
  const workspace = internal.summary.workspace as string;
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git("add", "main.ts");
  git("commit", "--quiet", "-m", "baseline");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch", revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: head, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
  }));
  internal.cwd = cwd;
  sealPipelineLifecycle({ cwd, workspace, taskId: id, kernelRoot: KERNEL_ROOT });
  (service as any).options.host = {
    kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true,
  };
  const open = (batchId: string, items: Array<Record<string, unknown>>) => {
    openKernelFeedback({
      host: { kernelRoot: KERNEL_ROOT }, cwd, workspace,
      batch: {
        schema: "mae-flow-feedback-batch/1",
        batch_id: batchId, task_id: id, base_sha: head,
        opened_at: new Date().toISOString(),
        items: items as any,
      },
    });
    (service as any).syncFeedbackStoreFromKernel(internal);
  };
  const stop = async () => {
    await service.cancel(id, "tester").catch(() => undefined);
    await service.shutdown();
    await model.stop();
  };
  return { service, internal, workspace, cwd, open, stop };
}

test("task-4 形态：四条文件回执、三条已发送、一条草稿，运行中登记后可交还真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } = await watchingService("live-workspace");
  try {
    const store = new AnnotationStore(join(workspace, "annotations.jsonl"));
    const items = [1, 2, 3, 4].map((line) => store.add({ author: "reviewer",
      artifact: "main.ts", file: "main.ts", line, anchor: "ready", note: "补充空值处理", kind: "code" }));
    store.markSent(items.slice(0, 3).map((a) => a.id), "review_repair");
    open("fb-live", [{ id: `ws:${items[0].id}`, source: "workspace", source_id: items[0].id,
      source_revision: 0, kind: "code", summary: items[0].note, verification: "author" }]);
    internal.summary.delivery = { loop: { review_source: "workspace", state: "repairing",
      workspace_review_annotation_ids: items.map((a) => a.id) } };
    writeFileSync(join(cwd, "main.ts"), "export const ready = false;\n");
    execFileSync("git", ["add", "main.ts"], { cwd, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "repair"], { cwd, env: GIT_ENV });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    mkdirSync(join(workspace, "reviews"), { recursive: true });
    writeFileSync(join(workspace, "reviews/local-receipts.json"), JSON.stringify({ receipts:
      items.map((a) => ({ annotation_id: a.id, revision: 0, outcome: "fixed",
        summary: "已补充空值处理与对应测试", evidence: ["main.ts:1"] })) }));
    const hooks = withLiveReviewReceipts(undefined, { current: () => true,
      list: () => store.list(), consume: () => (service as any).consumeReviewProcessingReceipts(internal), log() {} });
    await hooks.preTool!({ eventId: 1, taskId: internal.summary.id, sessionId: "main", ts: "",
      kind: "tool_requested", payload: { name: "Bash", input: { command: "current" } } });
    assert.ok(store.list().slice(0, 3).every((a) => a.response?.fixed_sha === head));
    assert.equal(store.list()[3].response, undefined);
    assert.equal((service as any).recordActiveFeedbackResult(internal), undefined);
    const batch = readState(cwd).delivery_loop.batches.find((b: any) => b.batch_id === "fb-live");
    assert.ok(batch.result_digest);
    assert.equal(batch.results[0].status, "fixed");
    assert.ok(store.list().every((a) => a.status !== "verified"));
  } finally { await stop(); }
});

test("工作台批注来源:Agent 逐条回应(不带证据)登记进真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } =
    await watchingService("workspace");
  try {
    const store = new AnnotationStore(join(workspace, "annotations.jsonl"));
    const first = store.add({
      author: "reviewer", artifact: "story.md", file: "story.md", line: 3,
      anchor: "空值分支", note: "空值分支没处理", kind: "doc",
    });
    const second = store.add({
      author: "reviewer", artifact: "main.ts", file: "main.ts", line: 1,
      anchor: "ready", note: "命名不清晰", kind: "code",
    });
    store.markSent([first.id, second.id], "interrupt");
    open("fb-ws", [
      { id: `ws:${first.id}`, source: "workspace", source_id: first.id,
        source_revision: 0, kind: "doc", summary: first.note, verification: "author" },
      { id: `ws:${second.id}`, source: "workspace", source_id: second.id,
        source_revision: 0, kind: "code", summary: second.note, verification: "author" },
    ]);
    // 一条给了证据,一条没给——不给证据是常态,不能因此拒收。
    store.respond(first.id, {
      outcome: "not_fixed", summary: "该路径不可达，已在文档说明", evidence: [],
    });
    store.respond(second.id, {
      outcome: "needs_clarification", summary: "两种命名都合理，需要作者定",
      evidence: ["main.ts:1"],
    });
    const failure = (service as any).recordActiveFeedbackResult(internal);
    assert.equal(failure, "反馈中仍有需要人工判断的条目",
      "needs_clarification 如实上报需要人工,不是登记失败");
    const batch = readState(cwd).delivery_loop.batches.find(
      (item: any) => item.batch_id === "fb-ws");
    assert.ok(batch.result_digest, "内核已登记本批回执");
    assert.deepEqual(batch.results.map((item: any) => item.status).sort(),
      ["explained", "needs_human"]);
  } finally {
    await stop();
  }
});

test("Build-Fix 来源:回执文件不存在=这批还没人处理,恢复时重新派单而不是停摆", async () => {
  // 内网 task-38 实锤:prepush 校验失败登记了 build_fix 批次,12:29 建批、
  // 12:48 部署重启,Agent 一次都没被拉起来处理过。恢复时读不到 result json
  // 就报"Agent 没有留下本批逐条反馈回执"并停摆等人——可 Agent 压根没机会写。
  const { service, internal, open, stop } = await watchingService("buildfix");
  try {
    open("fb-bf", [
      { id: "build_fix:c1:r0", source: "build_fix", source_id: "c1",
        source_revision: 0, kind: "quality_failure",
        summary: "编译未通过：报告中的命令没有在本会话真实成功执行",
        verification: "机器门禁" },
    ]);
    const missing = (service as any).recordActiveFeedbackResult(internal);
    assert.match(missing, /本批逐条反馈回执尚未落盘/);
    assert.match(missing, /尚未被修复会话处理过/);
    assert.doesNotMatch(missing, /Agent 没有留下/,
      "没给过机会就别说人家没留下");

    // 恢复路径:不停摆,重新派给修复会话,清单随使命带上。
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      mr_state: "验证中",
      waiting_on: `${KERNEL_UNAVAILABLE}：登记回执时内核未就绪`,
    };
    (service as any).persist(internal);
    await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    assert.equal(internal.summary.status, "queued",
      "这批还没人处理过,应该重新派单");
    assert.equal(internal.summary.delivery.stalled, undefined,
      "不能停摆等人");
    assert.match(String(internal.mission ?? ""), /还没有被处理过/);
    assert.match(String(internal.mission ?? ""), /build_fix:c1:r0/,
      "使命里要带上本批反馈清单");

    // 文件存在但坏了才是"回执不合格":措辞与出路都不同。
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      mr_state: "验证中",
      waiting_on: `${KERNEL_UNAVAILABLE}：登记回执时内核未就绪`,
    };
    writeFileSync(
      (service as any).feedbackResultPath(internal, "fb-bf"), "{ 不是 JSON");
    const broken = (service as any).recordActiveFeedbackResult(internal);
    assert.match(broken, /无法读取/);
    assert.doesNotMatch(broken, /尚未落盘/);
    await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    assert.equal(internal.summary.status, "verifying",
      "回执确实不合格时照旧停下叫人,不许无限重派");
    assert.ok(internal.summary.delivery.stalled, "不合格要如实停摆");
  } finally {
    await stop();
  }
});

test("MR 检视人意见来源:review_replies.md 逐条回复登记进真内核", async () => {
  const { service, internal, workspace, cwd, open, stop } =
    await watchingService("mr");
  try {
    open("fb-mr", [
      { id: "mr:d-1", source: "mr_discussion", source_id: "d-1", source_revision: 0,
        kind: "code_review", summary: "请补空值分支", verification: "reviewer" },
      { id: "mr:d-2", source: "mr_discussion", source_id: "d-2", source_revision: 0,
        kind: "code_review", summary: "日志级别过高", verification: "reviewer" },
    ]);
    writeFileSync(join(workspace, "review_replies.md"), [
      "[d-1] 已补空值分支，见 main.ts 第 3 行。",
      "[d-2]",
      "已降为 debug 级别。",
      "",
    ].join("\n"));
    const failure = (service as any).recordActiveFeedbackResult(internal);
    assert.equal(failure, undefined, `登记不该失败:${failure}`);
    const batch = readState(cwd).delivery_loop.batches.find(
      (item: any) => item.batch_id === "fb-mr");
    assert.ok(batch.result_digest, "内核已登记本批回执");
    assert.equal(batch.results.length, 2);
    assert.ok(batch.results.every((item: any) => item.status === "explained"));
  } finally {
    await stop();
  }
});

test("流水线摘要误拼进 ID 必须拒收；模板保留原 ID，准确回执才登记", async () => {
  const { service, internal, cwd, open, stop } = await watchingService("pipeline-id");
  try {
    const id = `pipeline:${"94746097".padEnd(40, "a")}:CODECHECK+COMPILE:r0@${"94746097".padEnd(40, "a")}`;
    const summary = "FAILED stage=CodeCCP2.0 job=CodeCCP2.0\n【质量门禁指标】请核对";
    open("fb-pipeline-id", [{ id, source: "pipeline", source_id: "CODECHECK+COMPILE",
      source_revision: 0, kind: "quality_failure", summary, verification: "机器门禁" }]);
    const instructions = (service as any).activeFeedbackReceiptInstructions(internal) as string;
    const start = instructions.indexOf('{\n  "schema"');
    const end = instructions.indexOf("\n只填写每条", start);
    const receipt = JSON.parse(instructions.slice(start, end));
    assert.equal(receipt.batch_id, "fb-pipeline-id");
    assert.equal(receipt.results[0].id, id);
    assert.equal(receipt.results[0].status, "", "平台不得代填处理结论");
    assert.doesNotMatch(instructions, new RegExp("本轮反馈完整 ID："));
    const path = (service as any).feedbackResultPath(internal, "fb-pipeline-id");
    const check = () => {
      writeFileSync(path, JSON.stringify(receipt));
      return (service as any).recordActiveFeedbackResult(internal);
    };
    receipt.results[0] = { id: id + "：" + summary.split("\n")[0], status: "explained",
      summary: "已核对流水线原始报告，需重新执行检查", evidence: "流水线报告" };
    assert.match(check(), /逐条反馈回执含重复、夹带或字段不完整/);
    assert.equal(readState(cwd).delivery_loop.batches[0].result_digest, undefined);
    receipt.results[0].id = id;
    receipt.results.push({ ...receipt.results[0] });
    assert.match(check(), /逐条反馈回执含重复、夹带或字段不完整/);
    receipt.results.pop();
    assert.equal(check(), undefined);
    assert.ok(readState(cwd).delivery_loop.batches[0].result_digest);
  } finally { await stop(); }
});
