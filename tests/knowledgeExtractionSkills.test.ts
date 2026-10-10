import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeExtractionSkills, extractionSkillTool, extractionSkillMission } from "../src/knowledgeExtractionSkills.ts";

test("组件两套方法仅随仓库发布，忽略旧上传且研究固定版本不受新发布影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "component-method-pair-"));
  try {
    const store = new KnowledgeExtractionSkills(root), original = store.current("component-analysis");
    const extraction = store.current("component"), path = join(root, "task", "analysis.json");
    assert.equal(original.name, "component-module-analysis");
    const pinned = store.pin("component-analysis", path);
    for (const kind of ["component", "component-analysis"] as const) {
      const method = store.current(kind), directory = join(store.root, method.name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "current.json"), "旧上传的无效包");
      assert.equal(store.current(kind).digest, method.digest);
      await assert.rejects(store.save(kind, method.files, method.digest, "expert"), /平台版本维护.*查看/);
      await assert.rejects(store.rollback(kind, "invalid", method.digest, "expert"), /平台版本维护.*查看/);
    }
    // 模拟仓库发布的新版本，而不是开放生产上传接口。
    const files = { ...original.files, "references/phase-plan.md": original.files["references/phase-plan.md"] + "\n核对场景对应的单元测试。\n" };
    const next = { ...original, files, digest: createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
    const current = store.current.bind(store);
    store.current = kind => kind === "component-analysis" ? next : current(kind);
    assert.notEqual(next.digest, original.digest);
    assert.equal(store.current("component").digest, extraction.digest);
    assert.deepEqual(store.pin("component-analysis", path), pinned);
    assert.equal(store.pin("component-analysis", join(root, "task", "new-analysis.json")).digest, next.digest);
    assert.throws(() => store.pin("component", path), /校验/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("领域 Skill 更新和回退，已固定的完整包不受线上修改影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "extraction-skills-"));
  try {
    const skills = new KnowledgeExtractionSkills(root), original = skills.current("domain"), component = skills.current("component");
    const path = join(root, "round", "skill.json"), pinned = skills.pin("domain", path);
    const files = { ...original.files, "references/domain.md": original.files["references/domain.md"] + "\n新增研究方法\n" };
    const next = await skills.save("domain", files, original.digest, "expert");
    assert.notEqual(next.digest, original.digest);
    assert.equal(skills.current("component").digest, component.digest);
    assert.deepEqual(skills.pin("domain", path), pinned);
    assert.equal(skills.pin("domain", path, true).digest, next.digest);
    assert.equal(JSON.parse(readFileSync(join(root, "round", "skill-packages", `${pinned.digest}.json`), "utf8")).files["references/domain.md"], original.files["references/domain.md"]);
    await assert.rejects(skills.save("domain", files, original.digest, "other"), /已被更新/);
    const tool: any = extractionSkillTool(pinned);
    assert.equal((await tool.execute("read", { path: "references/domain.md" })).content[0].text, original.files["references/domain.md"]);
    assert.equal((await tool.execute("read", { path: "../../outside" })).isError, true);
    const restored = await skills.rollback("domain", next.versions[0].version_id, next.digest, "expert");
    assert.equal(restored.digest, original.digest);
    assert.match(extractionSkillMission(pinned, { mode: "revise" }), /"mode":"revise"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("无效或越界的 Skill 更新不替换当前包", async () => {
  const root = mkdtempSync(join(tmpdir(), "extraction-skills-"));
  try {
    const skills = new KnowledgeExtractionSkills(root), original = skills.current("domain");
    await assert.rejects(skills.save("domain", { ...original.files, "../outside.md": "bad" }, original.digest, "expert"), /路径/);
    await assert.rejects(skills.save("domain", { ...original.files, "SKILL.md": "no frontmatter" }, original.digest, "expert"), /有效/);
    await assert.rejects(skills.save("domain", { ...original.files, "references/archive-defaults.md": '```json\n{"domain_directory":"../outside","repository_directory":"docs"}\n```' }, original.digest, "expert"), /归档默认位置/);
    assert.equal(skills.current("domain").digest, original.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("萃取方法允许头名说明，拒绝夹带口令且保留已发布版本", async () => {
  const root=mkdtempSync(join(tmpdir(),"extraction-secret-"));
  try {
    const skills=new KnowledgeExtractionSkills(root),original=skills.current("domain");
    const files={...original.files,"references/headers.md":'X_ACCESS_TOKEN = "X-Access-Token"'};
    const accepted=await skills.save("domain",files,original.digest,"expert");
    await assert.rejects(skills.save("domain",{...files,"references/config.md":'password = "correct-horse-battery-staple"'},accepted.digest,"expert"),/疑似密钥/);
    assert.equal(skills.current("domain").digest,accepted.digest);
    assert.deepEqual(skills.current("domain").files,files);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("标准 Skill 可按平台用途上传，保留原名、引用与文本附件，运行中的版本不变", async () => {
  const root = mkdtempSync(join(tmpdir(), "platform-skill-"));
  try {
    const store = new KnowledgeExtractionSkills(root), initial = store.current("domain");
    const pinnedPath = join(root, "existing-job", "skill.json");
    const pinned = store.pin("domain", pinnedPath);
    const files = {
      "SKILL.md": "---\nname: business-research\ndescription: 从业务资料研究知识\n---\n读[方法](references/guide.md)及[公开说明](https://example.test/guide.md)。",
      "references/guide.md": "先核对业务规则，再用源码确认实现。",
      "assets/example.json": '{"topic":"退款边界"}',
      "scripts/example.py": 'print("example")\n',
    };
    const saved = await store.save("domain", files, initial.digest, "admin");
    assert.equal(saved.name, "business-research");
    assert.equal(saved.kind, "domain");
    assert.deepEqual(saved.files, files);
    assert.equal(store.current("component").name, "component-knowledge-extraction");
    assert.deepEqual(store.pin("domain", pinnedPath), pinned);
    assert.equal(store.pin("domain", join(root, "new-job", "skill.json")).name, "business-research");
    assert.equal(store.pin("domain", pinnedPath, true).digest, saved.digest);
    assert.throws(() => store.pin("component", pinnedPath), /校验失败/);
    const tool: any = extractionSkillTool(store.pin("domain", pinnedPath));
    assert.equal((await tool.execute("read", { path: "assets/example.json" })).content[0].text, files["assets/example.json"]);
    await assert.rejects(store.save("domain", { ...files, "assets/binary": "\0" }, saved.digest, "admin"), /文本 Skill/);
    await assert.rejects(store.save("domain", { ...files, "..\\outside.py": "bad" }, saved.digest, "admin"), /路径不能越界/);
    assert.equal(store.current("domain").digest, saved.digest);
    const restored = await store.rollback("domain", saved.versions[0].version_id, saved.digest, "admin");
    assert.equal(restored.name, initial.name);
    assert.equal(restored.digest, initial.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#448 引用缺失只提示不拦截：包外示例链接与包内写错的路径都照常保存，并逐条说明", async () => {
  const root = mkdtempSync(join(tmpdir(), "extraction-skills-"));
  try {
    const skills = new KnowledgeExtractionSkills(root), original = skills.current("domain");
    const files = { ...original.files,
      "SKILL.md": original.files["SKILL.md"] + "\n\n模块文档链回总览：[架构](../architecture.md)\n",
      "references/workflow.md": original.files["references/workflow.md"] + "\n另见 [遗漏](missing.md)。\n" };
    const saved = await skills.save("domain", files, original.digest, "expert");
    assert.notEqual(saved.digest, original.digest, "保存必须生效");
    assert.equal(saved.warnings.length, 2);
    assert.match(saved.warnings[0], /SKILL\.md 引用了包外文件 \.\.\/architecture\.md：不会随 Skill 上传/);
    assert.match(saved.warnings[1], /references\/workflow\.md 引用的 missing\.md 不在包内/);
    // 包内真实存在的相对引用不提示。
    assert.ok(!saved.warnings.some(item => item.includes("platform-pipeline.md")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
