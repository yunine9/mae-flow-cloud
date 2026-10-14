import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { assertModuleKnowledgePath, moduleKnowledgeDirectory, moduleKnowledgePath } from "../src/domainKnowledgeLayout.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { readKnowledgeDocument } from "../src/knowledgeDocuments.ts";

const source = { repository: "https://example.test/shared.git", name: "共享业务仓", branch: "main", docs_path: "docs/knowledge" };
const knowledgeTarget = { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domain-docs" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = service.get(id);
    if (job.status === "done") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("萃取未完成");
}
function module(root: string, id: string) {
  return createBusinessModule(root, { id, name: id, description: `${id} 模块业务`, owner: "user", repositories: [source.repository] }, "user");
}

test("模块目录和路径映射保持幂等，仓根导航移入模块说明且目录外文件不折叠", () => {
  assert.equal(moduleKnowledgeDirectory("docs/knowledge", "orders"), "docs/knowledge/orders");
  assert.equal(moduleKnowledgeDirectory("docs/knowledge/orders/", "orders"), "docs/knowledge/orders");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "AGENTS.md"), "docs/orders/README.md");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "docs/nested/rules.md"), "docs/orders/nested/rules.md");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "guides/nested/rules.md"), "docs/orders/guides/nested/rules.md");
  assert.equal(moduleKnowledgePath("docs/shared", "docs/shared/orders", "docs/shared/orders/custom.md"), "docs/shared/orders/custom.md");
  assert.equal(moduleKnowledgePath("docs/", "docs/orders/", "docs/topic/AGENTS.md"), "docs/orders/topic/index.md");
  assert.equal(moduleKnowledgePath("docs", "docs/orders", "docs/orders/AGENTS.md"), "docs/orders/index.md");
  assert.throws(() => moduleKnowledgeDirectory("../docs", "orders"), /相对路径/);
  const job = { module_id: "orders", knowledge_layout: "module-v1" as const }, target = { docs_path: "docs/knowledge/orders" };
  assertModuleKnowledgePath(job, target, "docs/knowledge/orders/README.md");
  assert.throws(() => assertModuleKnowledgePath(job, target, "docs/knowledge/orders/topic/AGENTS.md"), /不生成 AGENTS/);
  for (const path of ["AGENTS.md", "docs/knowledge/other/rules.md", "docs/knowledge/orders/../other/rules.md"]) {
    assert.throws(() => assertModuleKnowledgePath(job, target, path), /本模块文稿/);
  }
  assertModuleKnowledgePath({ module_id: "orders" }, target, "AGENTS.md");
});

test("共享仓新任务按模块隔离，仓级正式知识也保留模块归属和研究来源", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-layout-"));
  const service = new DomainKnowledgeExtraction(root, async input => {
    assert.throws(() => input.save({ id: "root", title: "旧入口", target_id: "repo-1", path: "AGENTS.md", layer: "repository", content: "规则", sources: "源码" }), /本模块文稿/);
    assert.throws(() => input.save({ id: "nested", title: "多余入口", target_id: "repo-1", path: `${input.job.repositories[0].docs_path}/AGENTS.md`, layer: "repository", content: "规则", sources: "源码" }), /不生成 AGENTS/);
    for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: "模块说明", target_id: target.id,
      path: `${target.docs_path}/README.md`, layer: target.id === "domain" ? "domain" : "repository", content: `# ${input.job.module_id}`, sources: "源码" });
    return "done";
  });
  try {
    for (const id of ["orders", "shipping"]) module(root, id);
    const jobs: DomainKnowledgeJob[] = [];
    for (const id of ["orders", "shipping"]) {
      let job = await done(service, service.create({ module_id: id, issue_no: `REQ-${id}`, baseline_branch: "main", knowledge_target: knowledgeTarget }, "user").id);
      assert.equal(job.knowledge_layout, "module-v1");
      assert.equal(job.repositories[0].docs_path, `docs/knowledge/${id}`);
      assert.equal(job.knowledge_target.docs_path, `domain-docs/${id}`);
      assert.equal(job.source_repositories![0].docs_path, "docs/knowledge");
      await service.publish(job.id, "user"); job = service.get(job.id); jobs.push(job);
      for (const document of job.documents) {
        const formal = readKnowledgeDocument(root, document.knowledge_document_id!);
        assert.equal(formal.scope, "module"); assert.deepEqual(formal.module_ids, [id]);
        assert.equal(formal.research_source!.path, document.path);
        assert.equal(formal.research_source!.repository, document.target_id === "domain" ? knowledgeTarget.repository : source.repository);
      }
    }
    assert.notEqual(jobs[0].documents.find(document => document.target_id === "repo-1")!.path, jobs[1].documents.find(document => document.target_id === "repo-1")!.path);
    const before = service.get(jobs[1].id);
    assert.throws(() => service.configureArchive(before.id, { base_revision: 0,
      targets: [{ ...before.repositories[0], repository: "https://example.test/shared", docs_path: "docs/knowledge/orders" }] }), /重叠/);
    assert.deepEqual(service.get(before.id), before, "拒绝与其他模块目录嵌套时不改任务");
    // orders 的新目录将包含 shipping 已占的旧目录，不能反向吞并。
    service.configureArchive(jobs[1].id, { base_revision: 0, targets: [{ ...before.repositories[0], docs_path: "custom/orders/shipping" }] });
    const orders = service.get(jobs[0].id);
    assert.throws(() => service.configureArchive(orders.id, { base_revision: 0,
      targets: [{ ...orders.repositories[0], docs_path: "custom/orders" }] }), /重叠/);
    assert.throws(() => service.create({ module_id: "shipping", issue_no: "REQ-new-overlap", baseline_branch: "main",
      knowledge_target: { ...knowledgeTarget, docs_path: "domain-docs/orders" } }, "user"), /重叠/);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("已完成旧模块任务显式整理目录不重新研究，保留文稿编号、工作记录和正式知识身份", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-migration-"));
  let executions = 0;
  let service = new DomainKnowledgeExtraction(root, async input => {
    executions++;
    input.save({ id: "agents", title: "模块入口", target_id: "repo-1", path: "AGENTS.md", layer: "repository", content:
      '# 模块入口\n[规则](docs/knowledge/rules.md)\n[源码](src/order.ts#cancel)\n[外部](https://example.test/x)\n[复杂](docs/knowledge/a(b(c)).md)\n`[示例](docs/knowledge/rules.md)`\n~~~md\n[示例](docs/knowledge/rules.md)\n~~~', sources: "源码" });
    input.save({ id: "rules", title: "规则", target_id: "repo-1", path: "docs/knowledge/rules.md", layer: "repository", content:
      '# 规则\n[入口](../../AGENTS.md)\n[源码](../../src/order.ts)\n[说明][entry]\n[entry]: ../../AGENTS.md "模块说明"', sources: "源码" });
    input.save({ id: "extra", title: "补充", target_id: "repo-1", path: "guides/nested.md", layer: "repository", content: "# 补充\n[入口](../AGENTS.md)", sources: "源码" });
    input.save({ id: "topic", title: "专题入口", target_id: "repo-1", path: "docs/knowledge/topic/AGENTS.md", layer: "repository", content: "# 专题\n[规则](../rules.md)", sources: "源码" });
    return "done";
  });
  try {
    module(root, "orders");
    let job = await done(service, service.create({ issue_no: "REQ-legacy", title: "旧模块研究", scope: "业务规则", repositories: [source], knowledge_target: knowledgeTarget }, "user").id);
    await service.publish(job.id, "user"); job = service.get(job.id);
    const identities = job.documents.map(document => document.knowledge_document_id), revisions = job.documents.map(document => document.published_revision);
    const originalTurns = structuredClone(job.turns), originalSources = structuredClone(job.source_repositories);
    await service.shutdown();
    const jobFile = join(root, "domain-extraction", job.id, "job.json"), persisted = JSON.parse(readFileSync(jobFile, "utf8"));
    persisted.archive_batches.push({ id: "legacy-batch", created_at: new Date().toISOString(), operator: "user", state: "failed", issue_no: "REQ-legacy",
      documents: structuredClone(job.documents), targets: [structuredClone(job.repositories[0])], publications: [] });
    persisted.module_id = "orders"; writeFileSync(jobFile, JSON.stringify(persisted));
    const workDirectory = join(root, "domain-extraction", job.id, "skill-runs", job.turns[0].id);
    mkdirSync(workDirectory, { recursive: true });
    const workFile = join(workDirectory, "work.json"), workBytes = JSON.stringify({ version: 1, skill: "old-pinned-method", steps: [
      { id: "research", title: "调查", instructions: "读取源码", readonly: true, depends_on: [], status: "done", attempts: 1, result: { summary: "已经完成", document_ids: [] } },
    ], documents: [{ id: "plan", title: "完整规划", content: "已完成调查和写作" }], plan: { document_ids: ["agents", "rules", "extra", "topic"], work_document_id: "plan" } });
    writeFileSync(workFile, workBytes);
    const archiveInputs: DomainKnowledgeJob[] = [];
    service = new DomainKnowledgeExtraction(root, async () => { executions++; throw new Error("完成态目录迁移不应重新调用研究"); }, {
      publish: async (archiving, target) => {
        archiveInputs.push(structuredClone(archiving));
        return { target_id: target.id, state: "opened", url: "https://example.test/mr/1", branch: "codex/legacy-archive", documents:
          archiving.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
            knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
      },
    });
    const restored = service.get(job.id);
    assert.equal(restored.knowledge_layout, undefined); assert.deepEqual(restored.documents.map(document => document.path), ["AGENTS.md", "docs/knowledge/rules.md", "guides/nested.md", "docs/knowledge/topic/AGENTS.md"]);
    // 普通换分支不替用户启动目录整理。
    job = service.configureArchive(job.id, { base_revision: 0, targets: [{ ...restored.repositories[0], branch: "release" }] });
    assert.equal(job.knowledge_layout, undefined); assert.equal(job.documents[0].path, "AGENTS.md");
    job = service.configureArchive(job.id, { base_revision: 1, targets: [job.knowledge_target, ...job.repositories], use_module_layout: true });
    assert.equal(job.status, "done"); assert.equal(job.knowledge_layout, "module-v1"); assert.equal(executions, 1);
    assert.deepEqual(job.turns, originalTurns); assert.deepEqual(job.source_repositories, originalSources);
    assert.equal(readFileSync(workFile, "utf8"), workBytes);
    assert.deepEqual(job.documents.map(document => document.id), ["agents", "rules", "extra", "topic"]);
    assert.deepEqual(job.documents.map(document => document.path), ["docs/knowledge/orders/README.md", "docs/knowledge/orders/rules.md", "docs/knowledge/orders/guides/nested.md", "docs/knowledge/orders/topic/index.md"]);
    const [agents, rules, extra] = job.documents;
    assert.match(agents.content, /\[规则\]\(rules\.md\)/);
    assert.match(agents.content, /\[源码\]\(\.\.\/\.\.\/\.\.\/src\/order\.ts#cancel\)/);
    assert.match(agents.content, /\[外部\]\(https:\/\/example\.test\/x\)/);
    assert.ok(agents.content.includes("[复杂](docs/knowledge/a(b(c)).md)"), "不支持的嵌套目的地保持原样，不只改写路径前半截");
    assert.ok(agents.content.includes("`[示例](docs/knowledge/rules.md)`"));
    assert.ok(agents.content.includes("~~~md\n[示例](docs/knowledge/rules.md)\n~~~"));
    assert.match(rules.content, /\[入口\]\(README\.md\)/); assert.match(rules.content, /\[entry\]: README\.md "模块说明"/);
    assert.match(extra.content, /\[入口\]\(\.\.\/README\.md\)/);
    assert.ok(job.documents.every(document => document.revision === 2 && document.history.length === 1 && document.base_content === null && !document.base_path));
    assert.deepEqual(job.documents.map(document => document.knowledge_document_id), identities);
    assert.throws(() => service.previewArchive(job.id), /先发布这次修改/);
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ-new-archive", expected_revisions: {} }, "user"), /先发布这次修改/);
    const retried = await service.retryArchive(job.id, "user", { batch_id: "legacy-batch" });
    assert.equal(retried.status_label, "已归档"); assert.equal(archiveInputs.length, 1);
    assert.equal(archiveInputs[0].knowledge_layout, undefined, "旧批次重试保留旧布局，不继承当前任务的新目录限制");
    assert.equal(archiveInputs[0].documents[0].path, "AGENTS.md");
    assert.equal(archiveInputs[0].repositories[0].docs_path, "docs/knowledge");
    assert.equal(service.get(job.id).archive_batches!.find(batch => batch.id === "legacy-batch")!.state, "done");
    await service.publish(job.id, "user"); job = service.get(job.id);
    assert.equal(executions, 1); assert.equal(job.status, "done"); assert.equal(job.turns.length, originalTurns.length);
    assert.deepEqual(job.documents.map(document => document.knowledge_document_id), identities);
    for (const [index, document] of job.documents.entries()) {
      const formal = readKnowledgeDocument(root, document.knowledge_document_id!);
      assert.equal(formal.scope, "module"); assert.deepEqual(formal.module_ids, ["orders"]);
      assert.equal(formal.archive_target!.path, document.path); assert.notEqual(formal.revision, revisions[index]);
      assert.ok(formal.history.length >= 2, "旧正式版本仍在历史中");
    }
    const preview = service.previewArchive(job.id);
    assert.deepEqual(preview.targets.flatMap(target => target.files).map(file => [file.path, file.content]), job.documents.map(document => [document.path, document.content]));
    assert.ok(job.archive_batches!.some(batch => batch.knowledge_layout === "module-v1"), "新批次冻结模块布局");
    await service.shutdown();
    service = new DomainKnowledgeExtraction(root, async () => { executions++; throw new Error("重启不能重新研究完成任务"); });
    assert.equal(service.get(job.id).knowledge_layout, "module-v1"); assert.equal(service.get(job.id).status, "done"); assert.equal(executions, 1);
    assert.equal(readFileSync(workFile, "utf8"), workBytes);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("旧模块目录整理遇到 README 冲突原子拒绝，显式改名后同步待采纳建议及其基线", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-proposal-"));
  let service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "agents", title: "入口", target_id: "repo-1", path: "AGENTS.md", layer: "repository", content: "# 入口\n[旧说明](docs/knowledge/README.md)", sources: "源码" });
    input.save({ id: "readme", title: "旧说明", target_id: "repo-1", path: "docs/knowledge/README.md", layer: "repository", content: "# 旧说明", sources: "源码" });
    return "done";
  });
  try {
    module(root, "orders");
    let job = await done(service, service.create({ issue_no: "REQ-conflict", title: "旧模块研究", scope: "业务规则", repositories: [source], knowledge_target: knowledgeTarget }, "user").id);
    await service.shutdown();
    const file = join(root, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    stored.module_id = "orders";
    stored.turns[0].proposals.push({ document: { ...stored.documents[0], content: "# 入口修订\n[旧说明](docs/knowledge/README.md)" }, base_revision: 1, status: "pending" });
    writeFileSync(file, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("设置目录不能重新研究"); });
    const before = service.get(job.id);
    assert.throws(() => service.configureArchive(job.id, { base_revision: 0, targets: [before.knowledge_target, ...before.repositories], use_module_layout: true }), /同一个目标文件/);
    assert.deepEqual(service.get(job.id), before);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [before.knowledge_target, ...before.repositories], use_module_layout: true,
      documents: [{ id: "readme", path: "docs/knowledge/orders/legacy.md" }] });
    const proposal = job.turns[0].proposals[0];
    assert.equal(proposal.status, "pending"); assert.equal(proposal.document.path, "docs/knowledge/orders/README.md");
    assert.equal(proposal.base_revision, job.documents[0].revision);
    assert.match(proposal.document.content, /\[旧说明\]\(legacy\.md\)/);
    job = service.decide(job.id, job.turns[0].id, "agents", "accept", "user");
    assert.equal(job.documents[0].content, "# 入口修订\n[旧说明](legacy.md)");
    assert.equal(job.documents[0].id, "agents");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("旧文稿已经位于模块目录时，显式整理仍登记作用范围待发布且不重复增加版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-scope-"));
  let service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "rules", title: "规则", target_id: "repo-1", path: "docs/knowledge/orders/README.md", layer: "repository", content: "# 已完成规则", sources: "源码" });
    return "done";
  });
  try {
    module(root, "orders");
    let job = await done(service, service.create({ issue_no: "REQ-scope", title: "旧研究", scope: "规则", repositories: [{ ...source, docs_path: "docs/knowledge/orders" }],
      knowledge_target: { ...knowledgeTarget, docs_path: "domain-docs/orders" } }, "user").id);
    await service.publish(job.id, "user"); job = service.get(job.id); await service.shutdown();
    const file = join(root, "domain-extraction", job.id, "job.json"), stored = JSON.parse(readFileSync(file, "utf8"));
    stored.module_id = "orders"; writeFileSync(file, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("修改范围不重新研究"); });
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories], use_module_layout: true });
    assert.equal(job.documents[0].path, "docs/knowledge/orders/README.md"); assert.equal(job.documents[0].content, "# 已完成规则");
    assert.equal(job.documents[0].revision, 2); assert.equal(job.documents[0].published_document_revision, 1);
    assert.throws(() => service.previewArchive(job.id), /先发布这次修改/);
    job = service.configureArchive(job.id, { base_revision: 1, targets: [job.knowledge_target, ...job.repositories], use_module_layout: true });
    assert.equal(job.documents[0].revision, 2, "新布局重复保存不重复增加版本");
    await service.publish(job.id, "user");
    const published = service.get(job.id).documents[0];
    assert.deepEqual(readKnowledgeDocument(root, published.knowledge_document_id!).module_ids, ["orders"]);
    assert.equal(service.previewArchive(job.id).targets[0].files[0].path, published.path);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("目录迁移保留已确认删除的历史，旧公共删除只留旧批次，当前模块删除仍可归档", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-deleted-"));
  let executions = 0;
  const execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1] = async input => {
    executions++;
    if (input.turn.mode === "extract") {
      for (const [id, path] of [["root-old", "AGENTS.md"], ["scoped-old", "docs/knowledge/orders/retired.md"], ["current", "docs/knowledge/current.md"]]) {
        input.save({ id, title: id, target_id: "repo-1", path, layer: "repository", content: `# ${id}`, sources: "源码" });
      }
    } else for (const id of input.turn.document_ids) input.remove!(id);
    return "done";
  };
  const archived: DomainKnowledgeJob[] = [];
  const options: ConstructorParameters<typeof DomainKnowledgeExtraction>[2] = { publish: async (job, target) => {
    archived.push(structuredClone(job));
    return { target_id: target.id, state: "opened", branch: "codex/deleted-archive", url: `https://example.test/mr/${archived.length}`,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        deleted: document.deleted, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
  } };
  let service = new DomainKnowledgeExtraction(root, execute, options);
  try {
    module(root, "orders");
    let job = await done(service, service.create({ issue_no: "REQ-deleted", title: "旧研究", scope: "规则", repositories: [source], knowledge_target: knowledgeTarget }, "user").id);
    await service.publish(job.id, "user");
    service.run(job.id, { mode: "revise", document_ids: ["root-old", "scoped-old"], message: "删除已过时知识" }, "user");
    await done(service, job.id); await service.publish(job.id, "user", { document_ids: ["root-old", "scoped-old"] });
    job = service.get(job.id);
    const deleted = structuredClone(job.documents.filter(document => document.deleted));
    assert.equal(deleted.length, 2); assert.ok(deleted.every(document => document.published_document_revision === document.revision));
    await service.shutdown();
    const file = join(root, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    stored.module_id = "orders";
    stored.archive_batches!.push({ id: "legacy-deletions", created_at: new Date().toISOString(), operator: "user", state: "failed", issue_no: "REQ-deleted",
      documents: structuredClone(deleted), targets: [structuredClone(stored.repositories[0])], publications: [] });
    writeFileSync(file, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(root, execute, options);
    job = service.configureArchive(job.id, { base_revision: 0, use_module_layout: true, targets: [job.knowledge_target, ...job.repositories],
      documents: [{ id: "root-old", path: "docs/knowledge/orders/README.md" }, { id: "scoped-old", path: "docs/knowledge/orders/moved.md" }] });
    assert.equal(executions, 2, "目录迁移不重新研究");
    assert.deepEqual(job.documents.filter(document => document.deleted), deleted, "正文、完整历史、版本和路径均保留，忽略 UI 提交的新路径");
    await service.publish(job.id, "user"); job = service.get(job.id);
    assert.deepEqual(service.previewArchive(job.id).targets.flatMap(target => target.files).map(file => file.id), ["current"]);
    assert.equal(service.list().find(record => record.id === job.id)!.production.archive.title, job.production!.archive.title, "列表和详情对遗留删除使用同一范围判断");
    const retried = await service.retryArchive(job.id, "user", { batch_id: "legacy-deletions" });
    assert.equal(retried.status_label, "已归档"); assert.equal(archived[0].knowledge_layout, undefined);
    assert.deepEqual(archived[0].documents.map(document => document.path), deleted.map(document => document.path));
    assert.ok(archived[0].documents.every(document => document.deleted));
    // 新布局正常发布的删除文稿仍属于本模块，不能被历史兼容分支过滤。
    service.run(job.id, { mode: "revise", document_ids: ["current"], message: "删除当前模块知识" }, "user");
    await done(service, job.id); await service.publish(job.id, "user");
    const preview = service.previewArchive(job.id);
    assert.deepEqual(preview.targets.flatMap(target => target.files).map(file => file.id), ["current"]);
    await service.createArchive(job.id, { issue_no: "REQ-current-delete", expected_revisions: preview.expected_revisions }, "user");
    assert.equal(archived.at(-1)!.knowledge_layout, "module-v1");
    assert.equal(archived.at(-1)!.documents[0].deleted, true);
    assert.equal(archived.at(-1)!.documents[0].path, "docs/knowledge/orders/current.md");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("只改变目录布局且正式版本未变时，旧归档批次不能代替新模块导航归档", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-module-same-version-"));
  const archived: DomainKnowledgeJob[] = [];
  const options: ConstructorParameters<typeof DomainKnowledgeExtraction>[2] = { publish: async (job, target) => {
    archived.push(structuredClone(job));
    return { target_id: target.id, state: "opened", branch: `codex/layout-${archived.length}`, url: `https://example.test/mr/${archived.length}`,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
  } };
  let service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "domain", title: "模块说明", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/README.md`, layer: "domain", content: "# 模块说明", sources: "源码" });
    return "done";
  }, options);
  try {
    module(root, "orders");
    let job = await done(service, service.create({ module_id: "orders", issue_no: "REQ-same-version", knowledge_target: knowledgeTarget }, "user").id);
    await service.publish(job.id, "user");
    await service.createArchive(job.id, { issue_no: "REQ-same-version", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    job = service.get(job.id);
    const revision = job.documents[0].published_revision;
    await service.shutdown();
    const file = join(root, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    delete stored.knowledge_layout;
    for (const batch of stored.archive_batches!) delete batch.knowledge_layout;
    writeFileSync(file, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("仅切布局不能重新研究"); }, options);
    job = service.configureArchive(job.id, { base_revision: 0, use_module_layout: true, targets: [job.knowledge_target, ...job.repositories] });
    await service.publish(job.id, "user"); job = service.get(job.id);
    assert.equal(job.documents[0].published_revision, revision, "正文、位置、适用范围均未变，正式版本号可复用");
    assert.ok(job.archive_batches!.some(batch => batch.knowledge_layout === "module-v1" && !batch.issue_no), "发布恢复快照不能复用旧布局批次");
    const preview = service.previewArchive(job.id);
    assert.equal(preview.status_label, "已发布（未归档）");
    assert.notEqual(job.production!.archive.state, "opened", "状态投影也不能把旧布局当作已完成的新导航归档");
    await service.createArchive(job.id, { issue_no: "REQ-module-navigation", expected_revisions: preview.expected_revisions }, "user");
    const batches = service.get(job.id).archive_batches!.filter(batch => batch.issue_no);
    assert.equal(batches.length, 2); assert.equal(batches[0].knowledge_layout, undefined); assert.equal(batches[1].knowledge_layout, "module-v1");
    assert.equal(archived.length, 2); assert.equal(archived.at(-1)!.knowledge_layout, "module-v1");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
