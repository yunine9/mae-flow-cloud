import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskKnowledgeChoices,
  normalizeLaunchKnowledgeCatalog,
  paginateTaskKnowledgeChoices,
  TASK_KNOWLEDGE_PAGE_SIZE,
  type LaunchEngineeringKnowledge,
} from "../web/src/launchKnowledgeModel.ts";

test("发起页知识目录容忍旧字段与坏记录，不让单项数据拖垮整页", () => {
  const catalog = normalizeLaunchKnowledgeCatalog({
    engineering_knowledge: [
      { id: "guide", title: "构建指南", form: "unknown" },
      { id: "guide", title: "重复记录" },
      { title: "没有 ID" },
      null,
    ],
    team_skills: [
      { path: "review/SKILL.md", name: "review" },
      { path: "review/SKILL.md", name: "重复 Skill" },
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
    technologies: [],
  }]);
  assert.deepEqual(catalog.skills, [{
    path: "review/SKILL.md",
    name: "review",
    description: "",
    business_module_ids: [],
    repositories: [],
    technologies: [],
  }]);
});

test("大目录始终按固定页渲染，搜索仍覆盖全部知识", () => {
  const engineering: LaunchEngineeringKnowledge[] = Array.from(
    { length: 5_000 }, (_, index) => ({
      id: `knowledge-${index}`,
      title: index === 4_321 ? "唯一流水线排障手册" : `知识 ${index}`,
      summary: "团队工程知识",
      when_to_use: "需要时",
      form: "document",
      business_module_ids: [],
      repositories: [],
      technologies: ["cpp"],
    }));
  const choices = buildTaskKnowledgeChoices(engineering, [], "");
  const first = paginateTaskKnowledgeChoices(choices, 0);
  const last = paginateTaskKnowledgeChoices(choices, Number.MAX_SAFE_INTEGER);

  assert.equal(choices.length, 5_000);
  assert.equal(first.items.length, TASK_KNOWLEDGE_PAGE_SIZE);
  assert.equal(first.page, 0);
  assert.equal(last.page, last.pages - 1);
  assert.ok(last.items.length <= TASK_KNOWLEDGE_PAGE_SIZE);

  const searched = buildTaskKnowledgeChoices(engineering, [], "流水线排障");
  assert.deepEqual(searched.map((item) => item.key),
    ["engineering:knowledge-4321"]);
});
