export interface ComponentRepository {
  id: string;
  name: string;
  repository: string;
  branch: string;
  path: string;
  languages: string[];
  description: string;
  enabled: boolean;
}
export interface ComponentResearchRecord {
  production?: import("../../src/knowledgeProductionTypes").KnowledgeProductionView;
  pipeline?: { tasks: Array<{ id: string; title: string; status: string; feedback?: string }> };
  material_ids?: string[];
  update_document_revision?: string;
  update_metadata?: { title: string; scope: string; module_ids: string[]; repositories: string[] };
  id: string;
  skill?: { name: string; digest: string };
  section_history?: Array<{ at: string; operator: string; section: ComponentResearchSection }>;
  update_document_id?: string;
  mode?: "all";
  format?: "joint-document";
  document?: { overview: string; sections: ComponentResearchSection[] };
  review_turns?: ComponentResearchReviewTurn[];
  component: ComponentRepository;
  components?: ComponentRepository[];
  revisions?: Record<string, string>;
  language: string;
  topic: string;
  operator: string;
  status: string;
  stage: string;
  created_at: string;
  revision?: string;
  draft?: string;
  error?: string;
  document_id?: string;
  evidence: Array<Record<string, unknown>>;
}
export interface ComponentResearchSection {
  paradigm?: { kind: string; component: string; language: string; status: string; need: string; api: string[]; applicability: string; replaces: { identifiers: string[]; imports: string[]; patterns: string[] }; evidence: Array<{ repository_id: string; path: string; revision: string; start: number; end: number }>; usage_evidence: string[]; open_questions: string[] };
  id: string; title: string; repository_ids: string[]; selected: boolean;
  content: string; interfaces: string; integration: string; example: string; sources: string;
  related_ids: string[]; revision: number;
}
export interface ComponentResearchReviewTurn {
  id: string; section_id: string; mode: "discuss" | "rework" | "update" | "supplement"; added_section_ids?: string[]; message: string; operator: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  skill?: { name: string; digest: string };
  proposal?: { base_revision: number; section: ComponentResearchSection; status: "pending" | "accepted" | "discarded" };
  reply?: string; error?: string; created_at: string; finished_at?: string;
}
export interface ComponentResearchPublicationInput {
  title: string;
  content?: string;
  scope: string;
  module_ids: string[];
  repositories: string[];
  sections: Array<{ id: string; revision: number; proposal_id: string | null }>;
  document_id: string | null;
  update_document_id: string | null;
  update_document_revision?: string;
}
export async function publishComponentResearch(id: string, input: ComponentResearchPublicationInput) {
  return componentRequest<ComponentResearchRecord>(`/component-research/${encodeURIComponent(id)}/publish`, input, AbortSignal.timeout(30_000));
}
export async function componentRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? signal ? { signal } : undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
  );
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : "请求失败");
  return result as T;
}
