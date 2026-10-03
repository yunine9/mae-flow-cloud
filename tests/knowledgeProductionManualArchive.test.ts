import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";
import type { TaskService } from "../src/taskService.ts";
import { listKnowledgeDocuments, readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { domainKnowledgeTask } from "../src/knowledgeTaskCenter.ts";

// Public contract is named locally for the initial RED run; production will
// expose this same readonly HTTP shape from knowledgeProductionTypes.ts.
interface Preview {
  job_id: string; title: string; status_label: string; message: string; issue_no?: string;
  expected_revisions: Record<string, string>;
  actions: Array<{ id: string; label: string; href?: string; target_id?: string; batch_id?: string }>;
  targets: Array<{ id: string; repository: string; branch: string; configured: boolean; status_label: string; url?: string;
    actions: Preview["actions"]; files: Array<{ path: string; content: string; knowledge_document_id: string; knowledge_revision: string }> }>;
}
interface ManualManager {
  previewArchive(id: string): Preview;
  previewComponentArchive(input: { research_id: string; knowledge_document_id: string; knowledge_revision?: string }, operator: string): Preview;
  createArchive(id: string, input: { issue_no: string; issue_description?: string; expected_revisions: Record<string, string>; target_ids?: string[] }, operator: string): Promise<Preview>;
  retryArchive(id: string, operator: string, input: { batch_id: string; target_id?: string }): Promise<Preview>;
}
const manual = (manager: DomainKnowledgeExtraction) => manager as unknown as ManualManager;
async function within<T>(work: Promise<T>, message: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const config = { title: "订单领域", scope: "核对领域规则", issue_no: "REQ-PREFILL", issue_description: "研究发起时的单号描述", repositories: [],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
function harness(dir: string, options: { noGit?: boolean; multiple?: boolean; failTarget?: string } = {}) {
  const calls: Array<{ target: string; previous?: DomainPublication; job: DomainKnowledgeJob; operator: string }> = [];
  let failed = false;
  const manager = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of [input.job.knowledge_target, ...(options.multiple ? input.job.repositories : [])]) {
      input.save({ id: target.id === "domain" ? "rules" : "source-rules", target_id: target.id, title: `${target.id} 规则`,
        layer: target.id === "domain" ? "domain" : "repository", path: `${target.docs_path}/rules.md`,
        content: `# ${target.id}\n\n只归档已发布的正式规则。`, sources: "固定源码和业务资料" }, { content: null, revision: "a".repeat(40) });
    }
    return "草稿完成";
  }, { publish: async (job, target, previous, operator, save) => {
    calls.push({ target: target.id, previous: previous && structuredClone(previous), job: structuredClone(job), operator });
    const documents = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
      knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision }));
    const branch = previous?.branch ?? `codex/manual-${target.id}-${documents[0].knowledge_revision!.slice(0, 12)}`;
    save({ target_id: target.id, branch, state: "pending", documents: [], attempted_documents: documents, mr_attempted: true });
    if (!failed && target.id === options.failTarget) { failed = true; throw new Error("HTTP 503：测试平台暂时不可用"); }
    return { target_id: target.id, branch, state: "opened", url: `https://example.test/mr/${calls.length}`, mr_id: calls.length, documents };
  } });
  const input = options.noGit ? { ...config, knowledge_target: undefined } : options.multiple ? { ...config,
    repositories: [{ repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/source" }] } : config;
  return { manager, calls, async seed() { const job = manager.create(input, "author"); await until(() => manager.get(job.id).status === "done", "研究未在5秒预算内完成"); return job.id; } };
}
async function close(manager: DomainKnowledgeExtraction) { await within(manager.shutdown(), "管理器关停超过5秒预算"); }
const batchPath = (dir: string, id: string) => join(dir, "domain-extraction", id, "job.json");

test("生产线验收4/10/14：领域发布只写平台，无Git配置也可发布且不自动推送或创建MR", { timeout: 15_000 }, async () => {
  for (const noGit of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-platform-")), state = harness(dir, { noGit });
    try {
      const id = await state.seed(); await state.manager.publish(id, "reviewer"); await settle();
      assert.equal(listKnowledgeDocuments(dir).length, 1, "发布应立即写入正式库");
      assert.equal(state.calls.length, 0, "平台发布不能自动调用Git/MR发布器");
      const stored = JSON.parse(readFileSync(batchPath(dir, id), "utf8")) as DomainKnowledgeJob;
      assert.ok((stored.archive_batches ?? []).every(batch => batch.state === "pending" && !batch.publications.length && !batch.issue_no), "F6恢复快照不能冒充人工归档或保存未填写的归档单号");
      assert.equal(state.manager.get(id).production?.archive.status_label, "已发布（未归档）");
    } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("生产线验收5/8/14：归档预览读取当前正式版本、预填任务单号且不修改正文或自动创建MR", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-preview-")), state = harness(dir);
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer");
    const formal = listKnowledgeDocuments(dir)[0], next = saveKnowledgeDocument(dir, { ...formal, content: "# 人工正式新版\n\n平台阅读页已经发布的规则。" }, "editor", formal.id, { expectedRevision: formal.revision });
    const snapshot = JSON.stringify(listKnowledgeDocuments(dir)), beforeCalls = state.calls.length;
    assert.equal(typeof manual(state.manager).previewArchive, "function", "必须有公开只读归档预览接口");
    const preview = manual(state.manager).previewArchive(id);
    assert.equal(preview.issue_no, "REQ-PREFILL"); assert.equal(preview.status_label, "已发布（未归档）");
    assert.equal(preview.targets[0].files[0].content, next.content, "不能导出旧pending草稿或研究基线");
    assert.equal(preview.targets[0].files[0].knowledge_revision, next.revision);
    assert.equal(preview.expected_revisions[next.id], next.revision);
    assert.equal(JSON.stringify(listKnowledgeDocuments(dir)), snapshot); assert.equal(state.calls.length, beforeCalls);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/6/14：手动创建归档要求用户单号及预览版本，拒绝缺单号和过期预览且不启动外部操作", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-guard-")), state = harness(dir);
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer");
    assert.equal(typeof manual(state.manager).createArchive, "function", "必须有人工归档创建接口");
    const preview = manual(state.manager).previewArchive(id), before = state.calls.length;
    await assert.rejects(manual(state.manager).createArchive(id, { issue_no: "", expected_revisions: preview.expected_revisions }, "exporter"), /关联单号/);
    const formal = listKnowledgeDocuments(dir)[0]; saveKnowledgeDocument(dir, { ...formal, content: formal.content + "\n正式新版本" }, "editor", formal.id, { expectedRevision: formal.revision });
    await assert.rejects(manual(state.manager).createArchive(id, { issue_no: "REQ-MANUAL", expected_revisions: preview.expected_revisions }, "exporter"), /正式知识.*(?:版本|变化)|预览.*(?:版本|变化)/);
    assert.equal(state.calls.length, before, "预检失败不得产生Git/MR事实");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/6/8/14：多目标手动归档保存部分成功，失败target仅人工同分支重试且已成功MR不重复创建", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-target-")), state = harness(dir, { multiple: true, failTarget: "repo-1" });
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer");
    const api = manual(state.manager); assert.equal(typeof api.createArchive, "function");
    const preview = api.previewArchive(id);
    const created = await api.createArchive(id, { issue_no: "REQ-EXPORT", expected_revisions: preview.expected_revisions }, "exporter");
    assert.equal(created.status_label, "归档失败"); assert.equal(created.targets.find(target => target.id === "domain")?.status_label, "已归档");
    const stored = JSON.parse(readFileSync(batchPath(dir, id), "utf8")) as DomainKnowledgeJob;
    const failed = stored.archive_batches!.find(batch => batch.state === "failed")!;
    assert.equal(failed.issue_no, "REQ-EXPORT"); assert.equal(failed.operator, "exporter");
    const failedBranch = failed.publications.find(publication => publication.target_id === "repo-1")!.branch;
    assert.ok(failedBranch); const before = state.calls.length; await settle(); assert.equal(state.calls.length, before, "失败不得后台重试");
    const retried = await api.retryArchive(id, "retryer", { batch_id: failed.id, target_id: "repo-1" });
    assert.equal(retried.status_label, "已归档"); assert.ok(retried.targets.every(target => target.url));
    assert.equal(state.calls.filter(call => call.target === "domain").length, 1); assert.equal(state.calls.filter(call => call.target === "repo-1").length, 2);
    assert.equal(state.calls.at(-1)!.previous?.branch, failedBranch); assert.equal(state.calls.at(-1)!.job.issue_no, "REQ-EXPORT");
    await api.retryArchive(id, "retryer", { batch_id: failed.id, target_id: "repo-1" });
    assert.equal(state.calls.length, before + 1, "重复重试成功target应复用已保存MR事实");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收1/5/14：宕机中的人工归档重启记失败，保留已发生分支和正式版本且不自动接续外部操作", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-restart-")), state = harness(dir);
  let restarted: DomainKnowledgeExtraction | undefined;
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer"); const api = manual(state.manager);
    assert.equal(typeof api.createArchive, "function"); const preview = api.previewArchive(id);
    await api.createArchive(id, { issue_no: "REQ-RESTART", expected_revisions: preview.expected_revisions }, "exporter"); await close(state.manager);
    const stored = JSON.parse(readFileSync(batchPath(dir, id), "utf8")) as DomainKnowledgeJob, batch = stored.archive_batches!.find(batch => batch.state === "done")!;
    batch.state = "running"; batch.publications[0].state = "pending"; delete batch.publications[0].url; delete batch.publications[0].mr_id;
    stored.publications = structuredClone(batch.publications); writeFileSync(batchPath(dir, id), JSON.stringify(stored));
    let external = 0; restarted = new DomainKnowledgeExtraction(dir, async () => { throw new Error("不应重复研究"); }, { publish: async () => { external++; throw new Error("不应自动归档"); } });
    await settle(); await settle();
    assert.equal(external, 0); const recovered = restarted.get(id).archive_batches!.find(row => row.id === batch.id)!;
    assert.equal(recovered.state, "failed"); assert.match(recovered.error ?? "", /重启|中断|手动重试/);
    assert.equal(recovered.publications[0].branch, batch.publications[0].branch);
    assert.deepEqual(manual(restarted).previewArchive(id).expected_revisions, preview.expected_revisions);
  } finally { if (restarted) await close(restarted); await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/8/14：归档新版正式知识创建新MR并保留旧链接，不读取旧MR状态或复用旧版本receipt", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-new-version-")), state = harness(dir);
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer"); const api = manual(state.manager);
    assert.equal(typeof api.createArchive, "function"); const initial = api.previewArchive(id);
    const first = await api.createArchive(id, { issue_no: "REQ-FIRST", expected_revisions: initial.expected_revisions }, "exporter");
    const oldUrl = first.targets[0].url, formal = readKnowledgeDocument(dir, Object.keys(initial.expected_revisions)[0]);
    const current = saveKnowledgeDocument(dir, { ...formal, content: formal.content + "\n新的正式规则。" }, "editor", formal.id, { expectedRevision: formal.revision });
    const next = api.previewArchive(id); assert.equal(next.status_label, "已发布（未归档）"); assert.equal(next.expected_revisions[current.id], current.revision);
    assert.equal(state.manager.get(id).production?.archive.status_label, next.status_label);
    assert.equal(domainKnowledgeTask(state.manager.get(id)).production?.archive.status_label, next.status_label);
    const second = await api.createArchive(id, { issue_no: "REQ-SECOND", expected_revisions: next.expected_revisions }, "exporter");
    assert.equal(second.status_label, "已归档"); assert.notEqual(second.targets[0].url, oldUrl);
    assert.notEqual(state.calls[0].job.documents[0].published_revision, state.calls[1].job.documents[0].published_revision);
    assert.equal(state.calls[1].previous, undefined, "新精确版本不得把旧MR作为待续推对象");
    const stored = JSON.parse(readFileSync(batchPath(dir, id), "utf8")) as DomainKnowledgeJob;
    assert.ok(stored.archive_batches!.some(batch => batch.publications.some(publication => publication.url === oldUrl)), "旧人工归档链接必须保留");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4/5/14：人工批次首次耐久写EIO不调用MR、不污染读取记录，解除故障后可再次创建", { timeout: 10_000 }, async t => {
  const fs = (await import("node:fs")).default, { syncBuiltinESMExports } = await import("node:module");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-batch-eio-")), state = harness(dir);
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer"); const before = state.manager.get(id), raw = readFileSync(batchPath(dir, id), "utf8");
    const preview = state.manager.previewArchive(id), rename = fs.renameSync;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === batchPath(dir, id)) throw Object.assign(new Error("测试批次耐久写 EIO"), { code: "EIO" });
      return rename(...args);
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(state.manager.createArchive(id, { issue_no: "REQ-EIO", expected_revisions: preview.expected_revisions }, "exporter"), /EIO/);
      assert.equal(state.calls.length, 0); assert.deepEqual(state.manager.get(id), before); assert.equal(readFileSync(batchPath(dir, id), "utf8"), raw);
    } finally { interception.mock.restore(); syncBuiltinESMExports(); }
    assert.equal((await state.manager.createArchive(id, { issue_no: "REQ-EIO", expected_revisions: preview.expected_revisions }, "exporter")).status_label, "已归档");
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4/5/14：MR成功回执耐久写EIO保留已保存分支，手动重试复用同版同分支而不重写正式库", { timeout: 10_000 }, async t => {
  const fs = (await import("node:fs")).default, { syncBuiltinESMExports } = await import("node:module");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-receipt-eio-")), state = harness(dir);
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer"); const preview = state.manager.previewArchive(id), formal = JSON.stringify(listKnowledgeDocuments(dir)), rename = fs.renameSync;
    let failed = false;
    const interception = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (!failed && String(args[1]) === batchPath(dir, id)) {
        const candidate = JSON.parse(readFileSync(String(args[0]), "utf8")) as DomainKnowledgeJob;
        if (candidate.archive_batches?.some(batch => batch.publications.some(publication => publication.state === "opened"))) {
          failed = true; throw Object.assign(new Error("测试MR回执耐久写 EIO"), { code: "EIO" });
        }
      }
      return rename(...args);
    }); syncBuiltinESMExports();
    try {
      const result = await state.manager.createArchive(id, { issue_no: "REQ-RECEIPT", expected_revisions: preview.expected_revisions }, "exporter");
      assert.equal(failed, true); assert.equal(result.status_label, "归档失败"); assert.match(result.targets[0].error ?? "", /EIO/);
    } finally { interception.mock.restore(); syncBuiltinESMExports(); }
    const batch = state.manager.get(id).archive_batches!.find(batch => batch.state === "failed")!, branch = batch.publications[0].branch;
    assert.ok(branch); assert.equal((await state.manager.retryArchive(id, "exporter", { batch_id: batch.id })).status_label, "已归档");
    assert.equal(state.calls.at(-1)?.previous?.branch, branch); assert.equal(JSON.stringify(listKnowledgeDocuments(dir)), formal);
  } finally { await close(state.manager); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5/14：领域手动归档HTTP公开preview/create/retry，退役远端刷新和核对入口返回404", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-manual-http-")), state = harness(dir);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const id = await state.seed(); await state.manager.publish(id, "reviewer");
    const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => state.manager, prepareKnowledgeIndex() {} } as unknown as TaskService;
    const readBody = async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); };
    server = createServer((request, response) => { void domainKnowledgeRoute(request, response, request.url!.slice(1).split("/"), service, "exporter", readBody,
      (out, status, value) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(value)); }); });
    server.requestTimeout = 5_000; await within(new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); }), "HTTP启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/domain-extraction/${id}`;
    const previewResponse = await fetch(`${base}/archive/preview`, { signal: AbortSignal.timeout(5_000) }); assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as Preview;
    const created = await fetch(`${base}/archive/create`, { method: "POST", body: JSON.stringify({ issue_no: "REQ-HTTP", expected_revisions: preview.expected_revisions }), signal: AbortSignal.timeout(5_000) });
    assert.equal(created.status, 200); assert.equal((await created.json() as Preview).status_label, "已归档");
    for (const retired of ["refresh", "remote", "reconcile", "archive-retry"]) {
      const response = await fetch(`${base}/${retired}`, { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) }); assert.equal(response.status, 404, `${retired} 不留旧兼容入口`);
    }
  } finally {
    if (server) await within(new Promise<void>((done, reject) => { server!.close(error => error ? reject(error) : done()); server!.closeAllConnections(); }), "HTTP关停超过5秒预算");
    await close(state.manager); rmSync(dir, { recursive: true, force: true });
  }
});
