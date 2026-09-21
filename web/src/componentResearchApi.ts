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
