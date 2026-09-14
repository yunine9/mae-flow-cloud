import { useEffect, useRef, useState } from "react";
import { withArchifyPresentation } from "./archifyPresentation";
import { storyViewCoverage, type StoryViewCoverage } from "../../src/storyViewCoverage";
import { storyViewTitles } from "./storyViewTitles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/Empty";

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
export function StoryArchitecture({ taskId, onOpenStory, requestedLine, onOpenView, canUpdate = false, flush = false }: { taskId: string; onOpenStory(): void; requestedLine?: number; onOpenView?(id: string): void; canUpdate?: boolean; /** 任务工作台 chain 视图挂载:去 padding、交出滚动(贴边豁免,滚动归 ws-doc)。 */ flush?: boolean }) {
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
  // 皮(#233 收官):原 story-architecture.css 换装为工具类(按钮/错误盒配方见 btn/errbox)。
  // flush 是 chain 视图的贴边豁免:旧规则 .ws-doc.is-chain > .story-architecture
  // {padding:0;overflow:visible} 的直译——ws-doc 是唯一滚动层,本层不再
  // 自带 20px 留白和内嵌滚动,避免嵌套双滚动(#253)。
  const shell = flush
    ? "flex-1 min-w-0 min-h-0 overflow-visible p-0"
    : "flex-1 min-w-0 min-h-0 overflow-auto p-5 max-[600px]:p-3";
  const btn = "cursor-pointer rounded-[7px] border border-line bg-surface px-3 py-[7px] transition-colors hover:border-primary hover:text-primary";
  const errbox = "w-full rounded-lg border border-attention/30 bg-attention/5 p-2.5 text-left [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-attention [&_summary]:[overflow-wrap:anywhere] [&_pre]:mt-2.5 [&_pre]:max-h-60 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-[1.65] [&_pre]:text-text";
  return <section className={shell} aria-label="Story 架构图">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><strong className="text-[18px]">架构图</strong><p className="text-xs leading-[1.7] text-muted-foreground">这里只展示已经生成的图；完整 4+1 设计与未涉及原因请阅读 Story</p></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={onOpenStory}>阅读完整 Story ↗</button>
        {canUpdate && <button type="button" className={btn} onClick={() => void updateArchitecture()} disabled={submitting || job.busy}
          aria-label="更新架构图" title="根据当前 Story 生成或更新架构图">{submitting || job.busy ? "更新中…" : "↻"}</button>}
      </div>
    </header>
    {job.busy && <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-[13px] text-muted-foreground" role="status" aria-live="polite">
      <span>{job.detail?.progress || (job.detail?.kind === "architecture" ? "Agent 正在更新架构图" : "Story 正在更新，请稍候")}</span>
      {job.detail?.started_at && Number.isFinite(Date.parse(job.detail.started_at)) && <small aria-live="off">
        已用时 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 60000)} 分 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 1000) % 60} 秒
      </small>}
    </p>}
    {job.errorKind === "architecture" && job.error && <details className={errbox}>
      <summary>上次架构图生成未完成 · 查看原因</summary><pre>{job.error}</pre>
    </details>}
    {error ? <Empty className="min-h-[280px]">
      <EmptyMedia className="text-3xl font-light text-muted-foreground">◇</EmptyMedia>
      <EmptyTitle>架构图暂时无法读取</EmptyTitle>
      <EmptyDescription>错误只影响架构图展示，可以稍后重试。</EmptyDescription>
      <EmptyContent><details className={errbox + " mt-3"}>
        <summary>查看失败详情</summary><pre>{error}</pre>
      </details></EmptyContent>
    </Empty> : !projection ? <p role="status">正在读取 Story…</p> : <>
      {requestedLine !== undefined && !projection.diagrams.some((item) => item.line === requestedLine) &&
        <p className="text-xs text-attention [overflow-wrap:anywhere]" role="status">原图位置已变化或图源无法读取，请选择下方图名，或返回 Story 查看。</p>}
      {availableViews.length > 0 ? <>
      {/* (#210)两套手搓 role=tablist 换 base-ui Tabs 原语:视角页签
          (story-view-coverage)与图页签(diagram)嵌套两层,键盘箭头、
          roving tabindex 归原语;选中态由 aria-selected 驱动的旧皮肤
          CSS 原样生效,计数/标题文案原样。外层面板由原手写
          role=tabpanel 的 section 换成 TabsPanel(同位复用,值跟随
          当前视角,内容随派生状态重渲染,iframe 仍由 key 控制重挂)。 */}
      <Tabs value={view?.id ?? null} className="contents"
        onValueChange={(value) => { setActiveView(String(value)); setSelected(""); }}>
        <TabsList variant="line" aria-label="已有架构图"
          className="mt-5 grid h-auto w-full grid-cols-[repeat(auto-fit,minmax(160px,1fr))] justify-start gap-0 border-b border-line p-0">
          {availableViews.map((item) => <TabsTrigger key={item.id} value={item.id}
            className="grid h-auto min-w-0 justify-items-start gap-[5px] rounded-none border-0 border-b-2 border-transparent bg-transparent px-2.5 pb-3.5 pt-3 text-left after:hidden aria-selected:border-primary aria-selected:bg-surface-soft"
            title={item.label}>
            <strong className="text-sm leading-normal text-text [text-wrap:balance]">{storyViewTitles[item.id]}</strong>
            <span className="text-[11px] text-muted-foreground">{projection.diagrams.filter((diagram) => diagramView(diagram) === item.id).length} 张</span>
          </TabsTrigger>)}
        </TabsList>
        {view && <TabsContent value={view.id} className="pt-[18px]"
          aria-label={view.label}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5"><strong className="text-[15px]">{storyViewTitles[view.id]}</strong><span className="text-[11px] text-muted-foreground">{view.label}{diagrams.length > 0 && ` · ${diagrams.length} 张图`}</span></div>
            <div className="flex flex-wrap gap-3.5">
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-primary hover:underline" onClick={() => onOpenView ? onOpenView(view.id) : onOpenStory()}>设计与意见 ↗</button>
            </div>
          </div>
          {diagrams.length > 0 && <Tabs value={diagram?.id ?? null} className="contents"
            onValueChange={(value) => { if (value !== null) setSelected(String(value)); }}>
            <TabsList aria-label={`${storyViewTitles[view.id]}的图片`}
              className="mb-3 h-auto w-full justify-start gap-1.5 overflow-x-auto rounded-lg border border-border bg-muted/60 p-1">
              {diagrams.map((item) => <TabsTrigger key={item.id} value={item.id}
                className="h-auto flex-none px-3 py-1.5 text-xs">{item.title}</TabsTrigger>)}
            </TabsList>
          </Tabs>}
          {current?.error ? <div className="rounded-[10px] border border-line p-4 leading-[1.7] [&_details]:mt-3 [&_summary]:cursor-pointer [&_summary]:text-muted-foreground [&_pre]:max-h-70 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:text-xs [overflow-wrap:anywhere]">
            <p role="status">这张图暂时无法展示。请在完整 Story 中批注反馈；图源修订后会自动更新。</p>
            <button type="button" className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-primary hover:underline" onClick={onOpenStory}>打开 Story 提意见</button>
            <details><summary>查看失败详情</summary><pre>{current.error}</pre></details>
          </div> : current?.html ? <iframe key={key} ref={frame} title={diagram.title} srcDoc={current.html}
            className={presenting === key
              ? "fixed inset-0 z-(--z-modal) h-dvh w-screen max-w-none rounded-none border-0 bg-[#101620]"
              : "block h-[max(560px,65vh)] w-full rounded-[10px] border border-line bg-[#101620] max-[600px]:h-[65vh] max-[600px]:min-h-[460px]"}
            allow="fullscreen *" allowFullScreen sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />
            : <p className="grid min-h-80 place-items-center text-[13px] text-muted-foreground" role="status">正在生成架构图…</p>}
        </TabsContent>}
      </Tabs></> : <Empty className="min-h-[280px]">
        <EmptyMedia className="text-3xl font-light text-muted-foreground">◇</EmptyMedia>
        <EmptyTitle>尚无可展示的架构图</EmptyTitle>
        <EmptyDescription>平台尚未成功生成 Archify 图；完整 PlantUML 设计请在 Story 中查看。</EmptyDescription>
        <EmptyContent><button type="button" onClick={onOpenStory}>阅读完整 Story ↗</button></EmptyContent>
      </Empty>}
      {(projection.warnings.length > 0) && <details className="mt-3 text-[11px] text-muted-foreground [&_summary]:cursor-pointer"><summary>{projection.warnings.length} 条图源提示</summary>
        {projection.warnings.map((warning, i) => <p className="text-xs text-attention [overflow-wrap:anywhere]" key={i}>{warning}</p>)}
      </details>}
      <details className="mt-3 text-[11px] text-muted-foreground [&_summary]:cursor-pointer"><summary>版本信息</summary>
        <p>版本 {projection.revision.slice(0, 12)} · Archify {projection.renderer.slice(0, 8)}{diagram?.line && ` · Story 第 ${diagram.line} 行`}</p>
      </details>
    </>}
  </section>;
}
