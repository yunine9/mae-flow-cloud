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
    assert.equal(skills.current("domain").digest, original.digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
