import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DomainKnowledgeJob } from "./domainKnowledgeTypes.ts";
import type { ResearchRecord } from "./componentResearch.ts";
import type { ExtractionJobRecord } from "./knowledgeExtraction.ts";
import { listSkillSubmissions, type SkillSubmissionRecord } from "./hostSkillLibrary.ts";
import type { KnowledgeTaskCenterData, KnowledgeTaskRow } from "./knowledgeTaskCenterTypes.ts";
import { knowledgeArchiveState } from "./knowledgeArchiveStatus.ts";

function validTime(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** 与研究详情一样按追加顺序取最新公开文字，不把工具输出当成思考。 */
export function latestKnowledgeResearchNote(evidence: Array<Record<string, unknown>>): KnowledgeTaskRow["latest_note"] {
  for (let index = evidence.length - 1; index >= 0; index--) {
    const item = evidence[index];
    if (item.tool !== "research_note" || typeof item.preview !== "string") continue;
    const text = item.preview.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (text) return { text, at: validTime(item.at) };
  }
  return undefined;
}

function state(status: string): Pick<KnowledgeTaskRow, "status_label" | "group"> {
  if (status === "queued") return { status_label: "排队中", group: "running" };
  if (status === "running") return { status_label: "进行中", group: "running" };
  if (status === "failed") return { status_label: "执行失败", group: "attention" };
  if (status === "cancelled") return { status_label: "已停止", group: "attention" };
  if (status === "idle") return { status_label: "待开始", group: "attention" };
  return { status_label: "已完成", group: "completed" };
}

export function domainKnowledgeTask(job: DomainKnowledgeJob): KnowledgeTaskRow {
  const row: KnowledgeTaskRow = {
    id: job.id, kind: "domain", title: job.title, scope: job.probe ? `效果验证 · ${job.probe.module}` : job.scope,
    operator: job.operator, created_at: validTime(job.created_at), status: job.status, ...state(job.status),
    stage: job.stage, error: job.error, latest_note: latestKnowledgeResearchNote(job.evidence),
  };
  if (job.status === "running") row.status_label = ["revise", "update"].includes(job.turns.at(-1)?.mode ?? "") ? "修改中" : "研究中";
  if (job.status !== "done" || job.probe) return row;
  const pendingProposal = job.turns.some(turn => turn.proposals.some(proposal => proposal.status === "pending"));
  const unpublished = job.documents.some(document => {
    if (document.published_document_revision !== undefined) return document.published_document_revision !== document.revision;
    // 老记录没有本地发布版本，只能以已成功归档的同版文稿确认发布。
    return !document.knowledge_document_id || ![...job.publications, ...(job.publication_history ?? [])]
      .some(publication => ["merged", "unchanged"].includes(publication.state)
        && publication.documents.some(published => published.id === document.id && published.revision === document.revision));
  });
  if (pendingProposal || unpublished) return { ...row, status_label: "待检视", group: "attention" };
  if (knowledgeArchiveState(job) === "failed") return { ...row, status_label: "已发布 · 归档待处理", group: "attention" };
  if (knowledgeArchiveState(job) === "running") return { ...row, status_label: "已发布 · 归档中", group: "completed" };
  if (job.documents.length) return { ...row, status_label: "已发布" };
  return row;
}

export function componentKnowledgeTask(record: ResearchRecord): KnowledgeTaskRow {
  const row: KnowledgeTaskRow = {
    id: record.id, kind: "component", title: record.topic || `${record.language} 基础组件萃取`, scope: record.language,
    operator: record.operator, created_at: validTime(record.created_at), finished_at: validTime(record.finished_at),
    status: record.status, ...state(record.status), stage: record.stage, error: record.error,
    latest_note: latestKnowledgeResearchNote(record.evidence),
  };
  if (record.status === "running") row.status_label = record.review_turns?.some(turn => ["queued", "running"].includes(turn.status) && turn.mode !== "discuss") ? "修改中" : "研究中";
  if (record.status !== "done" || record.challenge) return row;
  const children = record.children;
  const published = record.document_id || (children?.length && children.every(child => !!child.document_id));
  const draft = record.draft || record.document || children?.some(child => child.draft || child.document);
  if (published) return { ...row, status_label: "已发布" };
  if (draft || record.review_turns?.some(turn => turn.proposal?.status === "pending")) return { ...row, status_label: "待检视", group: "attention" };
  return row;
}

export function skillExtractionTask(record: ExtractionJobRecord): KnowledgeTaskRow {
  return {
    id: record.id, kind: "skill-extraction", title: record.intent, scope: record.repo, operator: record.operator,
    started_at: validTime(record.started_at), finished_at: validTime(record.finished_at),
    status: record.status, ...state(record.status), error: record.error,
    // 制作记录不追踪后续提交审核，不能把已生成草稿永远算作待审核。
    ...(record.status === "done" ? { status_label: "草稿已生成", stage: "可在详情中编辑并提交 Skill" } : {}),
  };
}

export function skillSubmissionTask(record: SkillSubmissionRecord): KnowledgeTaskRow {
  return {
    id: `${record.directory}/${record.id}`, kind: "skill-submission", title: record.directory,
    scope: [...record.business_module_ids ?? [], ...record.technologies ?? []].join(" · "),
    operator: record.operator, created_at: validTime(record.created_at), status: record.status,
    status_label: record.status === "pending" ? "待审核" : record.status === "approved" ? "已上架" : "已退回",
    group: record.status === "pending" ? "attention" : "completed", error: record.reject_reason,
    // created_at → decided_at 是审核等待，不是执行耗时。
    stage: record.decided_at ? `审核时间 ${record.decided_at}` : "等待管理员审核 Skill 包",
  };
}

export interface KnowledgeTaskSources {
  dataDir: string;
  domain: { list(probes?: boolean): Array<{ id: string }>; get(id: string): DomainKnowledgeJob; componentArchive?(id: string): DomainKnowledgeJob | undefined };
  component: { list(summaryOnly?: boolean): ResearchRecord[]; get(id: string): ResearchRecord };
  skillExtractionJob(id: string): ExtractionJobRecord | undefined;
}

/** 只读投影：各自的研究记录仍是状态来源，中心不保存第二份任务。 */
export function listKnowledgeTasks(sources: KnowledgeTaskSources): KnowledgeTaskCenterData {
  const tasks: KnowledgeTaskRow[] = [], warnings: string[] = [];
  const collect = (label: string, read: () => void) => {
    try { read(); } catch { warnings.push(`${label}暂时无法读取，请在原任务入口查看`); }
  };
  collect("领域萃取", () => {
    for (const job of [...sources.domain.list(), ...sources.domain.list(true)]) tasks.push(domainKnowledgeTask(sources.domain.get(job.id)));
  });
  collect("基础组件萃取", () => {
    for (const record of sources.component.list()) {
      const row = componentKnowledgeTask(record);
      if (row.status_label === "已发布") {
        const archive = sources.domain.componentArchive?.(record.id);
        if (archive) {
          const status = knowledgeArchiveState(archive);
          if (status === "failed") Object.assign(row, { status_label: "已发布 · 归档待处理", group: "attention" });
          else if (status === "running") row.status_label = "已发布 · 归档中";
        }
      }
      // 旧版批量记录的子任务动态不在父记录中；保留其真实发生时间。
      if (!row.latest_note && record.child_ids?.length) {
        const notes = record.child_ids.map(id => latestKnowledgeResearchNote(sources.component.get(id).evidence))
          .filter((note): note is NonNullable<typeof note> => !!note);
        row.latest_note = notes.filter(note => note.at).sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
      }
      tasks.push(row);
    }
  });
  collect("Skill 制作", () => {
    const root = join(sources.dataDir, "knowledge-extract");
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^ke-[a-z0-9-]{1,61}$/.test(entry.name)) continue;
      // 沿用现有读取方法，重启中断的记录不会显示为仍在运行。
      const record = sources.skillExtractionJob(entry.name);
      if (record) tasks.push(skillExtractionTask(record));
    }
  });
  collect("Skill 导入", () => tasks.push(...listSkillSubmissions(sources.dataDir).map(skillSubmissionTask)));
  tasks.sort((a, b) => Date.parse(b.created_at ?? b.started_at ?? "") - Date.parse(a.created_at ?? a.started_at ?? "") || a.id.localeCompare(b.id));
  return { tasks, warnings, summary: {
    running: tasks.filter(task => task.group === "running").length,
    attention: tasks.filter(task => task.group === "attention").length,
    total: tasks.length,
  } };
}
