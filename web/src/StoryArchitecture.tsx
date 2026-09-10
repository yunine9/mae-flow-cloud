import { useEffect, useRef, useState } from "react";
import { withArchifyPresentation } from "./archifyPresentation";
import "./story-architecture.css";
import { storyViewCoverage, type StoryViewCoverage } from "../../src/storyViewCoverage";
import { storyViewTitles } from "./storyViewTitles";

interface Projection {
  revision: string; renderer: string; warnings: string[];
  diagrams: Array<{ id: string; title: string; type: string; line: number }>;
  views?: StoryViewCoverage[];
}
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `读取失败（${response.status}）`);
  return body;
}

/** 图源属于 Story，这里只保存选择状态。换版本时立即卸载旧 iframe，不显示过期图。 */
export function StoryArchitecture({ taskId, onOpenStory, requestedLine, onOpenView }: { taskId: string; onOpenStory(): void; requestedLine?: number; onOpenView?(id: string): void }) {
  const [projection, setProjection] = useState<Projection>();
  const [selected, setSelected] = useState("");
  const [activeView, setActiveView] = useState("logical");
  const [error, setError] = useState("");
  const [pulse, refresh] = useState(0);
  const [rendered, setRendered] = useState<{ key: string; html?: string; error?: string }>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [presenting, setPresenting] = useState("");
  const base = `/tasks/${encodeURIComponent(taskId)}/architecture`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setProjection(undefined); setError("");
    async function update() {
      try {
        const next = await read<Projection>(base, controller.signal);
        if (!controller.signal.aborted) {
          setProjection((previous) => previous?.revision === next.revision ? previous : next);
          setError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted) { setError(String(reason instanceof Error ? reason.message : reason)); setProjection(undefined); }
      }
      if (!controller.signal.aborted) timer = setTimeout(update, 5000);
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, pulse]);
  useEffect(() => {
    const requested = projection?.diagrams.find((item) => item.line === requestedLine);
    if (requested) {
      setSelected(requested.id);
      const owner = projection?.views?.find((view) => view.line !== undefined && requested.line > view.line && requested.line <= (view.endLine ?? view.line));
      setActiveView(owner?.id ?? "logical");
    }
  }, [requestedLine, projection?.revision]);
  const views = projection?.views ?? storyViewCoverage("");
  const view = views.find((item) => item.id === activeView) ?? views[0];
  const ownerOf = (line: number) => views.filter((item) => item.line !== undefined && line > item.line && line <= (item.endLine ?? item.line))
    .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
  // 旧 Story 尚未归类的图仍保留在初始入口；不能因新导航而丢掉已有图。
  const diagrams = projection?.diagrams.filter((item) => (ownerOf(item.line)?.id ?? "logical") === view.id) ?? [];
  const diagram = diagrams.find((item) => item.id === selected) ?? diagrams[0];
  const key = `${base}/${projection?.revision}/${diagram?.id}/${pulse}`;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // 沙箱图的 origin 是 null，只接受当前 iframe 的窗口，忽略其他页面/旧图。
      if (!frame.current || event.source !== frame.current.contentWindow
        || event.data?.type !== "mfc:archify-presentation") return;
      setPresenting(event.data.active === true ? key : "");
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || presenting !== key) return;
      frame.current?.contentWindow?.postMessage({ type: "mfc:archify-exit" }, "*");
      setPresenting("");
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onEscape);
    return () => { window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onEscape); };
  }, [key, presenting]);
  useEffect(() => {
    if (!diagram || !projection) return;
    const controller = new AbortController();
    void read<{ html?: string; error?: string; revision: string }>(
      `${base}/${diagram.id}?revision=${encodeURIComponent(projection.revision)}`, controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) setRendered({ key, ...result,
        html: result.html ? withArchifyPresentation(result.html) : undefined });
    }).catch((reason) => {
      if (!controller.signal.aborted) setRendered({ key, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [key, base, diagram, projection]);
  const current = rendered?.key === key ? rendered : undefined;
  const viewPanelId = `story-architecture-${taskId}-${view.id}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  return <section className="story-architecture" aria-label="Story 架构图">
    <header className="story-architecture-header">
      <div><strong>4+1 架构图</strong><p>每个页签对应一个设计视角，图名页签打开具体大图</p></div>
      <div className="story-architecture-actions">
        <button type="button" onClick={onOpenStory}>阅读完整 Story ↗</button>
        <button type="button" onClick={() => refresh((n) => n + 1)} aria-label="刷新图源" title="刷新图源">↻</button>
      </div>
    </header>
    {error ? <p role="status">{error}</p> : !projection ? <p role="status">正在读取 Story…</p> : <>
      <nav className="story-view-coverage" role="tablist" aria-label="4+1 架构图">
        {views.map((item, index) => <button type="button" key={item.id} className="story-view-entry"
          id={`story-architecture-tab-${item.id}`} role="tab" aria-selected={item.id === view.id}
          aria-controls={`story-architecture-${taskId}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, "-")}
          title={`${item.label}：${item.reason}`}
          onClick={() => { setActiveView(item.id); setSelected(""); }}>
          <span className="story-view-number">{index === 4 ? "+1" : `0${index + 1}`}</span>
          <strong>{storyViewTitles[item.id]}</strong>
          <span className={`story-view-status ${item.status === "不涉及" ? "omitted" : item.status === "待补充" ? "pending" : "complete"}`}>{item.status}</span>
        </button>)}
      </nav>
      <section className="story-view-detail" id={viewPanelId} role="tabpanel"
        aria-labelledby={`story-architecture-tab-${view.id}`} aria-label={view.label}>
        <div className="story-view-detail-heading">
          <div><strong>{storyViewTitles[view.id]}</strong><span>{view.label}{diagrams.length > 0 && ` · ${diagrams.length} 张图`}</span></div>
          <div className="story-view-actions">
            {view.classDiagram?.line && <button type="button" onClick={() => onOpenView ? onOpenView("logical-class") : onOpenStory()}>查看类图 ↗</button>}
            <button type="button" onClick={() => onOpenView ? onOpenView(view.id) : onOpenStory()}>设计与意见 ↗</button>
          </div>
        </div>
        <p className="story-view-reason">{view.reason}</p>
        {diagrams.length > 0 && <nav className="story-diagram-tabs" role="tablist" aria-label={`${storyViewTitles[view.id]}的图片`}>
          {diagrams.map((item) => <button type="button" role="tab" key={item.id}
            aria-selected={item.id === diagram?.id} onClick={() => setSelected(item.id)}>{item.title}</button>)}
        </nav>}
        {!diagram ? <div className="story-view-empty">
          <span aria-hidden="true">{view.status === "不涉及" ? "—" : "◇"}</span>
          <strong>{view.status === "不涉及" ? "本次不涉及" : view.line ? "设计已记录在 Story" : "设计说明待补充"}</strong>
          <p>{view.classDiagram?.reason ?? "可查看原文依据，或留下你的意见。"}</p>
          <button type="button" onClick={() => onOpenView ? onOpenView(view.id) : onOpenStory()}>打开 Story ↗</button>
          {!projection.diagrams.length && <small>当前 Story 尚无可展示的 Archify 图源。</small>}
        </div> : current?.error ? <div className="story-architecture-failure">
          <p role="status">这张图暂时无法展示。请在完整 Story 中批注反馈；图源修订后会自动更新。</p>
          <button type="button" onClick={onOpenStory}>打开 Story 提意见</button>
          <details><summary>查看失败详情</summary><pre>{current.error}</pre></details>
        </div> : current?.html ? <iframe key={key} ref={frame} title={diagram.title} srcDoc={current.html}
          className={presenting === key ? "is-presenting ui-viewport-layer" : undefined}
          allow="fullscreen *" allowFullScreen sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />
          : <p className="story-view-loading" role="status">正在生成架构图…</p>}
      </section>
      {(projection.warnings.length > 0) && <details className="story-architecture-diagnostics"><summary>{projection.warnings.length} 条图源提示</summary>
        {projection.warnings.map((warning, i) => <p className="story-architecture-warning" key={i}>{warning}</p>)}
      </details>}
      <details className="story-architecture-diagnostics"><summary>版本信息</summary>
        <p>Story {projection.revision.slice(0, 12)} · Archify {projection.renderer.slice(0, 8)}{diagram && ` · 图源第 ${diagram.line} 行`}</p>
      </details>
    </>}
  </section>;
}
