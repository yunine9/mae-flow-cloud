import { useCallback, useEffect, useRef, useState } from "react";
import { RequirementDiff } from "./RequirementDiff";

export const OVERALL_STORY_ARTIFACT = "task-materials/overall-story.md";
interface Source { id: string; task_id?: string; name: string; missing?: string }
export interface OverallStoryStatus {
  eligible: boolean; current?: string; stale: boolean; label: string;
  sources: Source[]; pending_reviews: number; can_confirm: boolean;
  revisions: Array<{ id: string; at: string; by: string; additions: number; deletions: number }>;
  confirmed?: { revision: string; by: string; at: string };
  job?: { id: string; started_at: string; kind?: "architecture" }; error?: string;
  error_kind?: "story" | "architecture";
}
async function requestStory(taskId: string, action = "", body?: object): Promise<OverallStoryStatus> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/overall-story${action}`, body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败（${response.status}）`);
  return result;
}

/** 状态局部轮询；只在文档版本变化时刷新阅读器，不让正文随 Agent 日志闪烁。 */
export function OverallStoryTools({ taskId, canOperate, canceled, onUpdated, onOpenTask }: {
  taskId: string; canOperate: boolean; canceled: boolean;
  onUpdated(): void; onOpenTask?(id: string): void;
}) {
  const [status, setStatus] = useState<OverallStoryStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState("");
  const [diff, setDiff] = useState<string>();
  const previous = useRef<string | undefined>(undefined);
  const update = useRef(onUpdated); update.current = onUpdated;
  const accept = useCallback((next: OverallStoryStatus) => {
    if (next.current !== previous.current) {
      previous.current = next.current;
      if (next.current) update.current();
    }
    setStatus(next);
  }, []);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    previous.current = undefined; setStatus(undefined); setError("");
    const refresh = async () => {
      try { const next = await requestStory(taskId); if (alive) { accept(next); setError(""); } }
      catch (e) { if (alive) setError(String(e instanceof Error ? e.message : e)); }
      if (alive) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [taskId, accept]);
  useEffect(() => {
    setDiff(undefined);
    if (!revision) return;
    let alive = true;
    void fetch(`/tasks/${encodeURIComponent(taskId)}/overall-story/revisions/${encodeURIComponent(revision)}`)
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error); return body; })
      .then((body) => { if (alive) setDiff(String(body.diff)); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [taskId, revision]);
  async function act(action: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { accept(await requestStory(taskId, action, action === "/confirm" ? { revision: status?.current } : {})); }
    catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  if (status && !status.eligible) return null;
  return <section className="overall-story-tools" aria-label="全局 Story 维护">
    <div className="overall-story-bar">
      <span className="overall-story-status">{status?.label ?? "读取文档状态…"}</span>
      <div className="overall-story-actions">
        {canOperate && !canceled && status?.current && (status.job
          ? <button type="button" disabled={busy} onClick={() => void act("/stop")}>停止整理</button>
          : <button type="button" className={status.stale ? "primary" : ""}
              disabled={busy || !status} onClick={() => void act("")}>
              {busy ? "请求中…" : "更新 Story"}</button>)}
        <button type="button" className="overall-story-details" aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>来源与版本 {expanded ? "⌃" : "⌄"}</button>
      </div>
    </div>
    {(error || (status?.error_kind !== "architecture" && status?.error))
      && <p className="overall-story-error" role="alert">{error || status?.error}</p>}
    {expanded && status && <div className="overall-story-detail">
      <p>维护全局设计、模块依赖和验收依据，子任务 Story 提供实现细化与变更反馈。子任务变化只提醒待同步，由责任人主动更新。可在正文划选批注，提交后由 Agent 修改整体 Story，再由意见作者复检。</p>
      <ul className="overall-story-sources">{status.sources.map((s) => <li key={s.id}>
        {s.task_id && onOpenTask ? <button type="button" onClick={() => onOpenTask(s.task_id!)}>{s.name} ↗</button> : <strong>{s.name}</strong>}
        <span className={s.missing ? "missing" : ""}>{s.missing ?? "Story 可读取"}</span>
      </li>)}</ul>
      <div className="overall-story-history">
        <label>更新对比 <select value={revision} onChange={(e) => setRevision(e.target.value)}>
          <option value="">选择版本</option>
          {[...status.revisions].reverse().map((r, i) => <option key={r.id} value={r.id}>
            第 {status.revisions.length - i} 版 · {new Date(r.at).toLocaleString()} · +{r.additions} −{r.deletions}
          </option>)}
        </select></label>
        {canOperate && status.current && status.confirmed?.revision !== status.current && <button type="button"
          disabled={busy || !status.can_confirm}
          title={!status.can_confirm ? "来源已同步、检视意见全部闭环后可以确认" : "确认当前版本的整体文档"}
          onClick={() => void act("/confirm")}>确认这版整体 Story</button>}
        {status.confirmed?.revision === status.current && <span>已由 {status.confirmed?.by} 确认</span>}
      </div>
      {status.pending_reviews > 0 && <p>{status.pending_reviews} 条整体 Story 意见尚未闭环，请在「批注与检视」中处理。</p>}
      {revision && <div className="overall-story-diff">{diff === undefined ? "读取版本差异…" : <RequirementDiff text={diff} />}</div>}
    </div>}
  </section>;
}
