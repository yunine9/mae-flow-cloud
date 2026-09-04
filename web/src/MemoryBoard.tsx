/**
 * 任务记忆总览(只读)。docs/knowledge-memory-design.md §9「可见不可管」:
 * 这里没有编辑、没有删除、没有审核——记忆由闭环自动产生、由台账自动排序
 * 和沉底;人能看到"记了什么、谁被推过、谁真被用、谁返工了、谁沉底了",
 * 想撤自己圈的那条,回任务页去撤。
 */

import { useEffect, useMemo, useState } from "react";
import {
  getMemoryInsights, readMemoryInsight,
  type MemoryInsightRow, type MemoryInsights,
} from "./api";

const SOURCE = {
  annotation: "检视意见闭环", prepush_fix: "Build-Fix 修好", user_note: "人圈选记下",
} as const;
const SCOPE = { one_off: "一次性", local: "局部", general: "通用" } as const;
const DRAFT = { template: "起草中", model: "模型起草", failed: "起草失败·保留模板" } as const;

function day(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], {
    year: "2-digit", month: "2-digit", day: "2-digit",
  });
}

export function MemoryBoard({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [insights, setInsights] = useState<MemoryInsights>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [repo, setRepo] = useState("");
  const [scope, setScope] = useState("");
  const [source, setSource] = useState("");
  const [withGone, setWithGone] = useState(false);
  const [needle, setNeedle] = useState("");
  const [open, setOpen] = useState<{ id: string; content: string }>();

  async function load() {
    setLoading(true);
    try {
      setInsights(await getMemoryInsights());
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "读取记忆总览失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = useMemo(() => {
    const all = insights?.memories ?? [];
    const query = needle.trim();
    return all.filter((row) =>
      (!repo || row.repo === repo)
      && (!scope || row.scope === scope)
      && (!source || row.source === source)
      && (withGone || (!row.archived && !row.withdrawn && !row.superseded_by))
      && (!query || `${row.trigger}${row.conclusion}${row.paths.join(" ")}`.includes(query)))
      .slice(0, 200);
  }, [insights, repo, scope, source, withGone, needle]);

  const totals = useMemo(() => {
    const repos = insights?.repos ?? [];
    const sum = (key: keyof typeof repos[number]) =>
      repos.reduce((acc, item) => acc + Number(item[key] ?? 0), 0);
    return {
      active: sum("active"), one_off: sum("one_off"), archived: sum("archived"),
      pushes: sum("pushes"), hits: sum("hits"), reworks: sum("reworks"),
    };
  }, [insights]);

  async function toggle(row: MemoryInsightRow) {
    if (open?.id === row.id) { setOpen(undefined); return; }
    const found = await readMemoryInsight(row.id);
    if (found) setOpen({ id: row.id, content: found.content });
  }

  return <section className="memory-board" aria-labelledby="memory-board-title">
    <header className="knowledge-flywheel-head">
      <div><span className="section-kicker">TASK MEMORY</span>
        <h2 id="memory-board-title">任务记忆</h2>
        <p className="knowledge-flywheel-note">
          平台不建知识库，只记住自己干过的活：闭环的检视意见、修好的构建失败、人圈选记下的约定，
          自动落成记忆，下一单改到同一处时推给 Agent。这里只看不管——排序和沉底由台账自动完成。
        </p></div>
      <div className="memory-board-status">
        <span className={`memory-board-chip sidecar-${insights?.sidecar ?? "absent"}`}>
          {insights?.sidecar === "ready" ? "语义检索在线"
            : insights?.sidecar === "unavailable" ? "语义检索暂不可用" : "语义检索未部署"}
        </span>
        {!!insights?.drafting && <span className="memory-board-chip">起草中 {insights.drafting}</span>}
        <button type="button" className="knowledge-flywheel-refresh" onClick={() => void load()}
          disabled={loading} aria-label="刷新记忆总览">{loading ? "刷新中…" : "刷新"}</button>
      </div>
    </header>
    {error && !insights && <div className="knowledge-flywheel-error" role="alert">
      <strong>读不到记忆总览</strong><span>{error}</span></div>}
    <div className="memory-board-metrics" aria-label="记忆总览摘要">
      <div><strong>{totals.active}</strong><span>在用</span></div>
      <div><strong>{totals.one_off}</strong><span>一次性（只进检索）</span></div>
      <div><strong>{totals.archived}</strong><span>已沉底</span></div>
      <div><strong>{totals.pushes}</strong><span>推送次数</span></div>
      <div><strong>{totals.hits}</strong><span>Agent 命中</span></div>
      <div className={totals.reworks ? "is-warn" : ""}><strong>{totals.reworks}</strong><span>推后返工</span></div>
    </div>
    <div className="memory-board-filters">
      <select value={repo} onChange={(event) => setRepo(event.target.value)} aria-label="按仓库筛选">
        <option value="">全部仓库</option>
        {(insights?.repos ?? []).map((item) => <option key={item.repo} value={item.repo}>
          {item.repo}（{item.active} 在用）</option>)}
      </select>
      <select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="按范围筛选">
        <option value="">全部范围</option>
        {Object.entries(SCOPE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="按来源筛选">
        <option value="">全部来源</option>
        {Object.entries(SOURCE).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <input value={needle} onChange={(event) => setNeedle(event.target.value)}
        placeholder="按触发条件、结论或路径找" aria-label="搜索记忆" />
      <label><input type="checkbox" checked={withGone}
        onChange={(event) => setWithGone(event.target.checked)} />含已沉底 / 撤回 / 被覆盖</label>
    </div>
    {rows.length ? <ol className="memory-board-list">
      {rows.map((row) => {
        const gone = row.archived || row.withdrawn || !!row.superseded_by;
        return <li key={row.id} className={`source-${row.source}${gone ? " is-gone" : ""}`}>
          <button type="button" className="memory-board-row" aria-expanded={open?.id === row.id}
            onClick={() => void toggle(row)}>
            <i aria-hidden>{row.source === "user_note" ? "记" : row.source === "prepush_fix" ? "修" : "议"}</i>
            <span className="memory-board-main">
              <strong>{row.trigger}
                <b className={`memory-board-tag scope-${row.scope}`}>{SCOPE[row.scope]}</b>
                {row.source !== "user_note" && row.draft !== "model"
                  && <b className="memory-board-tag" title={DRAFT[row.draft]}>{row.draft === "failed" ? "模板" : "起草中"}</b>}
                {row.archived && <b className="memory-board-tag is-archived" title={row.archive_reason}>已沉底</b>}
                {row.withdrawn && <b className="memory-board-tag is-archived">已撤回</b>}
                {row.superseded_by && <b className="memory-board-tag is-archived">被覆盖</b>}
              </strong>
              <em>{row.conclusion}</em>
              <small>{row.repo} · {SOURCE[row.source]} · {row.judged_by === "human" ? "人确认" : "流水线"}
                {row.paths[0] ? ` · ${row.paths[0]}${row.line ? `:${row.line}` : ""}` : ""}
                {` · ${day(row.at)}`}
              </small>
            </span>
            <span className="memory-board-stats" title={`权重 ${row.weight}${row.last_used ? ` · 最近用于 ${day(row.last_used)}` : ""}`}>
              <b>推 {row.pushes}</b><b>命中 {row.hits}</b>
              <b className={row.reworks ? "is-warn" : ""}>返工 {row.reworks}</b>
            </span>
          </button>
          <div className="memory-board-foot">
            <button type="button" className="link" onClick={() => onOpenTask?.(row.task)}>
              来自任务 {row.task}</button>
          </div>
          {open?.id === row.id && <pre className="knowledge-memory-source">{open.content}</pre>}
        </li>;
      })}
    </ol> : <div className="knowledge-flywheel-empty">
      {insights ? "还没有符合条件的记忆。闭环的检视意见、修好的构建失败和圈选「记为记忆」会自动落在这里。" : "加载中…"}
    </div>}
  </section>;
}
