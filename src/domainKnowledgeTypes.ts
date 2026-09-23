export interface KnowledgeRepository {
  id: string; name: string; repository: string; branch: string; path: string; docs_path: string;
}
export interface DomainDocumentContent {
  id: string; title: string; target_id: string; path: string; layer: "domain" | "repository"; content: string; sources: string;
}
export interface DomainDocument extends DomainDocumentContent {
  /** 用户在归档设置中指定的完整相对路径；模型输出不能设置此字段。 */
  archive_path?: string;
  revision: number; selected: boolean; base_content: string | null; base_revision: string;
  history: Array<{ revision: number; content: string; sources: string; title: string; operator: string; at: string }>;
  knowledge_document_id?: string;
  remote_review?: DomainRemoteReview;
}
export interface DomainRemoteReview {
  id: string; target_content: string | null; target_revision: string;
  branch?: string; branch_content?: string | null; branch_revision?: string;
  reviewed: boolean;
}
export interface DomainTurn {
  id: string; mode: "extract" | "discuss" | "revise" | "update"; document_ids: string[]; message: string; operator: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled"; created_at: string; reply?: string; error?: string;
  skill?: { name: string; digest: string };
  use_latest_skill?: boolean; previous_revisions?: Record<string, string>;
  revisions?: Record<string, string>;
  document_revisions?: Record<string, number>;
  proposals: Array<{ document: DomainDocumentContent; base_revision: number; status: "pending" | "accepted" | "discarded" }>;
}
export interface KnowledgeCleanupPlan {
  id: string; target_id: string; directories: string[]; confirmed: boolean;
  target_revision: string; target_entries: Array<{ path: string; mode: string; oid: string }>;
  branch?: string; branch_entries?: KnowledgeCleanupPlan["target_entries"];
  agent?: { path: string; content: string; target_content: string | null; branch_content?: string | null };
  document_versions: string[];
  preserve_paths?: string[];
}
export interface DomainPublication {
  target_id: string; state: "pending" | "opened" | "merged" | "failed" | "closed" | "unchanged";
  branch: string; mr_attempted?: boolean; url?: string; mr_id?: string | number; error?: string; revision?: string;
  documents: Array<{ id: string; path: string; content: string; revision: number; base_content?: string | null }>;
  attempted_documents?: DomainPublication["documents"];
  sync_state?: "pending" | "done" | "failed";
  sync_error?: string;
  cleanup_id?: string; removed_paths?: string[];
}
export interface DomainKnowledgeJob {
  cleanup_only?: boolean;
  source_cleanup?: KnowledgeSourceCleanupState;
  id: string; title: string; scope: string; issue_no?: string; module_id?: string; operator: string; created_at: string;
  component_research_id?: string; technologies?: string[];
  repositories: KnowledgeRepository[]; knowledge_target: KnowledgeRepository;
  source_repositories?: KnowledgeRepository[];
  archive_configured?: boolean; archive_revision?: number;
  material_ids: string[]; use_wxdoubao: boolean; ar_codes: string[];
  deleted_at?: string; deleted_by?: string;
  status: "idle" | "queued" | "running" | "done" | "failed" | "cancelled"; stage: string; error?: string;
  revisions: Record<string, string>; skill?: { name: string; digest: string };
  documents: DomainDocument[]; turns: DomainTurn[]; evidence: Array<Record<string, unknown>>; publications: DomainPublication[];
  publication_history?: DomainPublication[];
  cleanup_plans?: KnowledgeCleanupPlan[];
}
export interface DomainExecution {
  job: DomainKnowledgeJob; turn: DomainTurn; root: string; signal: AbortSignal;
  save: (document: DomainDocumentContent, baseline?: { content: string | null; revision: string }) => DomainDocumentContent;
  read: () => DomainDocument[];
  update: (patch: { revisions?: Record<string, string>; skill?: DomainKnowledgeJob["skill"]; stage?: string }) => void;
  evidence: (event: Record<string, unknown>) => void;
}

export interface KnowledgeSourceCleanupState {
  repositories: KnowledgeRepository[];
  plans: KnowledgeCleanupPlan[];
  publications: DomainPublication[];
  started?: boolean;
}
