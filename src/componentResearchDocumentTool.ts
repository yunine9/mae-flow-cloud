import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResearchExecution } from "./componentResearch.ts";
import { sectionReady } from "./componentResearchDocument.ts";
import { bundledExtractionSkill, extractionSkillMission, type ExtractionSkillSnapshot } from "./knowledgeExtractionSkills.ts";

export function researchDocumentTool(input: ResearchExecution) {
  const entry = { id: Type.String(), title: Type.String(), repository_ids: Type.Array(Type.String()) };
  return defineTool({
    name: "research_document", label: "组件知识文档",
    description: "读取与分段保存本次联合文档。read 不带 id 返回目录，带 id 返回完整章节。outline 登记条目，overview 更新概述，section 保存章节。讨论只读；修订仅限本轮指定章节，返回建议后由用户采纳。内容方法见当前组件 Skill。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("outline"), Type.Literal("overview"), Type.Literal("section")]),
      id: Type.Optional(Type.String()), overview: Type.Optional(Type.String()),
      entries: Type.Optional(Type.Array(Type.Object(entry))),
      section: Type.Optional(Type.Object({ ...entry, content: Type.String(), interfaces: Type.String(), integration: Type.String(), example: Type.String(), sources: Type.String(), related_ids: Type.Array(Type.String()) })),
    }),
    async execute(_id: string, edit: any) {
      try {
        const document = edit.action === "read" ? input.readDocument!() : input.editDocument!(edit);
        const selected = edit.id ? document.sections.find(section => section.id === edit.id) : undefined;
        if (edit.id && !selected) throw new Error("未找到指定组件");
        return { content: [{ type: "text" as const, text: JSON.stringify(selected ?? {
          overview: document.overview, sections: document.sections.map(({ id, title, repository_ids, revision, ...rest }) =>
            ({ id, title, repository_ids, revision, ready: sectionReady({ id, title, repository_ids, revision, ...rest }) })),
        }) }], details: {} };
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "文档操作失败" }], details: {}, isError: true };
      }
    },
  });
}

export function jointResearchMission(input: ResearchExecution, skill: ExtractionSkillSnapshot = bundledExtractionSkill("component")): string {
  return extractionSkillMission(skill, {
    mode: input.review?.mode === "update" ? "update" : input.review?.mode === "discuss" ? "discuss" : input.review ? "revise" : "extract",
    language: input.record.language, scope: "联合文档", components: input.record.components ?? [input.record.component],
    topic: input.record.topic, document: input.record.document, review: input.review,
    history: input.record.review_turns?.filter(turn => turn.section_id === input.review?.section_id),
    output: "通过 research_document 分段保存联合文档；讨论不能写入，修订只允许本轮指定章节，生成的修订等待人工采纳。最终回复说明结果。",
  });
}
