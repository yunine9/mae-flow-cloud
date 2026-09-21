import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { KNOWLEDGE_LANGUAGE_OPTIONS, knowledgeLanguageLabel } from "./KnowledgeLanguages";
import {
  componentRequest,
  type ComponentRepository,
  type ComponentResearchRecord,
} from "./componentResearchApi";
import { getBusinessModules, type BusinessModule } from "./api";
import { Markdown } from "./markdown";
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-2">
      {label}
      <Select
        value={value}
        items={items}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function ComponentResearch({
  open,
  focused = false,
  onClose,
  onAdopt,
}: {
  open: boolean;
  focused?: boolean;
  onClose: () => void;
  onAdopt: (id: string) => void;
}) {
  const [components, setComponents] = useState<ComponentRepository[]>([]),
    [records, setRecords] = useState<ComponentResearchRecord[]>([]),
    [modules, setModules] = useState<BusinessModule[]>([]);
  const [language, setLanguage] = useState(""), [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"all" | "topic">("all");
  const [selected, setSelected] = useState(
      new URLSearchParams(location.search).get("componentResearch") ?? "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(""),
    [title, setTitle] = useState(""),
    [editing, setEditing] = useState(false),
    [scope, setScope] = useState("platform"),
    [module, setModule] = useState(""),
    [repos, setRepos] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [componentsLoaded, setComponentsLoaded] = useState(false);
  const [detail, setDetail] = useState<ComponentResearchRecord>();
  const current = detail?.id === selected ? detail : undefined;
  const matchingComponents = components.filter(c => c.enabled && c.languages.includes(language));
  const load = async () => {
    const result = await componentRequest<{
      records: ComponentResearchRecord[];
    }>("/component-research");
    setRecords(result.records);
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<{
          records: ComponentResearchRecord[];
        }>("/component-research");
        if (active) setRecords(result.records);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    void componentRequest<{ components: ComponentRepository[] }>(
      "/component-repositories",
    )
      .then((r) => {
        if (active) { setComponents(r.components); setComponentsLoaded(true); }
      })
      .catch((e) => setError(e.message));
    void getBusinessModules()
      .then((r) => {
        if (active) setModules(r.modules);
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !selected || ["new", "history"].includes(selected)) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<ComponentResearchRecord>(
          `/component-research/${encodeURIComponent(selected)}`,
        );
        if (active) setDetail(result);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, selected]);
  useEffect(() => {
    setDraft(current?.draft ?? "");
    setTitle(
      current
        ? `${knowledgeLanguageLabel(current.language)} · ${current.topic}`.slice(0, 160)
        : "",
    );
    setEditing(false);
    setScope("platform");
    setModule("");
    setRepos("");
  }, [selected, current?.draft]);
  function selectRecord(id: string) {
    setSelected(id);
    const url = new URL(location.href);
    url.searchParams.set("componentResearch", id);
    history.replaceState(history.state, "", url);
  }
  async function start() {
    setBusy(true);
    setError("");
    try {
      const r = await componentRequest<ComponentResearchRecord>(
        "/component-research",
        { language, mode, ...(mode === "topic" ? { topic } : {}) },
      );
      await load();
      setDetail(r);
      selectRecord(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function manage(action: "stop" | "delete" | "retry") {
    if (!current) return;
    setBusy(true); setError("");
    try {
      const result = await componentRequest<ComponentResearchRecord>(`/component-research/${current.id}/${action}`, {});
      if (action === "delete") { setDeleting(false); setDetail(undefined); selectRecord("history"); }
      else { setDetail(result); selectRecord(result.id); }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="tw-root flex min-h-[620px] h-[calc(100vh-230px)] flex-col gap-5 rounded-xl border border-line bg-surface p-6" aria-label="源码萃取工作区">
        <header className="flex items-center gap-4 border-b border-line pb-4">
          <Button variant="outline" onClick={onClose}>{focused ? "← 返回文档" : "← 返回知识库"}</Button>
          <h2 className="text-xl font-semibold">{focused ? "本篇文档的萃取过程" : "萃取任务"}</h2>
          {!focused && <span className="text-muted-foreground">离开页面后仍会继续，可随时回来查看</span>}
          {!focused && <>
            <Button
              className="ml-auto shrink-0"
              onClick={() => {
                selectRecord("new");
                setError("");
              }}
            >
              ＋ 新建萃取任务
            </Button>
          </>}
        </header>
        <div className={`grid ${focused ? "grid-cols-1" : "grid-cols-[minmax(280px,28%)_minmax(0,1fr)]"} min-h-0 flex-1 gap-5`}>
          {!focused && <aside className="overflow-auto border-r border-line pr-4">
            <Choice label="任务状态" value={statusFilter} onChange={setStatusFilter} items={[{value:"all",label:"全部任务"},{value:"active",label:"进行中"},{value:"done",label:"已完成"},{value:"failed",label:"失败"},{value:"cancelled",label:"已停止"}]} />
            {records.filter(r => statusFilter === "all" || (statusFilter === "active" ? ["queued", "running"].includes(r.status) : r.status === statusFilter)).map((r) => (
              <button
                key={r.id}
                className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === r.id ? "border-primary bg-primary/5" : "border-line"}`}
                onClick={() => {
                  setDetail(undefined);
                  selectRecord(r.id);
                  setError("");
                }}
              >
                <strong className="block">{r.topic}</strong>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {knowledgeLanguageLabel(r.language)} · {r.components?.length ?? 1} 个组件仓
                </span>
                <span className="mt-1 block text-sm">{r.stage}</span><time className="mt-1 block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</time>
              </button>
            ))}
            {!records.length && (
              <p className="text-muted-foreground">暂无萃取记录</p>
            )}
          </aside>}
          <main className="min-w-0 overflow-auto pr-2 text-base">
            {error && (
              <p role="alert" className="mb-3 text-danger">
                {error}
              </p>
            )}
            {!selected || selected === "history" ? <div className="p-8 text-muted-foreground">选择一条萃取记录查看进度与草稿，或发起新的萃取。</div> : selected !== "new" && !current ? <p className="p-8" role="status">正在加载萃取记录…</p> : !current ? (
              <p className="p-8 text-muted-foreground">在左侧选择任务，查看进度、来源证据和草稿。</p>
            ) : (
              <>
                <header className="mb-5">
                  {current.parent_id && <Button variant="link" className="mb-3 px-0" onClick={() => selectRecord(current.parent_id!)}>← 返回全部组件进度</Button>}
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="flex-1 text-xl font-semibold">{current.topic}</h2>
                    {!focused && ["done", "failed", "cancelled"].includes(current.status) && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void manage("retry")}
                      >
                        {current.mode === "all" && current.status !== "done" ? "重试未完成组件" : current.status === "failed" ? "失败重试" : current.status === "cancelled" ? "重新启动" : "重新萃取"}
                      </Button>
                    )}
                    {!focused && ["queued", "running"].includes(current.status) && <Button variant="outline" disabled={busy} onClick={() => void manage("stop")}>停止任务</Button>}
                    {!focused && !current.parent_id && <Button variant="outline" disabled={busy} onClick={() => setDeleting(true)}>删除任务</Button>}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {current.components?.length ?? 1} 个组件仓 ·{" "}
                    {knowledgeLanguageLabel(current.language)} ·{" "}
                    {current.operator}
                  </p>
                  <p className="mt-3 font-medium text-primary">
                    {current.stage}
                  </p>
                  {current.error && (
                    <p role="alert" className="mt-3 text-danger">
                      {current.error}
                    </p>
                  )}
                </header>
                {current.mode === "all" && current.progress && <section aria-label="全部组件萃取进度" className="mb-5 space-y-5">
                  <div className="rounded-xl border border-line bg-surface-2 p-5">
                    <div className="flex items-center justify-between gap-3"><strong>组件草稿 {current.progress.done} / {current.progress.total}</strong><span className="text-muted-foreground">已采纳 {current.progress.adopted} 篇</span></div>
                    <div role="progressbar" aria-label="组件完成进度" aria-valuemin={0} aria-valuemax={current.progress.total} aria-valuenow={current.progress.done} className="mt-4 h-2 overflow-hidden rounded-full bg-primary/10"><div className="h-full rounded-full bg-primary transition-all" style={{width:`${100 * current.progress.done / (current.progress.total || 1)}%`}} /></div>
                    <p className="mt-3 text-muted-foreground">{current.progress.running} 个正在萃取 · {current.progress.queued} 个排队 · {current.progress.failed} 个失败 · {current.progress.cancelled} 个已停止</p>
                  </div>
                  <p className="text-muted-foreground">自动发现各组件的主要能力，逐个生成开发范式草稿。已完成的可立即审查，失败不影响其他组件。</p>
                  <div className="overflow-hidden rounded-xl border border-line">
                    <table className="w-full text-left"><thead className="bg-surface-2"><tr><th className="px-4 py-3">基础组件</th><th className="px-4 py-3">进度</th><th className="px-4 py-3 text-right">操作</th></tr></thead>
                      <tbody>{current.children?.map(child => <tr key={child.id} className="border-t border-line">
                        <td className="max-w-[320px] px-4 py-4"><strong className="block">{child.component.name}</strong><span className="mt-1 block truncate text-sm text-muted-foreground" title={child.component.repository}>{child.component.path || child.component.repository.split("/").pop()} · {child.component.branch}</span></td>
                        <td className={`px-4 py-4 ${child.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>{child.stage}</td>
                        <td className="px-4 py-4 text-right"><Button variant="outline" onClick={() => selectRecord(child.id)}>{child.status === "done" ? "审查草稿" : "查看过程"}</Button></td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                </section>}
                {current.mode !== "all" && <details open={focused || undefined} className="mb-5 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer font-medium">
                    源码范围与研究记录 · {current.evidence.length} 条记录
                  </summary>
                  {(current.components ?? [current.component]).map(c => <p key={c.id} className="mt-3 break-all text-sm">{c.name} · {c.repository} · {c.branch} · {c.path || "根目录"}<br/>读取版本：{current.revisions?.[c.id] ?? (current.components ? "尚未读取" : current.revision ?? "尚未读取")}</p>)}
                  <ol className="max-h-64 overflow-auto text-sm">
                    {current.evidence.map((e, i) => (
                      <li
                        key={i}
                        className="border-t border-line py-2 break-all"
                      >
                        {String(e.at ?? "")} ·{" "}
                        {e.tool === "research_note" ? "研究说明" : e.tool === "code_search" ? "跨仓检索" : "组件源码"} /{" "}
                        {String(e.action ?? "")}
                        <br />
                        {String(e.query ?? e.path ?? "")}{" "}
                        {String(e.repository ?? "")}{" "}
                        {e.tool === "research_note" ? "" : e.status === "failed"
                          ? `失败：${e.error}`
                          : `返回 ${e.characters ?? 0} 字符`}
                        {typeof e.preview === "string" && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-primary">
                              查看返回片段
                            </summary>
                            <pre className="mt-2 whitespace-pre-wrap rounded bg-surface-2 p-3">
                              {e.preview}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>}
                {current.draft && (
                  <>
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold">
                        {current.document_id
                          ? "原始萃取草稿"
                          : "知识草稿 · 待人工审查"}
                      </h3>
                      <Button
                        variant="outline"
                        disabled={!!current.document_id}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "预览" : "编辑草稿"}
                      </Button>
                    </div>
                    {editing ? (
                      <Textarea
                        aria-label="知识草稿"
                        className="min-h-[360px] font-mono text-sm"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    ) : (
                      <Markdown text={draft} />
                    )}
                    {current.document_id ? (
                      <Button
                        className="mt-5"
                        onClick={() => onAdopt(current.document_id!)}
                      >
                        查看已采纳知识
                      </Button>
                    ) : (
                      <section className="mt-5 grid gap-4 rounded-lg border border-line bg-surface-2 p-4">
                        <label className="grid gap-2">
                          知识名称
                          <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                        </label>
                        <Choice
                          label="采纳后的适用范围"
                          value={scope}
                          onChange={setScope}
                          items={[
                            { value: "platform", label: "平台通用" },
                            { value: "module", label: "业务模块" },
                            { value: "repository", label: "特定代码仓" },
                          ]}
                        />
                        {scope === "module" && (
                          <Choice
                            label="业务模块"
                            value={module}
                            onChange={setModule}
                            items={modules
                              .filter((m) => m.status === "active")
                              .map((m) => ({ value: m.id, label: m.name }))}
                          />
                        )}
                        {scope === "repository" && (
                          <label className="grid gap-2">
                            适用代码仓（每行一个地址）
                            <Textarea
                              value={repos}
                              onChange={(e) => setRepos(e.target.value)}
                            />
                          </label>
                        )}
                        <Button
                          disabled={
                            busy ||
                            !draft.trim() ||
                            !title.trim() ||
                            (scope === "module" && !module) ||
                            (scope === "repository" && !repos.trim())
                          }
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              const doc = await componentRequest<{
                                id: string;
                              }>(`/component-research/${current.id}/adopt`, {
                                title,
                                content: draft,
                                scope,
                                module_ids: module ? [module] : [],
                                repositories: repos
                                  .split("\n")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              });
                              await load();
                              onAdopt(doc.id);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          确认采纳到知识库
                        </Button>
                      </section>
                    )}
                  </>
                )}
              </>
            )}
          </main>
        </div>

      <Dialog open={selected === "new"} onOpenChange={open => { if (!open) selectRecord("history"); }}>
        <DialogContent className="tw-root sm:max-w-[640px] max-h-[85vh] overflow-auto">
          <DialogHeader><DialogTitle>新建萃取任务</DialogTitle></DialogHeader>
          {error && <p role="alert" className="text-danger">{error}</p>}
              <div className="mx-auto grid max-w-2xl gap-5 py-4">
                <h2 className="text-xl font-semibold">
                  从真实源码中提炼开发范式
                </h2>
                <p className="text-muted-foreground">
                  选择语言即可提取全部基础组件的开发范式，主题由 Agent 从源码中发现。
                </p>
                <Choice label="萃取语言" value={language} onChange={setLanguage}
                  items={KNOWLEDGE_LANGUAGE_OPTIONS.filter(l => l.id !== "agnostic").map(l => ({value: l.id, label: l.label}))} />
                <div className="grid grid-cols-2 gap-3" role="group" aria-label="萃取方式">
                  {([['all', '全部基础组件', '自动发现能力与主题，逐个生成草稿'], ['topic', '指定主题', '围绕一个具体问题跨组件研究']] as const).map(([value, label, hint]) => <button type="button" key={value} aria-pressed={mode === value} className={`rounded-xl border p-4 text-left ${mode === value ? "border-primary bg-primary/5" : "border-line"}`} onClick={() => setMode(value)}><strong className="block">{label}</strong><span className="mt-2 block text-sm text-muted-foreground">{hint}</span></button>)}
                </div>
                <p className="text-muted-foreground">{!componentsLoaded ? "正在读取组件仓配置…" : language ? matchingComponents.length ? `覆盖 ${matchingComponents.length} 个已启用的 ${knowledgeLanguageLabel(language)} 组件仓${mode === "all" ? "，后台分批执行，可随时查看进度。" : "，按主题识别相关组件。"}` : `尚未配置已启用的 ${knowledgeLanguageLabel(language)} 组件仓，请先到配置中心添加。` : "请选择需要萃取的语言。"}</p>
                <a className="text-primary underline" href="/configuration?tab=components">维护基础组件仓 ↗</a>
                {mode === "topic" && <label className="grid gap-2">
                  研究主题
                  <Textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="例如：文件组件的句柄归属、异常清理及 UT Mock 方式"
                  />
                </label>}
                <Button
                  disabled={busy || !componentsLoaded || !matchingComponents.length || !language || (mode === "topic" && !topic.trim())}
                  onClick={() => void start()}
                >
                  {busy ? "发起中…" : mode === "all" ? "一键萃取全部组件" : "开始后台萃取"}
                </Button>
              </div>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除萃取任务？</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<p>正在执行的任务会停止。已经采纳的知识文档和来源记录会保留。</p><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setDeleting(false)}>取消</Button><Button disabled={busy} onClick={() => void manage("delete")}>确认删除</Button></div></DialogContent></Dialog>
    </section>
  );
}
