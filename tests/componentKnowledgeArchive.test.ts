import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

const input = { research_id: "cr-source", title: "组件使用指南", content: "# 组件\n经过人工选择的组件知识", language: "cpp", sources: "src/file.cpp @ abc", issue_no: "REQ-component", target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs/components" }, filename: "guide.md" };

test("组件归档准备可复用、人工稿防覆盖、保存跨重启、目标锁定且不进入领域任务列表", async () => {
  const root = mkdtempSync(join(tmpdir(), "component-archive-"));
  const service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不得运行领域 Skill"); }, {
    previewCleanup: async (job, target) => ({ id: "preview", target_id: target.id, directories: ["docs"], target_revision: "base", target_entries: [{ path: "docs/old.md", mode: "100644", oid: "old" }, { path: job.documents[0].path, mode: "100644", oid: "doc" }], confirmed: false, document_versions: [] }),
    publish: async (_job, target) => ({ target_id: target.id, state: "opened", branch: "codex/component", url: "https://example.test/mr/1", documents: [] }),
  });
  try {
    assert.throws(() => service.prepareComponent({ ...input, filename: "../guide.md" }, "dev"), /相对路径/);
    assert.throws(() => service.prepareComponent({ ...input, issue_no: "" }, "dev"), /关联单号/);
    let job = service.prepareComponent(input, "dev");
    assert.equal(service.list().length, 0); assert.equal(job.documents[0].path, "docs/components/guide.md");
    assert.equal(job.component_research_id, "cr-source"); assert.match(job.documents[0].content, /萃取来源/);
    assert.throws(() => service.run(job.id, { mode: "extract", message: "错误入口" }, "dev"), /基础组件/);
    const first = job.documents[0]; job = service.edit(job.id, { document: { ...first, content: "人工归档合并稿\n" }, base_revision: first.revision }, "dev");
    assert.throws(() => service.prepareComponent({ ...input, base_revision: 1 }, "dev"), /新版本/);
    job = service.prepareComponent({ ...input, content: "更新过的组件知识", base_revision: job.documents[0].revision }, "dev");
    assert.equal(job.documents[0].history.at(-1)!.content, "人工归档合并稿\n");
    const restarted = new DomainKnowledgeExtraction(root, async () => "unused");
    assert.equal(restarted.componentArchive(input.research_id)!.id, job.id); await restarted.shutdown();
    await service.previewCleanup(job.id, "domain", {}, "dev");
    assert.throws(() => service.confirmCleanup(job.id, "preview", true, ["elsewhere.md"]), /清单/);
    assert.throws(() => service.confirmCleanup(job.id, "preview", true, [job.documents[0].path]), /新增文档/);
    const selected = service.confirmCleanup(job.id, "preview", false, ["docs/old.md"]);
    assert.deepEqual(selected.cleanup_plans![0].preserve_paths, ["docs/old.md"]);
    await service.publish(job.id, "dev");
    assert.throws(() => service.prepareComponent({ ...input, target: { ...input.target, docs_path: "elsewhere" }, base_revision: job.documents[0].revision }, "dev"), /不能更换/);
    assert.throws(() => service.prepareComponent({ ...input, issue_no: "REQ-other", base_revision: job.documents[0].revision }, "dev"), /不能更换/);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("组件归档 HTTP 实际连接任务、同名文件比较、修订与 MR 参数，正式正文不能绕过 MR", async () => {
  const root = mkdtempSync(join(tmpdir(), "component-archive-http-"));
  const auth = new LocalAuth(join(root, "auth.json")); auth.bootstrapAdmin("admin", "fixture-admin-password"); auth.createUser("dev", "fixture-dev-password", "developer");
  const host = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  saveComponentRepository(root, { name: "组件", repository: "https://example.test/component.git", branch: "main", path: "", languages: ["cpp"] }, "dev");
  const research = new ComponentResearch(root, async () => "# 组件指南\n读取源码后的草稿");
  const job = research.start({ language: "cpp", topic: "组件接口" }, "dev");
  while (research.get(job.id).status !== "done") await new Promise(r => setTimeout(r, 5));
  let publishedIssue = "";
  const manager = new DomainKnowledgeExtraction(root, async () => "unused", {
    readRemote: async () => ({ id: "remote-fixture", target_revision: "a".repeat(40), target_content: "仓内人工规则\n", reviewed: false }),
    publish: async (draft, target) => { publishedIssue = draft.issue_no!; assert.match(draft.documents[0].content, /仓内人工规则/); return { target_id: target.id, state: "opened", branch: "codex/component", url: "https://example.test/mr/1", documents: [] }; },
  });
  (host as any).componentResearch = research; (host as any).domainKnowledgeExtraction = manager;
  const server = createTaskServer(host, { auth }); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  let cookie = "";
  const request = (path: string, body?: unknown) => fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const endpoint = `/component-research/${job.id}/archive`;
  try {
    assert.equal((await request(endpoint)).status, 401);
    cookie = (await request("/auth/login", { username: "dev", password: "fixture-dev-password" })).headers.get("set-cookie")!.split(";")[0];
    assert.deepEqual(await (await request(endpoint)).json(), { archive: null, defaults: { repository: "https://example.test/component.git", branch: "main", directory: "docs/components", filename: "component-guide.md" } });
    const prepared = await request(endpoint, { ...input, research_id: "spoofed" }); assert.equal(prepared.status, 200);
    let archive: any = await prepared.json(); assert.equal(archive.component_research_id, job.id); assert.equal(archive.documents[0].remote_review.target_content, "仓内人工规则\n");
    assert.match(archive.documents[0].content, /读取源码后的草稿|经过人工选择/);
    const doc = archive.documents[0];
    const merged = await request(endpoint + "/reconcile", { document: { ...doc, content: "仓内人工规则\n新组件用法\n" }, base_revision: doc.revision, snapshot_id: doc.remote_review.id });
    assert.equal(merged.status, 200); archive = await merged.json();
    assert.equal((await request(endpoint + "/publish", {})).status, 200); assert.equal(publishedIssue, "REQ-component");
    const rules: any = await (await request(endpoint + "/cleanup-template", { path: "AGENTS.md" })).json(); assert.match(rules.content, /docs\/components\/guide.md/);
    const knowledge = saveKnowledgeDocument(root, { title: "组件", content: "合入正文", scope: "platform", technologies: ["cpp"], source: { repository: input.target.repository, branch: "main", path: "docs/components/guide.md", revision: "a" }, research_source: { job_id: job.id, repository: input.target.repository, branch: "main", path: "docs/components/guide.md" } }, "dev");
    assert.equal((await request(`/knowledge-documents/${knowledge.id}`, { content: "绕过 MR 的正文" })).status, 400);
    assert.equal((await request(`/knowledge-documents/${knowledge.id}`, { active: false })).status, 200);
  } finally { await host.shutdown(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
});
