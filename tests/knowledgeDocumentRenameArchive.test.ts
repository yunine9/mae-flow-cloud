import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { eraseKnowledgeDocument, listKnowledgeDocuments, readKnowledgeArchiveVersion, readKnowledgeDocument, readKnowledgeDocumentVersion, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { componentArchiveParts, componentArchivePath } from "../src/componentKnowledgeArchiveFormat.ts";
import { researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import { componentGuideOverview, componentGuideSection } from "./fixtures/componentGuide.ts";
import type { DomainArchiveBatch, DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

const oldPath = "docs/knowledge/SONCommMgr/SONCommMgr.md";
const newPath = "docs/knowledge/SONComm/SONComm.md";
const original = "# SONComm\n已确认的旧版知识。\n";
const updated = "# SONComm\n已确认的改名后知识。\n";

async function fixture(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-document-rename-")), source = join(dir, "source"), remote = join(dir, "remote.git");
  mkdirSync(source);
  const gitRaw = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
  const git = (...args: string[]) => gitRaw(...args).trim();
  git("-C", source, "init", "-b", "main");
  git("-C", source, "config", "user.name", "Fixture"); git("-C", source, "config", "user.email", "alice@example.test");
  const write = (path: string, content: string) => { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), content); };
  write("code.ts", "export const untouched = true;\n");
  for (const [path, content] of Object.entries(files)) write(path, content);
  git("-C", source, "add", "."); git("-C", source, "commit", "-m", "fixture");
  const baseline = git("-C", source, "rev-parse", "HEAD");
  git("clone", "--bare", source, remote);
  const requests: string[] = [], mrs: Array<{ id: number; url: string; source_branch: string; target_branch: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); requests.push(url.pathname);
    if (url.pathname === "/mr/discover") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ mrs: mrs.filter(mr => mr.source_branch === url.searchParams.get("source_branch") && mr.target_branch === url.searchParams.get("target_branch")) }));
      return;
    }
    if (url.pathname !== "/mr") { response.statusCode = 404; response.end("{}"); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), mr = { id: mrs.length + 1, url: `https://example.test/mr/${mrs.length + 1}`, source_branch: input.source_branch, target_branch: input.target_branch };
    mrs.push(mr); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(mr));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const target = { id: "domain", name: "知识仓", repository: remote, branch: "main", path: "", docs_path: "docs/knowledge" };
  const formal = saveKnowledgeDocument(dir, { title: "SONComm", content: original, scope: "platform", archive_target: { repository: remote, branch: "main", path: oldPath } }, "alice");
  const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title: "DSON 模块知识", scope: "SONComm", issue_no: "REQ-466", operator: "alice",
    created_at: "2026-10-12T00:00:00.000Z", status: "done", stage: "已入库", knowledge_target: target, repositories: [], material_ids: [],
    revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "son-comm", title: formal.title, target_id: "domain", layer: "domain", path: oldPath,
      content: formal.content, sources: "固定版本源码", selected: true, revision: 1, base_content: null, base_revision: baseline, history: [],
      knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }] };
  const publisher = new KnowledgeMrPublisher({ dataDir: dir, platformUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credential: () => ({ username: "alice", password: "fixture-token", email: "alice@example.test" }) });
  let last: DomainPublication | undefined;
  const save = (publication: DomainPublication) => { last = structuredClone(publication); };
  const publish = (previous?: DomainPublication, callback = save) => publisher.publish(job, target, previous, "alice", callback);
  const rename = (path = newPath) => {
    const document = job.documents[0], previous = readKnowledgeDocument(dir, formal.id);
    document.base_path ??= document.path;
    const next = saveKnowledgeDocument(dir, { ...previous, content: updated, archive_target: { repository: target.repository, branch: target.branch, path } }, "alice", formal.id, { expectedRevision: previous.revision });
    Object.assign(document, { path, content: next.content, revision: document.revision + 1, published_revision: next.revision, published_document_revision: document.revision + 1 });
  };
  const freeze = (publication: DomainPublication) => {
    const batch: DomainArchiveBatch = { id: randomUUID(), created_at: new Date().toISOString(), operator: "alice", state: "done", issue_no: "REQ-466",
      documents: structuredClone(job.documents), targets: [structuredClone(target)], publications: [structuredClone(publication)] };
    (job.archive_batches ??= []).push(batch);
  };
  const remove = () => {
    const document = job.documents[0], current = readKnowledgeDocument(dir, formal.id);
    const deletionVersion = saveKnowledgeDocument(dir, { ...current, active: false }, "alice", formal.id, { expectedRevision: current.revision });
    readKnowledgeDocumentVersion(dir, deletionVersion.id, deletionVersion.revision);
    document.revision++;
    Object.assign(document, { deleted: true, content: deletionVersion.content, published_revision: deletionVersion.revision, published_document_revision: document.revision });
    writeKnowledgeDeletion(dir, { id: deletionVersion.id, title: deletionVersion.title, revision: deletionVersion.revision,
      at: new Date().toISOString(), operator: "alice", research_job_id: job.id, index_ids: [deletionVersion.id], index_state: "removed" });
    eraseKnowledgeDocument(dir, deletionVersion.id);
    return deletionVersion;
  };
  const tree = (revision: string, path: string) => git("-C", remote, "--literal-pathspecs", "ls-tree", revision, "--", path);
  const content = (revision: string, path: string) => gitRaw("-C", remote, "show", `${revision}:${path}`);
  return { dir, source, remote, target, job, formal, publisher, requests, mrs, git, gitRaw, write, baseline, save, publish, rename, freeze, remove, tree, content,
    last: () => last!,
    async close() { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); rmSync(dir, { recursive: true, force: true }); } };
}

test("Issue466：未归档草稿的原路径在 Git 不存在，不凭修订历史删除其他 Git 文件", { timeout: 20_000 }, async () => {
  const unrelated = "docs/knowledge/unrelated.md";
  const f = await fixture({ [unrelated]: original });
  try {
    f.job.documents[0].history.push({ revision: 1, path: unrelated, content: original, sources: "旧草稿", title: "SONCommMgr", operator: "alice", at: new Date().toISOString() });
    f.rename();
    const publication = await f.publish();
    assert.equal(f.content(publication.revision!, unrelated), original, "没有 Git 基线或已推送快照，历史正文相同也不能授权删除");
    assert.equal(f.tree(publication.revision!, oldPath), "");
    assert.equal(f.content(publication.revision!, newPath), updated);
    assert.equal(f.content(publication.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("Issue466：删除未归档草稿且 Git 没有该文件，纯删除批次可归档且不产生文档", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    f.rename("AGENTS.md");
    const deleted = f.remove();
    assert.throws(() => readKnowledgeDocument(f.dir, deleted.id), /知识已删除/);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
    assert.equal(listKnowledgeDocuments(f.dir).length, 0);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.revision, deleted.revision);
    const result = await f.publish();
    assert.equal(result.state, "opened");
    assert.equal(result.documents[0].deleted, true);
    assert.equal(result.documents[0].path, "AGENTS.md", "授权目标仓内的根 Markdown 不受默认目录限制");
    assert.equal(f.tree(result.revision!, "AGENTS.md"), "");
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.content(result.revision!, "code.ts"), "export const untouched = true;\n");
    assert.equal(listKnowledgeDocuments(f.dir).length, 0);
  } finally { await f.close(); }
});

test("Issue466：初始 Git Markdown 删除只删除已核对文件，普通知识读取仍拒绝已删版本", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; const deleted = f.remove();
    const result = await f.publish();
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.git("-C", f.remote, "rev-parse", `${result.revision}^`), f.baseline);
    assert.equal(f.content(f.baseline, oldPath), original);
    assert.equal(result.documents[0].knowledge_revision, deleted.revision);
    assert.equal(result.documents[0].deleted, true);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：已发布知识删除在同一树删除当前名字及可核对旧名字，旧 MR 仍可追溯", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first); f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename(); const second = await f.publish(); f.freeze(second); f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write(oldPath, original); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "retain duplicate old name"); f.git("-C", f.source, "push", f.remote, "main");
    f.remove();
    const result = await f.publish();
    assert.equal(f.tree(result.revision!, oldPath), "");
    assert.equal(f.tree(result.revision!, newPath), "");
    assert.equal(f.content(first.revision!, oldPath), original);
    assert.equal(f.content(second.revision!, newPath), updated);
    assert.equal(result.documents[0].deleted, true);
    assert.equal(f.content(result.revision!, "code.ts"), "export const untouched = true;\n");
  } finally { await f.close(); }
});

test("Issue466：删除文件已被修改，或旧名已归他人知识时拒绝并保留远端文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original;
    f.write(oldPath, "他人修改的正文\n"); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "edit old document"); f.git("-C", f.source, "push", f.remote, "main");
    f.remove();
    const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
    await assert.rejects(f.publish(), /删除原文件.*已被修改.*未删除/);
    assert.equal(f.content("main", oldPath), "他人修改的正文\n");
    assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
    assert.equal(f.mrs.length, 0);
  } finally { await f.close(); }
  const owned = await fixture({ [oldPath]: original });
  try {
    owned.job.documents[0].base_content = original; owned.rename();
    const owner = saveKnowledgeDocument(owned.dir, { title: "另一模块", content: original, scope: "platform", archive_target: { repository: owned.remote, branch: "main", path: oldPath } }, "bob");
    owned.remove();
    await assert.rejects(owned.publish(), /原路径.*已被其他正式知识使用.*未删除/);
    assert.equal(owned.content("main", oldPath), original);
    assert.equal(readKnowledgeDocument(owned.dir, owner.id).content, original);
    assert.equal(owned.mrs.length, 0);
  } finally { await owned.close(); }
});

test("Issue466：删除提交推送后记录写失败，人工重试复用删除分支和精确版本", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; const deleted = f.remove();
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟删除推送后的保存失败");
      f.save(publication);
    }), /模拟删除推送后的保存失败/);
    const attempted = f.last();
    assert.equal(attempted.attempted_documents?.[0].deleted, true);
    assert.equal(f.tree(attempted.revision!, oldPath), "");
    const recovered = await f.publish({ ...attempted, state: "failed" });
    assert.equal(recovered.branch, attempted.branch);
    assert.equal(recovered.revision, attempted.revision);
    assert.equal(recovered.documents[0].deleted, true);
    assert.equal(recovered.documents[0].knowledge_revision, deleted.revision);
    assert.equal(f.mrs.length, 1);
    assert.throws(() => readKnowledgeDocument(f.dir, deleted.id), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：未确认的草稿删除及已删除知识的旧写入快照都不能执行 Git 操作", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].deleted = true;
    await assert.rejects(f.publish(), /请先确认发布当前删除文稿/);
    const deleted = f.remove();
    f.job.documents[0].deleted = false;
    await assert.rejects(f.publish(), /知识已删除.*不能重新写入/);
    f.job.documents[0].deleted = true; f.job.documents[0].published_document_revision = f.job.documents[0].revision - 1;
    await assert.rejects(f.publish(), /请先确认发布当前删除文稿/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.mrs.length, 0);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.id, deleted.id);
  } finally { await f.close(); }
});

test("Issue466：已删知识内部归档只认 tombstone 精确版本并校验保留记录", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const prior = f.formal.revision, deleted = f.remove();
    assert.notEqual(deleted.revision, prior);
    assert.throws(() => readKnowledgeArchiveVersion(f.dir, deleted.id, prior), /只能归档删除时绑定的精确版本/);
    const path = join(f.dir, "knowledge-document-versions", deleted.id, `${deleted.revision}.json`), before = readFileSync(path, "utf8");
    for (const change of [
      (value: any) => { value.document.id = `kd-${randomUUID()}`; },
      (value: any) => { value.document.revision = "a".repeat(64); },
      (value: any) => { value.document.content = ""; },
      (value: any) => { value.operator = ""; },
      (value: any) => { value.published_at = "invalid"; },
    ]) {
      const value = JSON.parse(before); change(value); writeFileSync(path, JSON.stringify(value));
      assert.throws(() => readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision), /归档版本记录损坏/);
    }
    writeFileSync(path, before);
    assert.equal(readKnowledgeArchiveVersion(f.dir, deleted.id, deleted.revision).document.id, deleted.id);
    assert.throws(() => readKnowledgeDocumentVersion(f.dir, deleted.id, deleted.revision), /知识已删除/);
  } finally { await f.close(); }
});

test("Issue466：原路径在 Git 存在但没有可核对基线时拒绝改名，保留原文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].history.push({ revision: 1, path: oldPath, content: original, sources: "旧草稿", title: "SONCommMgr", operator: "alice", at: new Date().toISOString() });
    f.rename();
    await assert.rejects(f.publish(), /原文件.*无法核对.*未删除/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.tree("main", newPath), "");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("Issue466：初始 Git 基线改名在同一提交删除旧文件并写新文件，稳定知识 ID 保留", { timeout: 20_000 }, async () => {
  const referencePaths = ["docs/knowledge/module-map.md", "docs/knowledge/AGENTS.md"];
  const oldReference = `参阅 [SONCommMgr](${oldPath})。\n`, newReference = `参阅 [SONComm](${newPath})。\n`;
  const f = await fixture({ [oldPath]: original, ...Object.fromEntries(referencePaths.map(path => [path, oldReference])) });
  try {
    f.job.documents[0].base_content = original;
    f.rename();
    for (const [index, path] of referencePaths.entries()) {
      const formal = saveKnowledgeDocument(f.dir, { title: index ? "AGENTS" : "module-map", content: newReference, scope: "platform", archive_target: { repository: f.remote, branch: "main", path } }, "alice");
      f.job.documents.push({ id: `reference-${index}`, title: formal.title, target_id: "domain", layer: "domain", path, content: formal.content, sources: "改名映射", selected: true, revision: 1, base_content: oldReference, base_revision: f.baseline, history: [], knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 });
    }
    const publication = await f.publish();
    assert.equal(f.tree(publication.revision!, oldPath), "");
    assert.equal(f.content(publication.revision!, newPath), updated);
    assert.equal(f.git("-C", f.remote, "rev-parse", `${publication.revision}^`), f.baseline);
    assert.equal(publication.documents[0].id, "son-comm");
    assert.equal(publication.documents[0].knowledge_document_id, f.formal.id);
    assert.equal(readKnowledgeDocument(f.dir, f.formal.id).archive_target?.path, newPath);
    assert.equal(f.content(publication.revision!, "code.ts"), "export const untouched = true;\n");
    for (const path of referencePaths) {
      assert.equal(f.content(publication.revision!, path), newReference, "引用随改名进入同一 Git 树提交");
      assert.equal(f.content(f.baseline, path), oldReference);
    }
  } finally { await f.close(); }
});

test("Issue466：已推送归档批次提供旧文件证据，目录和文件改名不会留下原文件", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const next = await f.publish();
    assert.notEqual(next.branch, first.branch);
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
    assert.equal(f.content(first.revision!, oldPath), original, "原归档版本和 MR 快照不改变");
    assert.equal(f.job.archive_batches![0].publications[0].documents[0].path, oldPath);
  } finally { await f.close(); }
});

test("Issue466：旧 publication_history 按精确正式版本核对目标后安全改名", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.job.publication_history = [structuredClone(first)];
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const next = await f.publish();
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
  } finally { await f.close(); }
});

test("Issue466：原路径被另一篇正式知识重用，旧内容相同也不能在后续改名中删除", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    f.rename();
    const second = await f.publish(); f.freeze(second);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", second.revision!);
    const owner = saveKnowledgeDocument(f.dir, { title: "新的独立模块", content: original, scope: "platform",
      archive_target: { repository: f.remote, branch: "main", path: oldPath },
      research_source: { job_id: `dkx-${randomUUID()}`, document_id: "other-module", repository: f.remote, branch: "main", path: oldPath } }, "bob");
    f.git("-C", f.source, "fetch", f.remote, "main"); f.git("-C", f.source, "reset", "--hard", "FETCH_HEAD");
    f.write(oldPath, original); f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "another knowledge owns old path"); f.git("-C", f.source, "push", f.remote, "main");
    const formalFile = join(f.dir, "knowledge-documents", `${owner.id}.json`), formalBefore = readFileSync(formalFile, "utf8");
    const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
    const thirdPath = "docs/knowledge/通信/SONComm.md";
    f.rename(thirdPath);
    await assert.rejects(f.publish(), /原路径.*已被其他正式知识使用.*未删除/);
    assert.equal(f.content("main", oldPath), original, "另一个任务的文件与历史正文相同，也必须保留");
    assert.equal(f.content("main", newPath), updated);
    assert.equal(f.tree("main", thirdPath), "");
    assert.equal(readFileSync(formalFile, "utf8"), formalBefore, "不改变另一个任务的正式知识");
    assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
    assert.equal(f.mrs.length, 2, "所有权冲突不推送或创建第三个 MR");
  } finally { await f.close(); }
});

for (const changed of ["old", "destination"] as const) {
  test(`Issue466：${changed === "old" ? "并发修改旧文件" : "新目的地被其他文件占用"}时拒绝改名，不推送或创建 MR`, { timeout: 20_000 }, async () => {
    const f = await fixture({ [oldPath]: original });
    try {
      f.job.documents[0].base_content = original; f.rename();
      f.write(changed === "old" ? oldPath : newPath, changed === "old" ? "管理员修改的新内容\n" : updated);
      f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "concurrent change"); f.git("-C", f.source, "push", f.remote, "main");
      const branches = f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
      await assert.rejects(f.publish(), changed === "old" ? /原文件.*已被修改/ : /改名目标.*已有其他文件/);
      assert.equal(f.git("-C", f.remote, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads"), branches);
      assert.equal(f.requests.length, 0);
      assert.equal(f.content("main", oldPath), changed === "old" ? "管理员修改的新内容\n" : original);
      assert.equal(changed === "destination" ? f.content("main", newPath) : f.tree("main", newPath), changed === "destination" ? updated : "");
    } finally { await f.close(); }
  });
}

test("Issue466：新目录含软链接时拒绝改名并保留旧文件", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; f.rename();
    symlinkSync("../SONCommMgr", join(f.source, "docs/knowledge/SONComm"));
    f.git("-C", f.source, "add", "."); f.git("-C", f.source, "commit", "-m", "add symlink"); f.git("-C", f.source, "push", f.remote, "main");
    await assert.rejects(f.publish(), /父路径包含文件或软链接/);
    assert.equal(f.content("main", oldPath), original);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("Issue466：另一目标分支的归档快照不能授权删除当前分支的旧文件", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/release", first.revision!);
    f.target.branch = "release";
    f.rename();
    await assert.rejects(f.publish(), /原文件.*无法核对.*未删除/);
    assert.equal(f.content("release", oldPath), original);
    assert.equal(f.tree("release", newPath), "");
    assert.equal(f.job.archive_batches![0].targets[0].branch, "main");
  } finally { await f.close(); }
});

test("Issue466：组件知识标题改名也复用归档器，同一正式知识只移出一篇正文", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    createTechnologyStack(f.dir, { name: "C++" }, "fixture");
    f.job.component_research_id = `cr-${randomUUID()}`;
    const document = { overview: componentGuideOverview(), sections: [{ ...componentGuideSection("file-operations", ["reference"]), selected: true, revision: 1 }] };
    const firstContent = researchDocumentMarkdown("FileMgr", document);
    const firstPath = componentArchivePath(f.target.docs_path, { title: "FileMgr", technologies: ["cpp"] });
    const previous = readKnowledgeDocument(f.dir, f.formal.id);
    const firstFormal = saveKnowledgeDocument(f.dir, { ...previous, title: "FileMgr", content: firstContent, technologies: ["cpp"], archive_target: { repository: f.remote, branch: "main", path: firstPath } }, "alice", f.formal.id, { expectedRevision: previous.revision });
    Object.assign(f.job.documents[0], { path: firstPath, title: firstFormal.title, content: firstFormal.content, published_revision: firstFormal.revision });
    const first = await f.publish(); f.freeze(first);
    f.git("-C", f.remote, "update-ref", "refs/heads/main", first.revision!);
    const nextPath = componentArchivePath(f.target.docs_path, { title: "文件操作", technologies: ["cpp"] });
    const nextFormal = saveKnowledgeDocument(f.dir, { ...firstFormal, title: "文件操作", content: researchDocumentMarkdown("文件操作", document), archive_target: { repository: f.remote, branch: "main", path: nextPath } }, "alice", f.formal.id, { expectedRevision: firstFormal.revision });
    Object.assign(f.job.documents[0], { path: nextPath, title: nextFormal.title, content: nextFormal.content, revision: 2, published_revision: nextFormal.revision, published_document_revision: 2 });
    const next = await f.publish();
    assert.equal(f.tree(next.revision!, firstPath), "");
    assert.equal(f.content(next.revision!, nextPath), componentArchiveParts(nextFormal.content).content);
    assert.doesNotMatch(f.content(next.revision!, nextPath), /component_paradigms|schema:/);
    assert.equal(next.documents.length, 1);
    assert.equal(next.documents[0].knowledge_document_id, firstFormal.id);
    assert.equal(f.content(first.revision!, firstPath), componentArchiveParts(firstFormal.content).content);
  } finally { await f.close(); }
});

test("Issue466：改名提交已推送但回执保存失败，重试沿用精确分支和同一提交", { timeout: 20_000 }, async () => {
  const f = await fixture({ [oldPath]: original });
  try {
    f.job.documents[0].base_content = original; f.rename();
    await assert.rejects(f.publish(undefined, publication => {
      if (publication.documents.length) throw new Error("模拟推送后记录写失败");
      f.save(publication);
    }), /模拟推送后记录写失败/);
    const attempted = f.last();
    assert.ok(attempted.revision);
    assert.deepEqual(attempted.documents, [], "恢复只拿到推送前的保存窗口，不能假装已有完整推送回执");
    assert.equal(f.git("-C", f.remote, "rev-parse", attempted.branch), attempted.revision);
    assert.equal(f.tree(attempted.revision!, oldPath), "");
    assert.equal(f.content(attempted.revision!, newPath), updated);
    assert.equal(f.requests.length, 0);
    const next = await f.publish({ ...attempted, state: "failed" });
    assert.equal(next.branch, attempted.branch);
    assert.equal(next.revision, attempted.revision, "精确远端版本已完成改名，不重复写提交");
    assert.equal(next.state, "opened");
    assert.equal(f.mrs.length, 1);
    assert.equal(f.tree(next.revision!, oldPath), "");
    assert.equal(f.content(next.revision!, newPath), updated);
  } finally { await f.close(); }
});
