export type KnowledgeReviewKind = "domain" | "component" | "published" | "skill";
export interface KnowledgeReviewNoteInput {
  document_id: string;
  scope: "line" | "document" | "study";
  line?: number;
  line_end?: number;
  anchor?: string;
  quote?: string;
  context_before?: string;
  context_after?: string;
  note: string;
}
export interface KnowledgeReviewNote extends KnowledgeReviewNoteInput {
  id: string;
  kind: KnowledgeReviewKind;
  job_id: string;
  document_title: string;
  operator: string;
  created_at: string;
  status: "open" | "submitted" | "resolved";
  submitted_at?: string;
  submitted_by?: string;
  turn_id?: string;
  resolved_at?: string;
  resolved_by?: string;
}
