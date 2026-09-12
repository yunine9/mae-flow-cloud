import { useEffect, useRef, useState } from "react";
import { withArchifyPresentation } from "./archifyPresentation";
import "./story-architecture.css";
import { storyViewCoverage, type StoryViewCoverage } from "../../src/storyViewCoverage";
import { storyViewTitles } from "./storyViewTitles";

interface Projection {
  revision: string; renderer: string; warnings: string[];
  diagrams: Array<{ id: string; title: string; type: string; renderer?: string; line?: number; view?: StoryViewCoverage["id"] }>;
  views?: StoryViewCoverage[];
}
interface GenerationJob { started_at?: string; progress?: string; kind?: string }
interface GenerationState { job?: GenerationJob; error?: string; error_kind?: "story" | "architecture" }
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `读取失败（${response.status}）`);
  return body;
}

/** Story 与平台图源由服务端绑定版本；这里只保存选择状态，不显示过期图。 */
export function StoryArchitecture({ taskId, onOpenStory, requestedLine, onOpenView, canUpdate = false }: { taskId: string; onOpenStory(): void; requestedLine?: number; onOpenView?(id: string): void; canUpdate?: boolean }) {
  const [projection, setProjection] = useState<Projection>();
  const [selected, setSelected] = useState("");
  const [activeView, setActiveView] = useState("logical");
  const [error, setError] = useState("");
  const [pulse, refresh] = useState(0);
  const [job, setJob] = useState<{ busy: boolean; error?: string; errorKind?: GenerationState["error_kind"]; detail?: GenerationJob }>({ busy: false });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!job.busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.busy]);
  const [submitting, setSubmitting] = useState(false);
  const generationBase = `/tasks/${encodeURIComponent(taskId)}/overall-story`;
  useEffect(() => {
    if (!canUpdate) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let wasBusy = false;
    async function poll() {
      try {
        const state = await read<GenerationState>(generationBase, controller.signal);
        if (controller.signal.aborted) return;
        setJob({ busy: !!state.job, error: state.error, errorKind: state.error_kind, detail: state.job });
        if (wasBusy && !state.job) refresh((n) => n + 1);
        wasBusy = !!state.job;
      } catch (reason) {
        if (!controller.signal.aborted) setJob((previous) => ({ ...previous, errorKind: "architecture",
          error: `进度暂时无法读取：${reason instanceof Error ? reason.message : String(reason)}` }));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    setJob({ busy: false }); void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [generationBase, canUpdate]);
  async function updateArchitecture() {
    setSubmitting(true);
    try {
      const response = await fetch(`${generationBase}/architecture`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "更新失败");
      setJob({ busy: !!body.job, error: body.error, errorKind: body.error_kind, detail: body.job });
    } catch (reason) { setJob({ busy: false, errorKind: "architecture",
      error: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setSubmitting(false); }
  }
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
      const line = requested.line!;
      const owner = projection?.views?.filter((view) => view.line !== undefined && line > view.line && line <= (view.endLine ?? view.line))
        .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
      setActiveView(requested.view ?? owner?.id ?? "logical");
    }
  }, [requestedLine, projection?.revision]);
  const views = projection?.views ?? storyViewCoverage("");
  const ownerOf = (line?: number) => line === undefined ? undefined : views.filter((item) => item.line !== undefined && line > item.line && line <= (item.endLine ?? item.line))
    .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
  const diagramView = (item: Projection["diagrams"][number]) => item.view ?? ownerOf(item.line)?.id ?? "logical";
  const availableViews = views.filter((item) => projection?.diagrams.some((diagram) => diagramView(diagram) === item.id));
  const view = availableViews.find((item) => item.id === activeView) ?? availableViews[0];
  const diagrams = view ? projection?.diagrams.filter((item) => diagramView(item) === view.id) ?? [] : [];
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
        error: result.error || (!result.html ? "渲染器未返回图像" : undefined),
        html: result.html ? withArchifyPresentation(result.html) : undefined });
    }).catch((reason) => {
      if (!controller.signal.aborted) setRendered({ key, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [key, base, diagram, projection]);
  const current = rendered?.key === key ? rendered : undefined;
  const viewPanelId = view ? `story-architecture-${taskId}-${view.id}`.replace(/[^a-zA-Z0-9_-]/g, "-") : undefined;
  return <section className="story-architecture" aria-label="Story 架构图">
    <header className="story-architecture-header">
      <div><strong>架构图</strong><p>这里只展示已经生成的图；完整 4+1 设计与未涉及原因请阅读 Story</p></div>
      <div className="story-architecture-actions">
        <button type="button" onClick={onOpenStory}>阅读完整 Story ↗</button>
        {canUpdate && <button type="button" onClick={() => void updateArchitecture()} disabled={submitting || job.busy}
          aria-label="更新架构图" title="根据当前 Story 生成或更新架构图">{submitting || job.busy ? "更新中…" : "↻"}</button>}
      </div>
    </header>
    {job.busy && <p className="story-architecture-progress" role="status" aria-live="polite">
      <span>{job.detail?.progress || (job.detail?.kind === "architecture" ? "Agent 正在更新架构图" : "Story 正在更新，请稍候")}</span>
      {job.detail?.started_at && Number.isFinite(Date.parse(job.detail.started_at)) && <small aria-live="off">
        已用时 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 60000)} 分 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 1000) % 60} 秒
      </small>}
    </p>}
    {job.errorKind === "architecture" && job.error && <details className="story-architecture-diagnostics story-architecture-error">
      <summary>上次架构图生成未完成 · 查看原因</summary><pre>{job.error}</pre>
    </details>}
    {error ? <div className="story-view-empty story-view-empty-only">
      <span aria-hidden="true">◇</span><strong>架构图暂时无法读取</strong>
      <p>错误只影响架构图展示，可以稍后重试。</p>
      <details className="story-architecture-diagnostics story-architecture-error">
        <summary>查看失败详情</summary><pre>{error}</pre>
      </details>
    </div> : !projection ? <p role="status">正在读取 Story…</p> : <>
      {requestedLine !== undefined && !projection.diagrams.some((item) => item.line === requestedLine) &&
        <p className="story-architecture-warning" role="status">原图位置已变化或图源无法读取，请选择下方图名，或返回 Story 查看。</p>}
      {availableViews.length > 0 ? <>
      <nav className="story-view-coverage" role="tablist" aria-label="已有架构图">
        {availableViews.map((item) => <button type="button" key={item.id} className="story-view-entry"
          id={`story-architecture-tab-${item.id}`} role="tab" aria-selected={item.id === view.id}
          aria-controls={`story-architecture-${taskId}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, "-")}
          title={item.label}
          onClick={() => { setActiveView(item.id); setSelected(""); }}>
          <strong>{storyViewTitles[item.id]}</strong>
          <span>{projection.diagrams.filter((diagram) => diagramView(diagram) === item.id).length} 张</span>
        </button>)}
      </nav>
      {view && <section className="story-view-detail" id={viewPanelId} role="tabpanel"
        aria-labelledby={`story-architecture-tab-${view.id}`} aria-label={view.label}>
        <div className="story-view-detail-heading">
          <div><strong>{storyViewTitles[view.id]}</strong><span>{view.label}{diagrams.length > 0 && ` · ${diagrams.length} 张图`}</span></div>
          <div className="story-view-actions">
            <button type="button" onClick={() => onOpenView ? onOpenView(view.id) : onOpenStory()}>设计与意见 ↗</button>
          </div>
        </div>
        {diagrams.length > 0 && <nav className="story-diagram-tabs" role="tablist" aria-label={`${storyViewTitles[view.id]}的图片`}>
          {diagrams.map((item) => <button type="button" role="tab" key={item.id}
            aria-selected={item.id === diagram?.id} onClick={() => setSelected(item.id)}>{item.title}</button>)}
        </nav>}
        {current?.error ? <div className="story-architecture-failure">
          <p role="status">这张图暂时无法展示。请在完整 Story 中批注反馈；图源修订后会自动更新。</p>
          <button type="button" onClick={onOpenStory}>打开 Story 提意见</button>
          <details><summary>查看失败详情</summary><pre>{current.error}</pre></details>
        </div> : current?.html ? <iframe key={key} ref={frame} title={diagram.title} srcDoc={current.html}
          className={presenting === key ? "is-presenting ui-viewport-layer" : undefined}
          allow="fullscreen *" allowFullScreen sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />
          : <p className="story-view-loading" role="status">正在生成架构图…</p>}
      </section>}</> : <div className="story-view-empty story-view-empty-only">
        <span aria-hidden="true">◇</span><strong>尚无可展示的架构图</strong>
        <p>平台尚未成功生成 Archify 图；完整 PlantUML 设计请在 Story 中查看。</p>
        <button type="button" onClick={onOpenStory}>阅读完整 Story ↗</button>
      </div>}
      {(projection.warnings.length > 0) && <details className="story-architecture-diagnostics"><summary>{projection.warnings.length} 条图源提示</summary>
        {projection.warnings.map((warning, i) => <p className="story-architecture-warning" key={i}>{warning}</p>)}
      </details>}
      <details className="story-architecture-diagnostics"><summary>版本信息</summary>
        <p>版本 {projection.revision.slice(0, 12)} · Archify {projection.renderer.slice(0, 8)}{diagram?.line && ` · Story 第 ${diagram.line} 行`}</p>
      </details>
    </>}
  </section>;
}
