/** 生产状态的只读 HTTP 契约，前端只渲染这里的文案和动作。 */
export interface KnowledgeProductionAction {
  id: string; label: string; view: "progress" | "review" | "archive"; href?: string; document_id?: string;
}
export interface KnowledgeDomainDeletionView {
  title: string; message: string;
  archive_batches: Array<{ id: string; state: string; error?: string;
    documents: Array<{ id: string; title: string; path: string }>;
    publications: Array<{ target_id: string; branch: string; state: string; url?: string; error?: string; sync_state?: string; sync_error?: string }> }>;
}
export interface KnowledgeDocumentState {
  id: string; changed: boolean; status_label: string; published_revision?: number; proposal_problem?: string; knowledge_document_id?: string;
  needs_remote_review: boolean; remote_review_message?: string;
}
export interface KnowledgePublicationState {
  key: string; target: string; status_label: string; url?: string; error?: string;
  comparisons: KnowledgeProductionAction[];
}
export interface KnowledgeProductionView {
  status_label: string; group: "running" | "attention" | "completed"; next_action: KnowledgeProductionAction;
  working: boolean; modifying: boolean;
  research_actions: KnowledgeProductionAction[];
  knowledge_document_id?: string;
  platform_message?: string;
  navigation: { working_label?: string; ready_message?: string; ready_action_label?: string };
  documents: KnowledgeDocumentState[];
  review: { readonly: boolean; selection_message?: string; active_message?: string;
    sections: Array<{ id: string; status_label: string; proposal_message?: string; proposal_problem?: string }>;
    turns: Array<{ id: string; status_label: string; proposal_status_label?: string }>;
    capabilities: Array<{ id: string; status_label: string }>; progress_message?: string };
  archive: {
    visible: boolean; state: "failed" | "running" | "opened" | "done"; group: "running" | "attention" | "completed";
    status_label: string; title: string; message: string; actions: KnowledgeProductionAction[];
    target_locked: boolean; locked_target_ids: string[]; issue_description_required: boolean;
    publications: KnowledgePublicationState[];
    batches: Array<{ id: string; status_label: string; title: string; publications: KnowledgePublicationState[]; superseded: Array<{ id: string; label: string }> }>;
  };
}
