export type KnowledgeTaskKind = "domain" | "component" | "skill-extraction" | "skill-submission";
export type KnowledgeTaskGroup = "running" | "attention" | "completed";

export interface KnowledgeTaskRow {
  id: string;
  kind: KnowledgeTaskKind;
  title: string;
  scope?: string;
  operator?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  status: string;
  status_label: string;
  group: KnowledgeTaskGroup;
  stage?: string;
  error?: string;
  /** 仅公开的 assistant 文本摘要；工具原始输出不进入列表。 */
  latest_note?: { text: string; at?: string };
}

export interface KnowledgeTaskSummary {
  running: number;
  attention: number;
  total: number;
}

export interface KnowledgeTaskCenterData {
  tasks: KnowledgeTaskRow[];
  summary: KnowledgeTaskSummary;
  warnings: string[];
}
