import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeExtractionSkills, extractionSkillTool, extractionSkillMission } from "../src/knowledgeExtractionSkills.ts";

test("两个 Skill 独立更新和回退，已固定的完整包不受线上修改影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "extraction-skills-"));
  try {
    const skills = new KnowledgeExtractionSkills(root), original = skills.current("component"), domain = skills.current("domain");
    const path = join(root, "round", "skill.json"), pinned = skills.pin("component", path);
    const files = { ...original.files, "references/component.md": original.files["references/component.md"] + "\n新增研究方法\n" };
    const next = await skills.save("component", files, original.digest, "expert");
    assert.notEqual(next.digest, original.digest);
    assert.equal(skills.current("domain").digest, domain.digest);
    assert.deepEqual(skills.pin("component", path), pinned);
    assert.equal(skills.pin("component", path, true).digest, next.digest);
    assert.equal(JSON.parse(readFileSync(join(root, "round", "skill-packages", `${pinned.digest}.json`), "utf8")).files["references/component.md"], original.files["references/component.md"]);
    await assert.rejects(skills.save("component", files, original.digest, "other"), /已被更新/);
    const tool: any = extractionSkillTool(pinned);
    assert.equal((await tool.execute("read", { path: "references/component.md" })).content[0].text, original.files["references/component.md"]);
    assert.equal((await tool.execute("read", { path: "../../outside" })).isError, true);
    const restored = await skills.rollback("component", next.versions[0].version_id, next.digest, "expert");
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
