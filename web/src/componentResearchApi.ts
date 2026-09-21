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
  id: string;
  mode?: "topic" | "all" | "component";
  format?: "joint-document";
  document?: { overview: string; sections: ComponentResearchSection[] };
  review_turns?: ComponentResearchReviewTurn[];
  parent_id?: string;
  children?: ComponentResearchRecord[];
  progress?: { total: number; done: number; failed: number; cancelled: number; running: number; queued: number; adopted: number };
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
  id: string; title: string; repository_ids: string[]; selected: boolean;
  content: string; interfaces: string; integration: string; example: string; sources: string;
  related_ids: string[]; revision: number;
}
export interface ComponentResearchReviewTurn {
  id: string; section_id: string; mode: "discuss" | "rework"; message: string; operator: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  reply?: string; error?: string; created_at: string; finished_at?: string;
}
export async function componentRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}
