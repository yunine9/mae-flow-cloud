export interface KnowledgeRepository {
  id: string; name: string; repository: string; branch: string; path: string; docs_path: string;
}
export interface DomainDocumentContent {
  id: string; title: string; target_id: string; path: string; layer: "domain" | "repository"; content: string; sources: string;
}
export interface DomainDocument extends DomainDocumentContent {
  component_metadata?: string;
  research_turn_id?: string;
  human_edited?: boolean;
  /** 用户在归档设置中指定的完整相对路径；模型输出不能设置此字段。 */
  archive_path?: string;
  revision: number; selected: boolean; base_content: string | null; base_revision: string;
  history: Array<{ revision: number; content: string; component_metadata?: string; sources: string; title: string; operator: string; at: string }>;
  knowledge_document_id?: string;
  published_revision?: string;
  published_document_revision?: number;
  published_at?: string;
  remote_review?: DomainRemoteReview;
}
export interface DomainRemoteReview {
  target_metadata?: string | null; branch_metadata?: string | null;
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
  research?: DomainResearch;
  /** 仅显式接续递增，服务重启不自动解除 Skill 请求的暂停。 */
  pipeline_continue?: number;
  proposals: Array<{ document: DomainDocumentContent; base_revision: number; status: "pending" | "accepted" | "discarded" }>;
}
export interface DomainResearch {
  capabilities: Array<{ id: string; title: string; repository_ids: string[]; state: "pending" | "researched" | "blocked";
    findings: string; checks?: Record<string, string>; evidence_ids?: string[];
    sources: Array<{ repository_id: string; path: string }>; document_ids: string[] }>;
  inventory_complete: boolean;
  phase: "research" | "review" | "complete";
  finish_requested?: boolean;
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
  documents: Array<{ id: string; path: string; content: string; revision: number; base_content?: string | null; metadata_for?: string; knowledge_document_id?: string; knowledge_revision?: string }>;
  attempted_documents?: DomainPublication["documents"];
  sync_state?: "pending" | "done" | "failed";
  sync_error?: string;
  cleanup_id?: string; removed_paths?: string[];
  target_revision?: string;
  updated_at?: string;
}
export interface DomainArchiveBatch {
  id: string; created_at: string; operator: string; state: "pending" | "running" | "done" | "failed" | "superseded";
  documents: DomainDocument[]; targets: KnowledgeRepository[]; issue_no?: string; issue_description?: string;
  publications: DomainPublication[]; error?: string;
  superseded_documents?: Array<{ document_id: string; knowledge_document_id: string; published_revision: string;
    current_revision?: string; reason: "newer_version" | "deleted" }>;
}
export interface DomainKnowledgeJob {
  /** 临时单模块效果验证，使用独立任务且不允许归档。 */
  probe?: { module: string };
  cleanup_only?: boolean;
  source_cleanup?: KnowledgeSourceCleanupState;
  id: string; title: string; scope: string; issue_no?: string; issue_description?: string; module_id?: string; operator: string; created_at: string;
  /** 用户为本次萃取补充的范围、文件使用限制和输出要求。 */
  instructions?: string;
  component_research_id?: string; technologies?: string[];
  component_source?: { job_id: string; repository: string; branch: string; path: string; revision?: string;
    components?: Array<{ id: string; repository: string; branch: string; path: string; revision?: string }> };
  repositories: KnowledgeRepository[]; knowledge_target: KnowledgeRepository;
  source_repositories?: KnowledgeRepository[];
  archive_configured?: boolean; archive_revision?: number;
  material_ids: string[]; use_wxdoubao: boolean; ar_codes: string[];
  deleted_at?: string; deleted_by?: string;
  status: "idle" | "queued" | "running" | "done" | "failed" | "cancelled"; stage: string; error?: string;
  revisions: Record<string, string>; skill?: { name: string; digest: string };
  documents: DomainDocument[]; turns: DomainTurn[]; evidence: Array<Record<string, unknown>>; publications: DomainPublication[];
  publication_history?: DomainPublication[];
  archive_batches?: DomainArchiveBatch[];
  cleanup_plans?: KnowledgeCleanupPlan[];
}
export interface DomainExecution {
  job: DomainKnowledgeJob; turn: DomainTurn; root: string; signal: AbortSignal;
  save: (document: DomainDocumentContent, baseline?: { content: string | null; revision: string }) => DomainDocumentContent;
  read: () => DomainDocument[];
  update: (patch: { revisions?: Record<string, string>; skill?: DomainKnowledgeJob["skill"]; stage?: string; research?: DomainResearch }) => void;
  evidence: (event: Record<string, unknown>) => void;
}

export interface KnowledgeSourceCleanupState {
  repositories: KnowledgeRepository[];
  plans: KnowledgeCleanupPlan[];
  publications: DomainPublication[];
  started?: boolean;
}
