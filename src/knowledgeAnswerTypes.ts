/** 人与 Agent 共用的问答记录；引用保存当次实际读到的内容。 */
export type KnowledgeAnswerStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type KnowledgeAnswerStage = "queued" | "researching" | "answering" | "checking" | "done";
export type KnowledgeAnswerSourceKind = "knowledge" | "code" | "everycode" | "wireless" | "material";

export interface KnowledgeAnswerContext {
  module_ids?: string[];
  repository_ids?: string[];
  document_id?: string;
  material_ids?: string[];
  product_version?: string;
}

export interface KnowledgeAnswerInput {
  question: string;
  context?: KnowledgeAnswerContext;
}

export interface KnowledgeAnswerEvidence {
  id: string;
  kind: KnowledgeAnswerSourceKind;
  title: string;
  content: string;
  digest: string;
  retrieved_at: string;
  source_id?: string;
  revision?: string;
  repository?: string;
  path?: string;
  scope?: string;
  start_line?: number;
  end_line?: number;
  location?: string;
  truncated?: boolean;
  url?: string;
}

export interface KnowledgeAnswerResult {
  markdown: string;
  evidence_ids: string[];
  unknowns: string[];
}

export interface KnowledgeAnswerActivity {
  at: string;
  stage: KnowledgeAnswerStage;
  message: string;
}

export interface KnowledgeAnswerRecord extends KnowledgeAnswerInput {
  id: string;
  owner: string;
  status: KnowledgeAnswerStatus;
  stage: KnowledgeAnswerStage;
  created_at: string;
  updated_at: string;
  evidence: KnowledgeAnswerEvidence[];
  activity: KnowledgeAnswerActivity[];
  warnings: string[];
  answer?: KnowledgeAnswerResult;
  error?: string;
  feedback?: { useful: boolean; comment: string; at: string };
  integration?: { kind: "luban"; message_id: string };
}

export interface KnowledgeAnswerExecution {
  record: KnowledgeAnswerRecord;
  root: string;
  signal: AbortSignal;
  progress(stage: KnowledgeAnswerStage, message: string): void;
  addEvidence(evidence: Omit<KnowledgeAnswerEvidence, "id" | "digest" | "retrieved_at">): KnowledgeAnswerEvidence;
  warn(message: string): void;
}

export type KnowledgeAnswerRunner = (input: KnowledgeAnswerExecution) => Promise<KnowledgeAnswerResult>;
