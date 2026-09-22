import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";

const source = { repository: "https://example.test/source.git", name: "业务仓", branch: "main" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.get(id); if (job.status === "done") return job; if (job.status === "failed") throw new Error(job.error); await new Promise(r => setTimeout(r, 5)); }
  throw new Error("萃取未完成");
}
test("归档后选位置：Skill 默认值、不提前要求知识仓、路径重映射、旧比较失效与研究范围保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-targets-"));
  const skills = new KnowledgeExtractionSkills(root), skill = skills.current("domain");
  await skills.save("domain", { ...skill.files, "references/archive-defaults.md": '# 默认\n```json\n{"domain_directory":"business/domains","repository_directory":"business/local"}\n```' }, skill.digest, "admin");
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: target.name, target_id: target.id, path: `${target.docs_path}/rules.md`, layer: target.id === "domain" ? "domain" : "repository", content: "# 规则\n人工内容", sources: "源码" });
    else {
      assert.equal(input.job.source_repositories?.[0].repository, source.repository);
      assert.equal(input.job.source_repositories?.[0].branch, "release/current");
      for (const doc of input.read()) input.save({ ...doc, content: "修订建议" });
    }
    return "done";
  }, {
    previewCleanup: async (_job, target) => ({ id: "cleanup", target_id: target.id, directories: [target.docs_path], confirmed: false, target_revision: "abc", target_entries: [], document_versions: [] }),
    readRemote: async () => ({ id: "snapshot", target_content: "旧目录的原文", target_revision: "abc", reviewed: true }),
    publish: async (job, target) => ({ target_id: target.id, state: "opened", url: "https://example.test/mr/1", branch: "codex/knowledge-test", documents: job.documents.filter(d => d.target_id === target.id).map(d => ({ id: d.id, path: d.path, revision: d.revision, content: d.content })) }),
  });
  try {
    const module = createBusinessModule(root, { id: "trade", name: "交易", description: "交易业务", owner: "user", repositories: [source.repository] }, "user");
    const initial = service.create({ module_id: module.id, baseline_branch: "release/current", issue_no: "REQ-1", title: "不能覆盖模块名", repositories: [{ ...source, repository: "https://example.test/unmaintained.git" }] }, "user");
    assert.equal(initial.title, module.name);
    assert.equal(initial.repositories[0].repository, source.repository);
    assert.equal(initial.repositories[0].branch, "release/current");
    assert.match(initial.scope, /完整研究/);
    let job = await done(service, initial.id);
    assert.equal(job.archive_configured, false); assert.equal(job.knowledge_target.repository, "");
    assert.deepEqual(job.documents.map(d => d.path), ["business/domains/rules.md", "business/local/rules.md"]);
    await assert.rejects(service.publish(job.id, "user"), /归档位置/);
    assert.throws(() => service.configureArchive(job.id, { targets: [{ ...job.knowledge_target, docs_path: "../bad" }], base_revision: 0 }), /仓库地址|路径/);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [{ ...job.knowledge_target, repository: "https://example.test/knowledge.git" }, ...job.repositories] });
    await service.readRemote(job.id, "domain", "user");
    await service.previewCleanup(job.id, "domain", {}, "user");
    service.run(job.id, { mode: "revise", document_ids: job.documents.map(d => d.id), message: "补充" }, "user");
    job = await done(service, job.id);
    const sources = structuredClone(job.source_repositories);
    const targets = [{ ...job.knowledge_target, docs_path: "new/domain" }, { ...job.repositories[0], repository: "https://example.test/archive.git", branch: "docs", docs_path: "new/repo" }];
    const before = service.get(job.id);
    assert.throws(() => service.configureArchive(job.id, { targets, base_revision: 0 }), /已被修改/);
    assert.throws(() => service.configureArchive(job.id, { targets: targets.map(t => ({ ...t, repository: "https://example.test/collision.git", branch: "main", docs_path: "same" })), base_revision: 1 }), /同一个目标文件/);
    assert.deepEqual(service.get(job.id), before, "failed configuration is atomic");
    job = service.configureArchive(job.id, { targets, base_revision: 1 });
    assert.deepEqual(job.source_repositories, sources);
    assert.equal(job.cleanup_plans?.length, 0); assert.equal(job.documents[0].remote_review, undefined); assert.equal(job.documents[0].base_revision, "");
    assert.deepEqual(job.documents.map(d => d.path), ["new/domain/rules.md", "new/repo/rules.md"]);
    assert.deepEqual(job.turns.at(-1)!.proposals.map(p => p.document.path), job.documents.map(d => d.path));
    assert.ok(job.documents.every(d => d.content.includes("人工内容")));
    job = await service.publish(job.id, "user");
    assert.equal(job.publications[1].documents[0].path, "new/repo/rules.md");
    assert.throws(() => service.configureArchive(job.id, { targets: [{ ...targets[0], docs_path: "other" }], base_revision: 2 }), /已发起归档/);
    service.run(job.id, { mode: "update", document_ids: job.documents.map(d => d.id), message: "核对新版本" }, "user");
    await done(service, job.id);
    const restored = new DomainKnowledgeExtraction(root, async () => "unused");
    assert.deepEqual(restored.get(job.id).source_repositories, sources); await restored.shutdown();
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
