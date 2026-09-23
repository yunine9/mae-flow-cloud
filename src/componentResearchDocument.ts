import { scanForSecrets } from "./hostSkillLibrary.ts";

/** 一项是可独立理解、使用和审查的能力，可能由多个仓共同提供。 */
export interface ResearchSection {
  id: string;
  title: string;
  repository_ids: string[];
  selected: boolean;
  content: string;
  interfaces: string;
  integration: string;
  example: string;
  sources: string;
  related_ids: string[];
  revision: number;
}
export interface ResearchDocument {
  overview: string;
  sections: ResearchSection[];
}
export interface ResearchReviewTurn {
  id: string;
  section_id: string;
  mode: "discuss" | "rework" | "update";
  previous_revisions?: Record<string, string>;
  base_revision?: number;
  skill?: { name: string; digest: string };
  message: string;
  operator: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  proposal?: { base_revision: number; section: ResearchSection; status: "pending" | "accepted" | "discarded" };
  reply?: string;
  error?: string;
  created_at: string;
  finished_at?: string;
}
export interface ResearchDocumentEdit {
  action: "outline" | "overview" | "section";
  overview?: string;
  entries?: Array<{ id: string; title: string; repository_ids: string[] }>;
  section?: Omit<ResearchSection, "selected" | "revision">;
}
export function sectionReady(section: ResearchSection): boolean {
  return [section.content, section.interfaces, section.integration, section.sources].every(value => typeof value === "string" && !!value.trim())
    && /```[^\n]*\n[\s\S]*?\S[\s\S]*?\n```/.test(section.example ?? "");
}
export function editResearchDocument(document: ResearchDocument, edit: ResearchDocumentEdit,
  repositoryIds: string[], review?: ResearchReviewTurn): ResearchDocument {
  if (review && (review.mode === "discuss" || edit.action !== "section" || edit.section?.id !== review.section_id)) {
    throw new Error("本轮只能修改指定组件；讨论不会修改草稿，其他组件保持原样");
  }
  scanForSecrets("组件知识草稿", Buffer.from(JSON.stringify(edit)));
  const next = structuredClone(document);
  const check = (entry: { id: string; title: string; repository_ids: string[] }) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(entry.id) || !entry.title?.trim()) throw new Error("组件须有稳定编号和名称");
    if (!entry.repository_ids?.length || entry.repository_ids.some(id => !repositoryIds.includes(id))) {
      throw new Error("组件来源必须对应本次研究范围内的仓库");
    }
  };
  if (edit.action === "overview") {
    if (!edit.overview?.trim()) throw new Error("请说明跨仓依赖、分层与组合使用关系");
    next.overview = edit.overview;
  } else if (edit.action === "outline") {
    if (!edit.entries?.length) throw new Error("请提交发现的组件能力清单");
    for (const entry of edit.entries) {
      check(entry);
      const existing = next.sections.find(section => section.id === entry.id);
      if (existing) {
        if (existing.title !== entry.title || JSON.stringify(existing.repository_ids) !== JSON.stringify(entry.repository_ids)) {
          throw new Error(`编号 ${entry.id} 已有定义；保留原项，需要细分时添加新编号`);
        }
        continue;
      }
      next.sections.push({ ...entry, selected: true, content: "", interfaces: "", integration: "", example: "", sources: "", related_ids: [], revision: 0 });
    }
  } else if (edit.action === "section" && edit.section) {
    const section = edit.section;
    check(section);
    const index = next.sections.findIndex(item => item.id === section.id);
    if (index < 0) throw new Error("请先将组件加入能力清单，再写正文");
    if (!sectionReady({ ...section, selected: true, revision: 1 })) {
      throw new Error("每个组件都必须写用法、公共接口、集成产物/依赖、来源和含代码块的最佳示例；未验证的示例须如实标注");
    }
    if (!Array.isArray(section.related_ids) || section.related_ids.some(id => id === section.id || !next.sections.some(item => item.id === id))) {
      throw new Error("关联组件须使用清单中其他组件的编号");
    }
    next.sections[index] = { ...section, selected: next.sections[index].selected, revision: next.sections[index].revision + 1 };
  } else throw new Error("未知文档操作");
  return next;
}

export function researchDocumentMarkdown(title: string, document: ResearchDocument, selectedOnly = false): string {
  const sections = document.sections.filter(section => !selectedOnly || section.selected);
  return [`# ${title}`, document.overview,
    "## 组件目录", ...sections.map(section => `- [${section.title}](#component-${section.id})`),
    ...sections.map(section => [
      `<a id="component-${section.id}"></a>`, `## ${section.title}`,
      ...(sectionReady(section) ? [section.content, "### 公共接口", section.interfaces,
        "### 集成产物与依赖", section.integration, "### 最佳示例", section.example, "### 来源", section.sources]
        : ["> 本组件尚未完成研究，不能作为已确认的使用指南。"]),
      ...(section.related_ids.length ? ["### 关联组件", ...section.related_ids.map(id => {
        const related = document.sections.find(item => item.id === id);
        return sections.some(item => item.id === id) ? `- [${related?.title ?? id}](#component-${id})`
          : `- ${related?.title ?? id}（未纳入本次文档，使用时仍需核对该依赖）`;
      })] : []),
    ].join("\n\n")),
  ].filter(Boolean).join("\n\n");
}
