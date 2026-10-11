import type { KnowledgeAnswerContext, KnowledgeAnswerInput, KnowledgeAnswerRecord, KnowledgeAnswerSourceKind } from "../../src/knowledgeAnswerTypes";

export type { KnowledgeAnswerContext, KnowledgeAnswerInput, KnowledgeAnswerRecord, KnowledgeAnswerEvidence } from "../../src/knowledgeAnswerTypes";

export interface KnowledgeAnswerCatalog {
  modules: Array<{ id: string; name: string }>;
  repositories: Array<{ id: string; name: string; repository: string }>;
  documents: Array<{ id: string; title: string; module_ids: string[]; revision: string }>;
  sources: Array<{ kind: KnowledgeAnswerSourceKind; label: string; available: boolean; detail?: string }>;
}

async function request<T>(path = "", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/knowledge-answers${path}`, {
    signal,
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `知识问答请求失败（${response.status}）`);
  return data;
}

export const getKnowledgeAnswers = (signal?: AbortSignal) => request<{ answers: KnowledgeAnswerRecord[] }>("", undefined, signal);
export const getKnowledgeAnswerCatalog = (signal?: AbortSignal) => request<KnowledgeAnswerCatalog>("/catalog", undefined, signal);
export const getKnowledgeAnswer = (id: string, signal?: AbortSignal) => request<KnowledgeAnswerRecord>(`/${encodeURIComponent(id)}`, undefined, signal);
export const startKnowledgeAnswer = (input: KnowledgeAnswerInput) => request<KnowledgeAnswerRecord>("", input);
export const cancelKnowledgeAnswer = (id: string) => request<KnowledgeAnswerRecord>(`/${encodeURIComponent(id)}/cancel`, {});
export const sendKnowledgeAnswerFeedback = (id: string, useful: boolean, comment: string) => request<KnowledgeAnswerRecord>(`/${encodeURIComponent(id)}/feedback`, { useful, comment });

export const knowledgeAnswerRunning = (record: Pick<KnowledgeAnswerRecord, "status">) => record.status === "queued" || record.status === "running";

/** 停止、完成后的记录不能被同时到达的旧轮询覆盖。 */
export function newerKnowledgeAnswer(current: KnowledgeAnswerRecord | undefined, incoming: KnowledgeAnswerRecord): KnowledgeAnswerRecord {
  if (!current || current.id !== incoming.id) return incoming;
  if (!knowledgeAnswerRunning(current) && knowledgeAnswerRunning(incoming)) return current;
  return current.updated_at > incoming.updated_at ? current : incoming;
}

export function questionContext(moduleKey?: string, documentId?: string): KnowledgeAnswerContext {
  const moduleId = moduleKey?.startsWith("business:") ? moduleKey.slice("business:".length) : undefined;
  return { ...(moduleId ? { module_ids: [moduleId] } : {}), ...(documentId ? { document_id: documentId } : {}) };
}
