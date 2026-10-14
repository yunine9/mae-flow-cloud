import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch, type ResearchExecution } from "../src/componentResearch.ts";
import { KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";
import { domainSkillFixture, pinDomainSkillFixture } from "./helpers/extractionSkillFixture.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import { readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";
import { componentGuideSection } from "./fixtures/componentGuide.ts";
import { domainKnowledgeRoute } from "../src/domainKnowledgeRoutes.ts";
import { componentResearchRoute } from "../src/componentResearchRoutes.ts";

const config = { issue_no: "REQ-REEXTRACT", issue_description: "重新核对订单状态", title: "订单", scope: "状态与取消规则", instructions: "保留接口和 UT 示例",
  repositories: [{ name: "交易仓", repository: "https://example.test/orders.git", branch: "release/1", path: "src", docs_path: "docs/business" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
const document = { id: "states", title: "订单状态", target_id: "domain", path: "domains/orders/states.md", layer: "domain" as const,
  content: "# 订单\n原始规则", sources: "repo-1 / src/state.ts @ 123" };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("任务未完成"); }
const waitForStop = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
function domainMethod(input: DomainExecution, dir: string) {
  const skill = new KnowledgeExtractionSkills(dir).pin("domain", join(input.root, "skill.json"));
  input.update({ skill: { name: skill.name, digest: skill.digest } }); return skill.digest;
}

test("领域重新萃取复用单号、上传资料、源码和归档配置，读取最新 Skill，保留正式知识；重复请求及重启不多建任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-domain-reextract-"));
  const material = await businessMaterial(dir), skills = new KnowledgeExtractionSkills(dir);
  let methodFiles = skills.current("domain").files;
  let latestDigest = "", replacementRun: DomainExecution | undefined;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    pinDomainSkillFixture(input.root, methodFiles);
    const digest = domainMethod(input, dir);
    if (input.job.reextract_of) { latestDigest = digest; replacementRun = input; await waitForStop(input.signal); }
    else input.save(document, { content: null, revision: "a".repeat(40) });
    return "完成";
  });
  try {
    const original = service.create({ ...config, material_ids: [material.id] }, "alice");
    await until(() => service.get(original.id).status === "done");
    const published = await service.publish(original.id, "alice"), formal = readKnowledgeDocument(dir, published.documents[0].knowledge_document_id!);
    const current = skills.current("domain");
    // 模拟平台发布新的方法，只为新测试任务固定新包，已有任务不变。
    methodFiles = { ...current.files, "SKILL.md": current.files["SKILL.md"] + "\n重新萃取验收：检查最新方法。\n" };
    const latest = domainSkillFixture(methodFiles);
    const next = service.reextract(original.id, "bob");
    assert.notEqual(next.id, original.id); assert.equal(next.reextract_of, original.id); assert.equal(next.operator, "bob");
    for (const key of ["title", "scope", "instructions", "issue_no", "issue_description", "module_id", "material_ids", "repositories", "source_repositories", "knowledge_target"] as const) assert.deepEqual(next[key], published[key], key);
    assert.deepEqual(next.documents, []); assert.deepEqual(next.revisions, {}); assert.deepEqual(next.evidence, []); assert.deepEqual(next.publications, []);
    assert.equal(next.turns.length, 1); assert.notEqual(next.turns[0].id, original.turns[0].id); assert.equal(next.skill, undefined);
    assert.throws(() => service.get(original.id), /已删除/); assert.equal(service.reextract(original.id, "bob").id, next.id);
    await until(() => !!replacementRun); assert.equal(latestDigest, latest.digest); assert.notEqual(latestDigest, current.digest);
    assert.equal(replacementRun!.turn.research, undefined); assert.equal(replacementRun!.job.documents.length, 0);
    assert.deepEqual(readKnowledgeDocument(dir, formal.id), formal);
    await service.shutdown();
    const restarted = new DomainKnowledgeExtraction(dir, async () => "不应执行");
    try { assert.equal(restarted.reextract(original.id, "bob").id, next.id); assert.equal(restarted.list().length, 1); }
    finally { await restarted.shutdown(); }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域重新萃取保留原业务模块及分支，无归档仓也可直接重建；运行中的旧任务停止且迟到文稿不能写回", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-running-reextract-"));
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "alice", description: "状态规则", repositories: ["https://example.test/orders.git"] }, "alice");
  let first: DomainExecution | undefined, second: DomainExecution | undefined;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (!first) { first = input; input.save({ ...document, path: `${input.job.knowledge_target.docs_path}/states.md` }); }
    else second = input;
    await waitForStop(input.signal);
    assert.throws(() => input.save({ ...document, path: "domain/orders/late.md", content: "迟到结果" }), /停止/);
    return "已停止";
  });
  try {
    const original = service.create({ ...config, module_id: "orders", baseline_branch: "release/1", knowledge_target: undefined }, "alice");
    await until(() => !!first);
    const before = service.get(original.id), next = service.reextract(original.id, "alice");
    assert.equal(first!.signal.aborted, true);
    assert.equal(next.module_id, "orders"); assert.deepEqual(next.source_repositories, before.source_repositories);
    assert.equal(next.source_repositories![0].branch, "release/1"); assert.equal(next.knowledge_target.repository, "");
    await until(() => !!second); assert.deepEqual(service.get(next.id).documents, []);
    assert.ok(JSON.parse(readFileSync(join(dir, "domain-extraction", original.id, "job.json"), "utf8")).deleted_at);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("资料丢失导致重新创建失败时，领域原任务和原稿保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-reextract-failure-"));
  const material = await businessMaterial(dir);
  const service = new DomainKnowledgeExtraction(dir, async input => { input.save(document); return "完成"; });
  try {
    const original = service.create({ ...config, material_ids: [material.id] }, "alice");
    await until(() => service.get(original.id).status === "done");
    rmSync(join(dir, "knowledge-materials", material.id), { recursive: true, force: true });
    assert.throws(() => service.reextract(original.id, "alice"), /资料不存在/);
    assert.equal(service.list().length, 1); assert.equal(service.get(original.id).documents[0].content, document.content);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("组件重新萃取独立创建任务，保留原技术栈和来源范围，重新固定两套最新 Skill；停止原任务且重启后请求不重复", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-reextract-"));
  createTechnologyStack(dir, { name: "C++" }, "alice");
  const source = saveComponentRepository(dir, { name: "文件操作参考仓", repository: "https://example.test/files.git", branch: "release/1", path: "src", languages: ["cpp"], enabled: true }, "alice");
  const skills = new KnowledgeExtractionSkills(dir), previous = { component: skills.current("component"), "component-analysis": skills.current("component-analysis") };
  let latest = false, first: ResearchExecution | undefined, second: ResearchExecution | undefined;
  const current = KnowledgeExtractionSkills.prototype.current;
  t.mock.method(KnowledgeExtractionSkills.prototype, "current", function(this: KnowledgeExtractionSkills, kind: Parameters<typeof current>[0]) {
    const original = current.call(this, kind);
    if (!latest || kind === "domain") return original;
    const files = { ...original.files, "SKILL.md": original.files["SKILL.md"] + "\n本次更新的方法。\n" };
    return { ...original, files, digest: createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
  });
  const service = new ComponentResearch(dir, async input => {
    const store = new KnowledgeExtractionSkills(dir), method = store.pin("component", join(input.root, "component-pipeline-skill.json")), analysis = store.pin("component-analysis", join(input.root, "component-analysis-skill.json"));
    input.update({ skill: { name: method.name, digest: method.digest }, analysis_skill: { name: analysis.name, digest: analysis.digest } });
    if (!first) { first = input; input.update({ draft: "旧稿", revisions: { [source.id]: "a".repeat(40) }, document: { overview: "旧概述", sections: [{ ...componentGuideSection("file", [source.id]), selected: true, revision: 1 }] } }); }
    else second = input;
    await waitForStop(input.signal); input.update({ draft: "迟到稿" }); return "完成";
  });
  try {
    const original = service.start({ language: "cpp", repository_ids: [source.id] }, "alice");
    await until(() => !!first); latest = true;
    saveComponentRepository(dir, { ...source, branch: "main" }, "alice");
    const next = service.reextract(original.id, "bob");
    assert.notEqual(next.id, original.id); assert.equal(next.reextract_of, original.id); assert.equal(next.operator, "bob");
    assert.equal(first!.signal.aborted, true); assert.equal(service.get(original.id).deleted_by, "bob");
    assert.deepEqual(next.source_repositories, [source]); assert.equal(next.language, "cpp"); assert.equal(next.document?.sections.length, 0);
    assert.equal(next.pipeline, undefined); assert.equal(next.revisions, undefined); assert.equal(next.document_id, undefined); assert.equal(next.skill, undefined);
    assert.equal(service.reextract(original.id, "bob").id, next.id);
    await until(() => !!second);
    const fresh = service.get(next.id); assert.notEqual(fresh.skill?.digest, previous.component.digest); assert.notEqual(fresh.analysis_skill?.digest, previous["component-analysis"].digest);
    await service.shutdown();
    const restarted = new ComponentResearch(dir, async () => "不应执行");
    try { assert.equal(restarted.reextract(original.id, "bob").id, next.id); assert.equal(restarted.list().length, 1); assert.equal(restarted.get(original.id).draft, "旧稿"); }
    finally { await restarted.shutdown(); }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("参考仓停用导致组件重新创建失败时保留原任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-reextract-failure-"));
  createTechnologyStack(dir, { name: "C++" }, "alice");
  const source = saveComponentRepository(dir, { name: "源码", repository: "https://example.test/files.git", branch: "main", path: "", languages: ["cpp"], enabled: true }, "alice");
  const service = new ComponentResearch(dir, async input => { await waitForStop(input.signal); return "停止"; });
  try {
    const original = service.start({ language: "cpp" }, "alice");
    saveComponentRepository(dir, { ...source, enabled: false }, "alice");
    assert.throws(() => service.reextract(original.id, "alice"), /请先.*启用/);
    assert.equal(service.get(original.id).deleted_at, undefined); assert.equal(service.list().length, 1);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("重新萃取端点返回 202 和新任务，创建输入由原任务读取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-reextract-routes-"));
  createTechnologyStack(dir, { name: "C++" }, "alice");
  saveComponentRepository(dir, { name: "源码", repository: "https://example.test/files.git", branch: "main", path: "", languages: ["cpp"], enabled: true }, "alice");
  const domain = new DomainKnowledgeExtraction(dir, async input => { await waitForStop(input.signal); return "停止"; });
  const component = new ComponentResearch(dir, async input => { await waitForStop(input.signal); return "停止"; });
  try {
    const originalDomain = domain.create(config, "alice"), originalComponent = component.start({ language: "cpp" }, "alice");
    const service = { options: { dataDir: dir }, getDomainKnowledgeExtraction: () => domain, getComponentResearch: () => component };
    for (const [route, endpoint, original] of [[domainKnowledgeRoute, "domain-extraction", originalDomain], [componentResearchRoute, "component-research", originalComponent]] as const) {
      let result: { status: number; value: any } | undefined;
      await route({ method: "POST" } as any, {} as any, [endpoint, original.id, "reextract"], service as any, "bob",
        async () => ({ issue_no: "REQ-UNRELATED", language: "unknown", material_ids: ["missing"] }),
        (_response, status, value) => { result = { status, value }; });
      assert.equal(result?.status, 202); assert.notEqual(result!.value.id, original.id); assert.equal(result!.value.reextract_of, original.id);
      if (endpoint === "domain-extraction") assert.equal(result!.value.issue_no, config.issue_no);
      else assert.equal(result!.value.language, "cpp");
    }
  } finally { await domain.shutdown(); await component.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
