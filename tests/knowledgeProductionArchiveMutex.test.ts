// repros/r4 实测：刷新和重试必须共享持有者锁，刷新只合并同步字段，避免旧快照覆盖版本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", issue_description: "订单知识", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  input.save({ id: "orders", title: "orders", target_id: "domain", path: "domains/orders.md", layer: "domain", content: "订单规则 v1", sources: "源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const docs = (job: DomainKnowledgeJob) => job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id }));

test("生产线验收6：刷新持锁时拒绝并发重试，释放后重试保留新推送的版本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r4-race-"));
  let calls = 0, release!: () => void; const gate = new Promise<void>(r => release = r); let gated = false;
  const service = new DomainKnowledgeExtraction(dir, async i => extract(i), {
    publish: async (job, target, previous, _op, save) => {
      calls++;
      if (calls === 1) return { target_id: target.id, state: "opened", branch: "codex/k-1", url: "https://x/mr/1", mr_id: 1, revision: "sha-v1", documents: docs(job) };
      if (calls === 2) { save({ ...previous!, state: "pending", attempted_documents: docs(job) }); throw new Error("Git 网络抖动"); }
      return { ...previous!, state: "opened", revision: "sha-v2", documents: docs(job), attempted_documents: undefined };
    },
    refresh: async (_job, publication) => { if (gated) await gate; return { ...publication, state: "opened" }; },   // 平台如实返回 opened
  });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    const doc = service.get(job.id).documents[0];
    service.edit(job.id, { document: { id: doc.id, title: doc.title, target_id: doc.target_id, path: doc.path, layer: doc.layer, content: "订单规则 v2", sources: doc.sources }, base_revision: doc.revision }, "alice");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[1]?.state === "failed");
    gated = true;
    const refreshing = service.refresh(job.id, "alice");                 // A：刷新 MR 状态（慢）
    assert.throws(() => service.retryArchive(job.id, "bob"), /正在|请等待/, "另一操作不能越过刷新持有的锁");
    assert.equal(calls, 2, "持锁期间没有第二个归档操作");
    release(); await refreshing;
    assert.equal(service.get(job.id).publications[0].revision, "sha-v1");
    service.retryArchive(job.id, "bob");
    await until(() => service.get(job.id).archive_batches?.[1].state === "done");
    const after = service.get(job.id).publications[0];
    assert.equal(after.revision, "sha-v2");
    assert.deepEqual(after.documents.map(d => d.content), ["订单规则 v2"]);
    assert.equal(calls, 3);
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

const componentInput = { research_id: "cr-fixture", title: "组件指南", content: "组件规则 v1", sources: "源码", language: "java",
  target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" }, filename: "orders.md", issue_no: "REQ-1", issue_description: "订单知识" };
type HoldingOperation = "刷新" | "读取远端" | "清理预览" | "后台归档";
type Contender = "发布" | "重试" | "刷新" | "读取远端" | "清理预览" | "准备组件归档";
for (const holdingOperation of ["刷新", "读取远端", "清理预览", "后台归档"] as const) {
  for (const contender of ["发布", "重试", "刷新", "读取远端", "清理预览", "准备组件归档"] as const) {
    test(`生产线验收6：${holdingOperation}持锁时并发${contender}被拒绝且不释放原操作的锁`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "production-archive-matrix-"));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let blocking: HoldingOperation | undefined, entered = false, calls = 0;
      const hold = async (operation: HoldingOperation) => { calls++; if (blocking === operation) { entered = true; await gate; } };
      const service = new DomainKnowledgeExtraction(dir, async () => "unused", {
        publish: async (job, target) => { await hold("后台归档"); return { target_id: target.id, state: "opened", branch: "codex/matrix", url: "https://example.test/mr/matrix", documents: docs(job) }; },
        refresh: async (_job, publication) => { await hold("刷新"); return { ...publication, state: "opened" }; },
        readRemote: async () => { await hold("读取远端"); return { id: "matrix-snapshot", target_content: "远端正文", target_revision: "c".repeat(40), reviewed: false }; },
        previewCleanup: async (_job, target) => { await hold("清理预览"); return { id: "matrix-cleanup", target_id: target.id, directories: [], confirmed: false, target_revision: "c".repeat(40), target_entries: [], document_versions: [] }; },
      });
      let active: Promise<unknown> | undefined;
      try {
        const job = service.prepareComponent(componentInput, "alice");
        await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
        blocking = holdingOperation;
        if (holdingOperation === "后台归档") {
          const document = service.get(job.id).documents[0];
          service.edit(job.id, { document: { ...document, content: "组件规则 v2" }, base_revision: document.revision }, "alice");
          active = service.publish(job.id, "alice");
        } else if (holdingOperation === "刷新") active = service.refresh(job.id, "alice");
        else if (holdingOperation === "读取远端") active = service.readRemote(job.id, "component-guide", "alice");
        else active = service.previewCleanup(job.id, "domain", {}, "alice");
        await until(() => entered);
        const before = calls;
        const invoke = (operation: Contender) => {
          if (operation === "发布") return service.publish(job.id, "bob");
          if (operation === "重试") return service.retryArchive(job.id, "bob");
          if (operation === "刷新") return service.refresh(job.id, "bob");
          if (operation === "读取远端") return service.readRemote(job.id, "component-guide", "bob");
          if (operation === "清理预览") return service.previewCleanup(job.id, "domain", {}, "bob");
          return service.prepareComponent({ ...componentInput, base_revision: service.get(job.id).documents[0].revision,
            knowledge_revision: service.get(job.id).documents[0].published_revision }, "bob");
        };
        await assert.rejects(async () => invoke(contender), /正在|请等待/);
        await assert.rejects(async () => service.refresh(job.id, "charlie"), /正在|请等待/, "被拒绝操作的 finally 不能释放原持有者的锁");
        assert.equal(calls, before, "持锁期间不启动第二次远端或归档调用");
        release(); await active;
        if (holdingOperation === "后台归档") await until(() => service.get(job.id).archive_batches?.at(-1)?.state === "done");
      } finally { release(); await active?.catch(() => undefined); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test("生产线验收6：锁只允许持有者释放，旧持有者不能释放新操作的锁", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-archive-owner-"));
  const service = new DomainKnowledgeExtraction(dir, async () => "unused");
  const locks = service as unknown as { acquirePublication(id: string): symbol; releasePublication(id: string, owner: symbol): boolean };
  try {
    const job = service.prepareComponent(componentInput, "alice");
    const first = locks.acquirePublication(job.id);
    assert.equal(locks.releasePublication(job.id, Symbol("foreign")), false);
    assert.throws(() => locks.acquirePublication(job.id), /正在|请等待/);
    assert.equal(locks.releasePublication(job.id, first), true);
    const second = locks.acquirePublication(job.id);
    assert.equal(locks.releasePublication(job.id, first), false);
    assert.throws(() => service.retryArchive(job.id, "bob"), /正在|请等待/);
    assert.equal(locks.releasePublication(job.id, second), true);
    assert.doesNotThrow(() => service.retryArchive(job.id, "bob"));
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收6：刷新只合并同步字段，仅同步相同目标与分支的批次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-refresh-fields-"));
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    publish: async (job, target) => ({ target_id: target.id, state: "opened", branch: "codex/current", url: "https://example.test/mr/1", mr_id: 1,
      revision: "current-sha", documents: docs(job), attempted_documents: docs(job) }),
    refresh: async (_job, publication) => ({ ...publication, state: "merged", sync_state: "done", error: undefined,
      branch: "codex/stale", revision: "stale-sha", documents: [], attempted_documents: [], url: "https://example.test/stale", mr_id: "stale", cleanup_id: "stale", removed_paths: ["stale.md"],
      target_revision: "c".repeat(40), updated_at: "2026-10-02T00:00:00Z" }),
  });
  try {
    const created = service.create(config, "alice"); await until(() => service.get(created.id).status === "done");
    await service.publish(created.id, "alice"); await until(() => service.get(created.id).archive_batches?.[0].state === "done");
    const internals = service as unknown as { jobs: Map<string, DomainKnowledgeJob> };
    const job = internals.jobs.get(created.id)!;
    const original = structuredClone(job.publications[0]), batch = job.archive_batches![0];
    job.archive_batches!.push({ ...structuredClone(batch), id: "foreign-target", publications: [{ ...structuredClone(original), target_id: "repo-1", state: "closed" }] },
      { ...structuredClone(batch), id: "foreign-branch", publications: [{ ...structuredClone(original), branch: "codex/other", state: "closed" }] });
    await service.refresh(created.id, "alice");
    const current = service.get(created.id), publication = current.publications[0];
    assert.equal(publication.state, "merged"); assert.equal(publication.sync_state, "done"); assert.equal(publication.target_revision, "c".repeat(40));
    for (const key of ["branch", "revision", "documents", "attempted_documents", "url", "mr_id", "cleanup_id", "removed_paths"] as const) assert.deepEqual(publication[key], original[key], `刷新不覆盖 ${key}`);
    assert.equal(current.archive_batches![0].publications[0].state, "merged");
    assert.equal(current.archive_batches![1].publications[0].state, "closed"); assert.equal(current.archive_batches![2].publications[0].state, "closed");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5：旧失败批次的正式版本被替换后标记 superseded，不挡住新的待归档批次", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-superseded-failure-"));
  let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    publish: async (job, target) => {
      if (++calls === 1) throw new Error("旧版本归档网络失败");
      return { target_id: target.id, state: "opened", branch: "codex/current", url: "https://example.test/mr/new", documents: docs(job) };
    },
  });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "failed");
    const document = service.get(job.id).documents[0];
    service.edit(job.id, { document: { ...document, content: "正式规则 v2" }, base_revision: document.revision }, "alice");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[1]?.state === "done");
    const current = service.get(job.id);
    assert.equal(current.archive_batches![0].state, "superseded"); assert.equal(current.archive_batches![0].superseded_documents![0].reason, "newer_version");
    assert.deepEqual(current.publications[0].documents.map(document => document.content), ["正式规则 v2"]);
    service.retryArchive(job.id, "bob"); assert.equal(calls, 2, "重试不能重新推送已经失效的历史版本");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收6：归档同步落失败终态时立即释放持有者锁，补齐单号后可重试且不遗留占用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-archive-terminal-lock-"));
  let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    publish: async (job, target) => { calls++; return { target_id: target.id, state: "opened", branch: "codex/continued", url: "https://example.test/mr/continued", documents: docs(job) }; },
  });
  const internals = service as unknown as { jobs: Map<string, DomainKnowledgeJob>; archiving: Map<string, Promise<void>> };
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    delete internals.jobs.get(job.id)!.issue_no;
    await service.publish(job.id, "alice");
    await until(() => service.get(job.id).archive_batches?.[0].state === "failed");
    assert.equal(calls, 0, "缺少单号在调用发布器前同步失败");
    assert.doesNotThrow(() => service.setIssueNumber(job.id, "REQ-fixed"), "终态可见时锁已释放，不依赖下一次 Promise finally");
    service.retryArchive(job.id, "alice");
    await until(() => service.get(job.id).archive_batches?.[0].state === "done" && !internals.archiving.has(job.id));
    assert.equal(calls, 1);
    assert.doesNotThrow(() => service.setIssueNumber(job.id, "REQ-fixed"));
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

async function flush() { for (let n = 0; n < 4; n++) await setImmediate(); }
for (const operation of ["后台归档", "刷新", "读取远端", "清理预览"] as const) {
  for (const outcome of ["返回", "抛错"] as const) test(`生产线验收6：${operation}忽略停止预算后迟到${outcome}及保存回调不能覆写磁盘`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dir = mkdtempSync(join(tmpdir(), "production-archive-late-"));
    let releaseShutdown!: () => void, resolveReply!: (value: any) => void, rejectReply!: (error: Error) => void;
    const teardown = new Promise<void>(resolve => { releaseShutdown = resolve; });
    const reply = new Promise<any>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    let blocking = false, entered = false, lateSave: ((publication: DomainPublication) => void) | undefined;
    const notifications: string[] = [];
    const publication = (job: DomainKnowledgeJob, targetId: string): DomainPublication => ({ target_id: targetId, state: "opened", branch: "codex/late", url: "https://example.test/mr/late", documents: docs(job) });
    const service = new DomainKnowledgeExtraction(dir, async () => "unused", {
      publish: async (job, target, _previous, _operator, save) => {
        if (blocking && operation === "后台归档") { entered = true; lateSave = save; return reply; }
        return publication(job, target.id);
      },
      refresh: async (_job, current) => { if (blocking && operation === "刷新") { entered = true; return reply; } return current; },
      readRemote: async () => { entered = true; return reply; },
      previewCleanup: async () => { entered = true; return reply; },
      shutdown: () => teardown,
      onStopTimeout: job => { notifications.push(job.id); },
    });
    const internals = service as unknown as { archiving: Map<string, Promise<void>> };
    let active: Promise<unknown> | undefined, closed = false;
    try {
      const job = service.prepareComponent(componentInput, "alice");
      await service.publish(job.id, "alice"); await flush();
      assert.equal(service.get(job.id).archive_batches![0].state, "done");
      blocking = true;
      if (operation === "后台归档") {
        const document = service.get(job.id).documents[0];
        service.edit(job.id, { document: { ...document, content: "组件规则 v2" }, base_revision: document.revision }, "alice");
        await service.publish(job.id, "alice");
        active = internals.archiving.get(job.id)!.catch(error => error);
      } else if (operation === "刷新") active = service.refresh(job.id, "alice").catch(error => error);
      else if (operation === "读取远端") active = service.readRemote(job.id, "component-guide", "alice").catch(error => error);
      else active = service.previewCleanup(job.id, "domain", {}, "alice").catch(error => error);
      await flush(); assert.equal(entered, true);
      const closing = service.shutdown().then(() => { closed = true; });
      t.mock.timers.tick(59_999); await flush(); assert.equal(closed, false);
      t.mock.timers.tick(1); await flush(); await closing; assert.equal(closed, true);
      assert.equal(internals.archiving.size, 0, "停止预算结束释放归档工作引用");
      if (operation === "后台归档") {
        const batch = service.get(job.id).archive_batches!.at(-1)!;
        assert.equal(batch.state, "failed"); assert.match(batch.error ?? "", /停止超时/); assert.deepEqual(notifications, [job.id]);
      }
      const path = join(dir, "domain-extraction", job.id, "job.json"), before = readFileSync(path, "utf8");
      if (lateSave) assert.throws(() => lateSave!({ ...publication(service.get(job.id), "domain"), revision: "late-write" }), /服务已停止，迟到结果未保存/);
      if (outcome === "抛错") rejectReply(new Error("迟到网络错误"));
      else if (operation === "后台归档") resolveReply({ ...publication(service.get(job.id), "domain"), revision: "late-result" });
      else if (operation === "刷新") resolveReply({ ...service.get(job.id).publications[0], state: "closed", sync_state: "failed", error: "迟到结果" });
      else if (operation === "读取远端") resolveReply({ id: "late-review", target_revision: "c".repeat(40), target_content: "迟到正文", reviewed: false });
      else resolveReply({ id: "late-cleanup", target_id: "domain", directories: [], confirmed: false, target_revision: "c".repeat(40), target_entries: [], document_versions: [] });
      const error = await active; await flush();
      assert.ok(error instanceof Error); assert.match(error.message, /服务已停止，迟到结果未保存/);
      assert.equal(readFileSync(path, "utf8"), before, "迟到保存、成功结果及异常处理均不落盘");
      assert.equal(service.get(job.id).documents[0].remote_review?.id, undefined);
      assert.equal(service.get(job.id).cleanup_plans?.length ?? 0, 0);
      assert.throws(() => service.retryArchive(job.id, "bob"), /服务正在停止/);
    } finally {
      releaseShutdown(); resolveReply({}); await flush();
      if (!closed) { const closing = service.shutdown(); t.mock.timers.tick(60_000); await flush(); await closing; }
      rmSync(dir, { recursive: true, force: true }); t.mock.timers.reset();
    }
  });
}
