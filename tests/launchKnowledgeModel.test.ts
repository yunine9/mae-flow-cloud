import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLaunchKnowledgeCatalog } from
  "../web/src/launchKnowledgeModel.ts";

test("发起页知识目录容忍旧字段与坏记录，不让单项数据拖垮整页", () => {
  const catalog = normalizeLaunchKnowledgeCatalog({
    engineering_knowledge: [
      { id: "guide", title: "构建指南", form: "unknown",
        technologies: ["java"] },
      { id: "guide", title: "重复记录" },
      { id: "missing-language", title: "缺语言" },
      { title: "没有 ID" },
      null,
    ],
    team_skills: [
      { path: "review/SKILL.md", name: "review", nature: "engineering",
        technologies: ["java"] },
      { path: "review/SKILL.md", name: "重复 Skill" },
      { path: "legacy/SKILL.md", name: "未治理历史 Skill" },
      { path: "business/SKILL.md", name: "缺业务模块",
        nature: "business" },
      { name: "没有路径" },
    ],
  });

  assert.deepEqual(catalog.engineering, [{
    id: "guide",
    title: "构建指南",
    summary: "",
    when_to_use: "",
    form: "document",
    business_module_ids: [],
    repositories: [],
    technologies: ["java"],
  }]);
  assert.deepEqual(catalog.skills, [{
    path: "review/SKILL.md",
    name: "review",
    description: "",
    nature: "engineering",
    business_module_ids: [],
    repositories: [],
    technologies: ["java"],
  }]);
});
