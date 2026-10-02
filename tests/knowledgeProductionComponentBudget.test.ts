import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentResearch, type ResearchExecution, type ResearchRecord } from "../src/componentResearch.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { saveKnowledgeReviewNote, type KnowledgeReviewSources } from "../src/knowledgeReviewNotes.ts";

const timeoutReason = "停止超时：执行体 60 秒内未退出，已强制释放";
const config = { name: "文件组件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["cpp"] };
const section = (ids: string[]) => ({ id: "files", title: "文件处理", repository_ids: ids, content: "文件处理约束。", interfaces: "Close(handle)",
  integration: "链接 files 库。", example: "```cpp\nClose(handle);\n```", sources: "src/file.cpp:1", related_ids: [] });
function writeDocument(input: ResearchExecution) {
  const ids = input.record.components!.map(component => component.id);
  input.editDocument!({ action: "overview", overview: "文件处理组件的依赖关系。" });
  input.editDocument!({ action: "outline", entries: [{ id: "files", title: "文件处理", repository_ids: ids }] });
  input.editDocument!({ action: "section", section: section(ids) });
}
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

test("生产线验收2（F3）：组件执行体忽略 abort，60 秒释放槽位、记失败并通知，原任务可继续且迟到结果不影响新一轮", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-stop-budget-"));
  saveComponentRepository(dataDir, config, "alice");
  const started: ResearchExecution[] = [], finish: Array<() => void> = [], notices: ResearchRecord[] = [];
  const research = new ComponentResearch(dataDir, async input => {
    started.push(input);
    writeDocument(input);
    await new Promise<void>(resolve => finish.push(resolve));
    input.update({ stage: "迟到执行体试图覆盖状态" });
    input.evidence({ tool: "late-result" });
    return "迟到的草稿";
  }, () => {}, record => notices.push(record));
  try {
    const first = research.start({ mode: "all", language: "cpp" }, "alice");
    const second = research.start({ mode: "all", language: "cpp" }, "bob");
    await settle();
    const third = research.start({ mode: "all", language: "cpp" }, "carol");
    assert.equal(started.length, 2);
    assert.equal(research.get(third.id).status, "queued");
    research.stop(first.id); research.stop(second.id);
    assert.ok(started.every(input => input.signal.aborted));
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(started.length, 2, "预算到期前仍等原执行体退出");
    t.mock.timers.tick(1);
    await settle();
    for (const id of [first.id, second.id]) {
      const failed = research.get(id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, timeoutReason);
    }
    assert.deepEqual(notices.map(record => [record.id, record.operator, record.status, record.error]).sort(),
      [[first.id, "alice", "failed", timeoutReason], [second.id, "bob", "failed", timeoutReason]].sort());
    assert.ok(started.some(input => input.record.id === third.id), "别人的排队研究获得释放的槽位");
    assert.equal(research.retry(first.id, "alice").id, first.id, "原研究可在保留已有草稿的基础上继续");
    await settle();
    assert.equal(started.filter(input => input.record.id === first.id).length, 2);
    const resumed = research.get(first.id);
    finish[0](); finish[1]();
    await settle();
    assert.deepEqual(research.get(first.id), resumed, "旧执行体迟到返回不能改状态、草稿或证据");
    assert.throws(() => research.review(first.id, { section_id: "files", mode: "discuss", message: "不要并发新一轮" }, "alice"), /本轮完成|停止后/,
      "旧执行体 finally 不能释放新执行体的槽位");
    const fourth = research.start({ mode: "all", language: "cpp" }, "dave");
    await settle();
    assert.equal(research.get(fourth.id).status, "queued", "第三个研究和接续中的研究仍占两个有效槽位");
    assert.equal(started.length, 4);
    assert.equal(notices.length, 2, "每个超时执行体只通知一次");
  } finally {
    const stopping = research.shutdown();
    t.mock.timers.tick(60_000);
    for (const release of finish) release();
    await settle();
    await stopping;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("生产线验收2（F3）：组件服务关停同样只等待 60 秒，不响应 abort 的任务如实失败", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-shutdown-budget-"));
  saveComponentRepository(dataDir, config, "alice");
  let release = () => {}, returned = false;
  const notices: ResearchRecord[] = [];
  const research = new ComponentResearch(dataDir, async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return "关停后的迟到草稿";
  }, () => {}, record => notices.push(record));
  const job = research.start({ language: "cpp", topic: "关停预算" }, "alice");
  await settle();
  const stopping = research.shutdown().then(() => { returned = true; });
  try {
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(returned, false);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(returned, true, "关停不能无限等待执行体");
    assert.equal(research.get(job.id).status, "failed");
    assert.equal(research.get(job.id).error, timeoutReason);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].operator, "alice");
    const failed = research.get(job.id);
    release(); await settle();
    assert.deepEqual(research.get(job.id), failed, "关停预算后的结果丢弃");
  } finally {
    release(); await stopping;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("生产线验收2（F3）：组件执行体响应 abort 时保持已停止，预算后不误记失败或通知", { timeout: 3_000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-stop-responsive-"));
  saveComponentRepository(dataDir, config, "alice");
  const notices: ResearchRecord[] = [];
  const research = new ComponentResearch(dataDir, async input => {
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return "已响应停止";
  }, () => {}, record => notices.push(record));
  try {
    const job = research.start({ language: "cpp", topic: "响应停止" }, "alice");
    await settle(); research.stop(job.id); await settle();
    t.mock.timers.tick(60_000); await settle();
    assert.equal(research.get(job.id).status, "cancelled");
    assert.equal(research.get(job.id).stage, "已停止");
    assert.equal(research.get(job.id).error, undefined);
    assert.deepEqual(notices, []);
  } finally {
    await research.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const action of ["edit", "restore"] as const) {
  test(`生产线验收14（F23）：组件研究进行中拒绝${action === "edit" ? "人工编辑" : "恢复历史版本"}，意见仍能保存且不改草稿`, { timeout: 3_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-running-edit-"));
    saveComponentRepository(dataDir, config, "alice");
    let release = () => {};
    const research = new ComponentResearch(dataDir, async input => {
      if (!input.review) { writeDocument(input); return "初稿已保存"; }
      await new Promise<void>(resolve => { release = resolve; });
      return "讨论结束";
    });
    try {
      const job = research.start({ mode: "all", language: "cpp" }, "alice");
      await settle();
      const original = research.get(job.id).document!.sections[0];
      research.editSection(job.id, { section: { ...original, content: "人工保存的第二版" }, base_revision: original.revision }, "alice");
      research.review(job.id, { section_id: "files", mode: "discuss", message: "讨论当前版本" }, "alice");
      await settle();
      const before = research.get(job.id);
      const sources: KnowledgeReviewSources = { dataDir, component: research, domain: {
        get: () => { throw new Error("本例不能访问领域研究"); }, run: () => { throw new Error("本例不能启动领域研究"); },
      } };
      const notes = saveKnowledgeReviewNote(sources, "component", job.id, {
        document_id: "files", scope: "document", note: "研究结束后补充错误处理说明。",
      }, "bob");
      assert.equal(notes.notes[0].status, "open", "研究中仍能提意见");
      assert.throws(() => action === "edit"
        ? research.editSection(job.id, { section: { ...before.document!.sections[0], content: "研究中人工改写" }, base_revision: before.document!.sections[0].revision }, "bob")
        : research.restoreSection(job.id, "files", original.revision, before.document!.sections[0].revision, "bob"),
      /研究进行中：请先停止，或等本轮结束后再改/);
      assert.deepEqual(research.get(job.id), before, "被拒绝的操作不改正文、版本或研究状态");
    } finally {
      release(); await research.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

for (const action of ["stop", "shutdown"] as const) {
  test(`生产线验收2（F3）：组件${action === "stop" ? "停止" : "关停"}超时记录一次落盘 EIO，仍在60秒释放槽位并通知失败原因`, { timeout: 3_000 }, async t => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-component-timeout-eio-"));
    saveComponentRepository(dataDir, config, "alice");
    const started: string[] = [], releases: Array<() => void> = [], notices: ResearchRecord[] = [];
    const research = new ComponentResearch(dataDir, async input => {
      started.push(input.record.id);
      await new Promise<void>(resolve => releases.push(resolve));
      return "迟到结果";
    }, () => {}, record => { notices.push(record); throw new Error("测试通知同步失败"); });
    const first = research.start({ language: "cpp", topic: "第一个研究" }, "alice");
    research.start({ language: "cpp", topic: "第二个研究" }, "bob");
    await settle();
    const queued = research.start({ language: "cpp", topic: "别人的排队研究" }, "carol");
    let returned = false;
    let closing: Promise<void> | undefined;
    if (action === "stop") research.stop(first.id);
    else closing = research.shutdown().then(() => { returned = true; });
    const path = join(dataDir, "component-research", first.id, "record.json");
    const before = fs.readFileSync(path, "utf8"), rename = fs.renameSync;
    let failures = 0;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === path && failures++ === 0) throw Object.assign(new Error("测试磁盘 EIO：超时状态未写成"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      t.mock.timers.tick(59_999); await settle();
      assert.equal(research.get(first.id).status, action === "stop" ? "cancelled" : "queued");
      assert.equal(returned, false);
      assert.doesNotThrow(() => t.mock.timers.tick(1), "写盘故障不能从预算回调冒泡并阻断释放");
      await settle();
      assert.equal(failures, 1);
      assert.equal(research.get(first.id).status, "failed");
      assert.match(research.get(first.id).error ?? "", /停止超时.*EIO/);
      const notice = notices.find(record => record.id === first.id);
      assert.equal(notice?.operator, "alice");
      assert.equal(notice?.status, "failed");
      assert.match(notice?.error ?? "", /停止超时.*EIO/);
      assert.ok(research.warnings().some(warning => warning.includes(`component-research/${first.id}/record.json`) && warning.includes("EIO")));
      assert.ok(research.warnings().some(warning => warning.includes(first.id) && warning.includes("测试通知同步失败")));
      assert.equal(fs.readFileSync(path, "utf8"), before, "失败的原子提交没有损坏上一份权威记录");
      if (action === "stop") assert.ok(started.includes(queued.id), "写盘失败也释放槽位给其他人");
      else {
        assert.equal(returned, true, "关停在60秒返回");
        assert.ok(!started.includes(queued.id), "关停不启动排队工作");
      }
    } finally {
      interception.mock.restore(); syncBuiltinESMExports();
      closing ??= research.shutdown();
      for (const release of releases) release();
      await settle(); await closing;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
