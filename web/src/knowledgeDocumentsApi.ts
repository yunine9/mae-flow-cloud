import type { KnowledgeAssetFocus } from "./knowledgeNavigation";
export interface KnowledgeDocument {
  external?: boolean; form?: string; scope_label?: string; focus?: KnowledgeAssetFocus;
  id: string; title: string; content?: string; scope: "platform" | "module" | "repository";
  module_ids: string[]; repositories: string[]; technologies: string[]; product_versions: string[];
  when_to_use: string; active: boolean; revision: string;
  source?: { repository: string; branch: string; path: string; revision: string };
  research_source?: { job_id:string; repository:string; branch:string; path:string; revision?:string };
  history: Array<{ at: string; operator: string; action: string }>;
  indexing?: { state: string; sections?: number; error?: string }; lines?: number;
}
export interface ChapterHit { id: string; heading?: string; start_line?: number; end_line?: number; revision: string; summary?: string }
export interface TrialResult { available: boolean; warnings: string[]; hits: ChapterHit[] }
export async function documentRequest<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/knowledge-documents${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}
