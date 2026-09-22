import { KnowledgeConsolidation } from "./KnowledgeConsolidation";
import { KnowledgeExport } from "./KnowledgeExport";
import { ComponentResearch } from "./ComponentResearch";
import { KnowledgeTrial } from "./KnowledgeTrial";
import { KnowledgeRepositoryTree } from "./KnowledgeRepositoryTree";
import { KnowledgeAssetsWorkspace } from "./KnowledgeAssets";
import { BusinessAssetEditor } from "./BusinessModuleLibrary";
import { Markdown } from "./markdown";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { FileText, Blocks, Search, Upload, RefreshCw, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getBusinessModules, productVersionRequest, type BusinessModule } from "./api";
import { documentRequest, type KnowledgeDocument } from "./knowledgeDocumentsApi";
import { KNOWLEDGE_LANGUAGE_OPTIONS, knowledgeLanguageLabel } from "./KnowledgeLanguages";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { KnowledgeAssetFocus } from "./knowledgeNavigation";
const labels: Record<string, string> = { native: "按需加载", source: "原始资料", queued: "等待索引", indexing: "建立索引", ready: "可检索", failed: "索引失败", disabled: "已停用" };
const scopeLabel = (doc: KnowledgeDocument, modules: BusinessModule[]) => doc.scope_label || (doc.scope === "module"
  ? `业务模块：${doc.module_ids.map(id=>modules.find(m=>m.id===id)?.name ?? id).join("、")}`
  : doc.scope === "repository" ? `代码仓：${doc.repositories.join("、")}` : "平台通用");
const repositoryLabel = (source: NonNullable<KnowledgeDocument["source"]>) => {
  try { const url=new URL(source.repository);return `${url.host}${url.pathname.replace(/\.git$/, "")} · ${source.branch}`; }
  catch { return `${source.repository} · ${source.branch}`; }
};
const languageLabel = knowledgeLanguageLabel;
export function KnowledgeDocuments({ onManage, onOpenTask, uploadRequest = 0, category, onCategoryChange, onResearch, selectedDocument }: { selectedDocument?: string; onResearch?: (id: string, documentId?: string) => void; category: "documents" | "skills"; onCategoryChange: (category: "documents" | "skills") => void; uploadRequest?: number; onOpenTask: (taskId: string) => void; onManage: (focus?: KnowledgeAssetFocus) => void }) {
  const [consolidationOpen,setConsolidationOpen]=useState(new URLSearchParams(location.search).has("knowledgeConsolidation"));
  const [researchOpen,setResearchOpen]=useState(!onResearch && new URLSearchParams(location.search).has("componentResearch"));
  const [researchDocument, setResearchDocument] = useState(new URLSearchParams(location.search).get("researchDocument") ?? "");
  const [addOpen, setAddOpen] = useState(false);
  const [importSource, setImportSource] = useState("upload");
  const [nativeUpload, setNativeUpload] = useState(false);
  const [editingExternal, setEditingExternal] = useState(false);
  const [rows, setRows] = useState<KnowledgeDocument[]>([]), [selected, setSelected] = useState("");
  useEffect(() => { if (selectedDocument) { setSelected(selectedDocument); void refresh().catch(e => setError(e.message)); } }, [selectedDocument]);
  const [doc, setDoc] = useState<KnowledgeDocument>(), [error, setError] = useState("");
  const [filter, setFilter] = useState("all"), [term, setTerm] = useState("");
  const [tab, setTab] = useState("content"), [trialOpen, setTrialOpen] = useState(false);
  const [busy, setBusy] = useState(false), [form, setForm] = useState<"upload" | "edit" | "replace">();
  const lastUploadRequest = useRef(uploadRequest);
  useEffect(() => {
    if (uploadRequest !== lastUploadRequest.current) {
      lastUploadRequest.current = uploadRequest;
      if (category === "skills") setNativeUpload(true);
      else setAddOpen(true);
    }
  }, [uploadRequest]);
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const request = useRef(0), selectedRef = useRef(selected); selectedRef.current = selected;
  async function refresh() {
    const result = await documentRequest<{ documents: KnowledgeDocument[] }>();
    setRows(result.documents);
  }
  useEffect(() => {
    let live = true;
    const load = () => { if (live) void refresh().catch(e => { if (live) setError(e.message); }); };
    load(); void getBusinessModules().then(r => { if (live) setModules(r.modules); }).catch(e => setError(e.message));
    const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const version = ++request.current;
    setDoc(undefined);  setError(""); setEditingExternal(false); setNativeUpload(false);
    if (selected) void documentRequest<KnowledgeDocument>(`/${encodeURIComponent(selected)}`).then(value => {
      if (request.current === version) { setDoc(value); if (value.form === "skill") setTab("content"); }
    }).catch(e => { if (request.current === version) setError(e.message); });
  }, [selected]);
  useEffect(() => { setNativeUpload(false); setEditingExternal(false); }, [category]);
  const row = rows.find(value => value.id === selected), status = row?.indexing;
  const visible = rows.filter(r => (filter === "all" || r.scope === filter) && (category === "skills" ? r.form === "skill" : r.form !== "skill") && `${r.title} ${r.source?.path ?? ""} ${r.source?.repository ?? ""}`.toLowerCase().includes(term.toLowerCase()));
  useEffect(() => {
    setSelected(id => visible.some(item => item.id === id) ? id : visible[0]?.id || "");
  }, [rows, category, filter, term]);
  async function update(body: unknown) {
    const id = selected; setBusy(true); setError("");
    try {
      const saved = await documentRequest<KnowledgeDocument>(`/${encodeURIComponent(id)}`, body);
      if (selectedRef.current === id) { setDoc(saved);  }
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function openResearch(id: string, documentId = "") {
    if (onResearch) { onResearch(id, documentId); return; }
    setResearchDocument(documentId);
    const url = new URL(location.href);
    url.searchParams.set("componentResearch", id);
    if (documentId) url.searchParams.set("researchDocument", documentId);
    else url.searchParams.delete("researchDocument");
    url.searchParams.delete("component");
    history.replaceState(history.state, "", url);
    setAddOpen(false); setResearchOpen(true);
  }
  function openConsolidation(id="history") {const url=new URL(location.href);url.searchParams.set("knowledgeConsolidation",id);history.replaceState(history.state,"",url);setConsolidationOpen(true);}
  if(consolidationOpen)return <KnowledgeConsolidation onClose={()=>{const url=new URL(location.href);url.searchParams.delete("knowledgeConsolidation");history.replaceState(history.state,"",url);setConsolidationOpen(false);void refresh();}}/>;
  if (researchOpen && !addOpen) return <><ComponentResearch focused={!!researchDocument} open={researchOpen} onClose={()=>{if(researchDocument) setSelected(researchDocument);setResearchOpen(false);const url=new URL(location.href);url.searchParams.delete("componentResearch");url.searchParams.delete("researchDocument");url.searchParams.delete("component");history.replaceState(history.state,"",url);}} onAdopt={id=>{const url=new URL(location.href);url.searchParams.delete("componentResearch");url.searchParams.delete("researchDocument");url.searchParams.delete("component");history.replaceState(history.state,"",url);setResearchOpen(false);onCategoryChange("documents");setFilter("all");setTerm("");void refresh();setSelected(id);}} /></>;
  return <div className="knowledge-documents">
    <nav className="tw-root flex items-center gap-3 border-b border-line px-5 py-3" aria-label="知识与萃取"><strong>知识文档</strong><Button variant="outline" onClick={() => openResearch("history")}>萃取任务 · 进度与管理 →</Button><Button variant="outline" onClick={()=>openConsolidation()}>知识整理 →</Button></nav>
    <header className="kd-toolbar">
      <div className="kd-search-input"><Search size={19} /><Input aria-label="搜索文档" placeholder={category === "skills" ? "搜索 Skill 名称" : "搜索文档名称"} value={term} onChange={e => setTerm(e.target.value)} /></div>
      <Select value={filter} onValueChange={v => setFilter(v ?? "all")} items={[{value:"all",label:"所有范围"},{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"代码仓"}]}><SelectTrigger aria-label="知识范围"><SelectValue /></SelectTrigger><SelectContent>{[["all","所有范围"],["platform","平台通用"],["module","业务模块"],["repository","代码仓"]].map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>


      {category === "documents" && <KnowledgeExport documents={rows} />}
      <Button variant="outline" onClick={()=>setTrialOpen(true)}><Search size={18}/>试搜知识</Button>
    </header>
    {error && <div role="alert" className="kd-error">{error}</div>}
    <div className="kd-layout">
      <aside className="kd-library"><nav className="kd-category-tabs" aria-label="知识形式">
        <button type="button" aria-pressed={category === "documents"} onClick={() => onCategoryChange("documents")}><FileText size={18} />文档<span>{rows.filter(r => r.form !== "skill").length}</span></button>
        <button type="button" aria-pressed={category === "skills"} onClick={() => onCategoryChange("skills")}><Blocks size={18} />Skill<span>{rows.filter(r => r.form === "skill").length}</span></button>
      </nav>
        <div className="kd-doc-list">{visible.map(item => <button key={item.id} className={`kd-doc-row ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
          {item.form === "skill" ? <Blocks size={29} className="kd-file-icon" /> : <FileText size={29} className="kd-file-icon" />}<span className="kd-doc-info"><strong title={item.title}>{item.title}</strong>{item.id.startsWith("kg-") && <small>整理专题</small>}{item.research_source && <small>{item.research_source.job_id.startsWith("dkx-") ? "领域知识萃取" : "基础组件萃取"}</small>}{item.source && <><small className="kd-source-path" title={item.source.path}>{item.source.path}</small><small className="kd-source-path" title={`${item.source.repository} · ${item.source.branch}`}>{repositoryLabel(item.source)}</small></>}<small>{scopeLabel(item, modules)}{item.technologies.length ? ` · ${item.technologies.map(languageLabel).join("、")}` : ""}</small></span>
          <span className={`kd-status ${item.indexing?.state}`}>{labels[item.indexing?.state ?? "queued"]}</span>
        </button>)}{!visible.length && <div className="kd-empty">{category === "skills" ? "暂无匹配的 Skill，可通过右上角添加。" : "暂无匹配的文档，可上传手册或从仓库导入。"}</div>}</div>

      </aside>
      <section className="kd-detail">{nativeUpload ? <><Button variant="ghost" onClick={() => setNativeUpload(false)}>← 返回 Skill</Button><KnowledgeAssetsWorkspace key="native-upload" embedded initialUpload onOpenTask={onOpenTask} /></> : doc?.focus?.kind === "skill" ? <KnowledgeAssetsWorkspace key={doc.id} embedded initialAsset={doc.focus} onOpenTask={onOpenTask} /> : editingExternal && doc?.focus ? <><Button variant="ghost" onClick={() => { setEditingExternal(false); void refresh(); }}>← 返回阅读</Button>{doc.focus.kind === "business" ? <BusinessAssetEditor moduleId={doc.focus.moduleId} assetId={doc.focus.assetId} onDone={() => { setEditingExternal(false); void refresh(); void documentRequest<KnowledgeDocument>(`/${encodeURIComponent(doc.id)}`).then(setDoc).catch(e=>setError(e.message)); }} /> : <KnowledgeAssetsWorkspace embedded initialAsset={doc.focus} onOpenTask={onOpenTask} />}</> : !doc ? <div className="kd-empty">{selected ? "正在读取文档…" : category === "skills" ? "选择 Skill，查看说明或维护技能包" : "选择文档，查看内容或试搜知识"}</div> : <>
        <header className="kd-doc-header"><div><h2>{doc.title}</h2>{doc.research_source && <Button variant="link" className="px-0" onClick={() => openResearch(doc.research_source!.job_id, doc.id)}>查看本篇文档的萃取过程 →</Button>}<div className="kd-tags"><span>{scopeLabel(doc, modules)}</span>{doc.technologies.map(v => <span key={v}>{languageLabel(v)}</span>)}<span>{doc.product_versions.join("、") || "所有版本"}</span><span className={`kd-status ${status?.state}`}>{labels[status?.state ?? "queued"]}</span></div></div>
          <div className="kd-actions">{doc.external ? <Button variant="outline" onClick={() => doc.id.startsWith("kg-") ? openConsolidation(doc.id) : doc.focus ? setEditingExternal(true) : onManage() }>{doc.id.startsWith("kg-") ? "查看专题与整理记录" : doc.focus ? "编辑资料" : "审查经验"}</Button> : <><Button variant="outline" onClick={() => setForm("edit")}>编辑适用范围</Button><Button variant="outline" onClick={() => (doc.research_source?.job_id.startsWith("dkx-") || (doc.research_source?.job_id.startsWith("cr-") && doc.source)) ? openResearch(doc.research_source.job_id, doc.id) : setForm("replace")}>{(doc.research_source?.job_id.startsWith("dkx-") || (doc.research_source?.job_id.startsWith("cr-") && doc.source)) ? "修订并更新 MR" : "替换文档"}</Button><DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" aria-label="更多文档操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={busy} onClick={() => void update({ active: !doc.active })}>{doc.active ? "停用文档" : "启用文档"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></>}</div></header>
        {doc.form !== "skill" && <div className="kd-meta">{status?.state === "ready" ? `${status.sections === undefined ? "索引已就绪" : `已整理 ${status.sections} 个章节`} · 原始文档保持不变` : status?.state === "failed" ? status.error : status?.state === "source" ? status.error : status?.state === "disabled" ? "已停用，不再用于 Agent 检索" : "后台正在准备知识索引，可先阅读原文"}
          {status?.state === "failed" && <Button variant="outline" size="sm" onClick={() => void documentRequest(`/${encodeURIComponent(selected)}/retry`, {}).then(refresh).catch(e => setError(e.message))}><RefreshCw size={14} /> 重试</Button>}</div>}
        {doc.source && <div className="kd-source"><span title={doc.source.repository}>来自 {doc.source.repository} · {doc.source.branch} · {doc.source.path} · {doc.source.revision.slice(0, 8)}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => (doc.research_source?.job_id.startsWith("dkx-") || (doc.research_source?.job_id.startsWith("cr-") && doc.source)) ? openResearch(doc.research_source.job_id, doc.id) : void update({ repository_import: doc.source })}>{(doc.research_source?.job_id.startsWith("dkx-") || (doc.research_source?.job_id.startsWith("cr-") && doc.source)) ? "核对归档与更新" : "从仓库更新"}</Button></div>}
        <nav className="kd-tabs">{[["content", doc.form === "skill" ? "Skill 说明" : "阅读文档"], ...(!doc.external ? [["history", "修改记录"]] : [])].map(([key, text]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{text}</button>)}</nav>
        {tab === "content" && <div className="kd-full-content"><Markdown text={doc.content ?? ""} /></div>}
        {tab === "history" && <div className="kd-history">{[...doc.history].reverse().map((entry, i) => <div key={i}><strong>{entry.action}</strong><span>{entry.operator}</span><time>{new Date(entry.at).toLocaleString()}</time></div>)}</div>}
      </>}</section>
    </div>

    <KnowledgeTrial open={trialOpen} onClose={()=>setTrialOpen(false)} onOpenDocument={id=>{setTrialOpen(false);onCategoryChange("documents");setFilter("all");setTerm("");setTab("content");setSelected(id);}} />
    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="tw-root sm:max-w-[640px]"><DialogHeader><DialogTitle>添加知识</DialogTitle></DialogHeader><div className="grid gap-3 py-3">
      {[["upload", "上传文档", "上传已有的 Markdown 手册、规范或组件指南"], ["repository", "从 CodeHub 导入", "浏览仓库，选择文档或文件夹"]].map(([value, title, description]) => <button key={value} type="button" className="rounded-xl border border-line p-5 text-left hover:border-primary hover:bg-primary/5" onClick={() => { if (value === "research") openResearch("new"); else { setImportSource(value); setAddOpen(false); setResearchOpen(false); const url = new URL(location.href); url.searchParams.delete("componentResearch");url.searchParams.delete("researchDocument"); url.searchParams.delete("component"); history.replaceState(history.state,"",url); setForm("upload"); } }}><strong className="block text-lg">{title} →</strong><span className="mt-2 block text-muted-foreground">{description}</span></button>)}
    </div></DialogContent></Dialog>
    {form && <DocumentForm initialSource={importSource} mode={form} doc={form === "upload" ? undefined : doc} modules={modules} onClose={() => setForm(undefined)} onSaved={async saved => { setForm(undefined); await refresh(); setSelected(saved.id); setDoc(saved);  }} />}
  </div>;
}

function DocumentForm({ initialSource = "upload", mode, doc, modules, onClose, onSaved }: { initialSource?: string; mode: string; doc?: KnowledgeDocument; modules: BusinessModule[]; onClose: () => void; onSaved: (doc: KnowledgeDocument) => void }) {
  const [source, setSource] = useState(doc?.source ? "repository" : initialSource), [title, setTitle] = useState(doc?.title ?? "");
  const [content, setContent] = useState<string>(), [filename, setFilename] = useState("");
  const [scope, setScope] = useState(doc?.scope ?? "platform"), [moduleIds, setModuleIds] = useState(doc?.module_ids ?? []);
  const [repositories, setRepositories] = useState(doc?.repositories.join("\n") ?? ""), [language, setLanguage] = useState(doc?.technologies ?? []);
  const [versions, setVersions] = useState(doc?.product_versions ?? []), [when, setWhen] = useState(doc?.when_to_use ?? "");
  const [repo, setRepo] = useState(doc?.source?.repository ?? ""), [branch, setBranch] = useState(doc?.source?.branch ?? "master"), [path, setPath] = useState(doc?.source?.path ?? "");
  const [pickerOpen, setPickerOpen] = useState(false), [pickerChosen, setPickerChosen] = useState<string[]>([]);
  const [tree, setTree] = useState<{revision:string;paths:string[]}>();
  const [chosen, setChosen] = useState<string[]>([]);
  const treeEpoch = useRef(0);
  useEffect(() => { treeEpoch.current++; setTree(undefined); setChosen([]); setPickerOpen(false); }, [repo,branch]);
  async function browse() {
    const epoch = ++treeEpoch.current, previousSelection = pickerOpen ? pickerChosen : chosen;
    setBusy(true); setError(""); setPickerOpen(true);
    try { const result = await documentRequest<{revision:string;paths:string[]}>("/repository-tree",{repository:repo,branch});
      if (epoch === treeEpoch.current) { setTree(result); setPickerChosen(previousSelection.filter(p=>result.paths.includes(p))); if (!result.paths.length) setError("此分支没有可导入的 Markdown 文档（Skill 包单独维护）"); }
    } catch(e) { if(epoch===treeEpoch.current)setError((e as Error).message); } finally {setBusy(false);}
  }
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [versionOptions, setVersionOptions] = useState<string[]>(doc?.product_versions ?? []);
  useEffect(() => { void productVersionRequest().then(r => setVersionOptions([...new Set([...(doc?.product_versions ?? []), ...r.versions.map(v => v.version)])])).catch(e => setError(e.message)); }, []);
  const split = (text: string) => text.split(/[,，\n]/).map(v => v.trim()).filter(Boolean);
  async function save() {
    setBusy(true); setError("");
    try {
      if (mode !== "edit" && source === "upload" && content === undefined) throw new Error("请选择 Markdown 文件");
      const body = { title, scope, module_ids: moduleIds, repositories: split(repositories), technologies: language, product_versions: versions, when_to_use: when,
        ...(mode === "edit" ? {} : source === "repository" ? { repository_import: { repository: repo, branch, path } } : { content }) };
      if (mode === "upload" && source === "repository") {
        if (!tree || !chosen.length) throw new Error("请读取文件树并勾选文档或文件夹");
        if (chosen.length > 200) throw new Error("每批最多导入 200 篇，请分批选择");
        const result = await documentRequest<{documents:KnowledgeDocument[];errors:Array<{path:string;error:string}>}>("/repository-import",{
          ...body,repository:repo,branch,revision:tree.revision,paths:chosen,
        });
        if (result.errors.length) { setChosen(result.errors.map(e=>e.path)); setError(`已导入 ${result.documents.length} 篇；以下文件未导入：\n${result.errors.map(e=>`${e.path}：${e.error}`).join("\n")}`); }
        else if(result.documents[0]) onSaved(result.documents[0]);
        return;
      }
      onSaved(await documentRequest<KnowledgeDocument>(doc ? `/${encodeURIComponent(doc.id)}` : "", body));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="kd-upload-dialog"><DialogHeader><DialogTitle>{mode === "edit" ? "编辑适用范围" : mode === "replace" ? "替换文档" : "上传知识"}</DialogTitle></DialogHeader>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      {mode !== "edit" && <><nav className="kd-source-tabs"><button type="button" className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}>直接上传</button><button type="button" className={source === "repository" ? "active" : ""} onClick={() => setSource("repository")}>从 CodeHub 仓库导入</button></nav>
        {source === "upload" ? <label className="kd-dropzone"><Upload size={25} /><strong>{filename || "选择 Markdown 文档"}</strong><span>UTF-8 · .md · 最大 2 MiB</span><input aria-label="选择 Markdown 文档" type="file" accept=".md,text/markdown" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { if (file.name.toLowerCase() === "skill.md") throw new Error("Skill 请在 Skill 页签上传完整技能包，不作为知识文档导入"); if (file.size > 2 * 1024 * 1024 || !/\.md$/i.test(file.name)) throw new Error("请选择 2 MiB 以内的 Markdown 文件"); const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); setContent(text); setFilename(file.name); if (!doc) setTitle(file.name); setError(""); } catch (e) { setContent(undefined); setFilename(""); setError((e as Error).message); } }} /></label>
          : <div className="kd-repo-fields"><label>CodeHub 仓库地址<Input required value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://codehub.example.com/team/repo.git" /></label><label>分支<Input required value={branch} onChange={e => setBranch(e.target.value)} /></label>
            {mode === "replace" ? <label>仓内文件路径<Input required value={path} onChange={e=>setPath(e.target.value)} /></label> : <><Button type="button" variant="outline" disabled={busy || !repo.trim() || !branch.trim()} onClick={()=>{if(tree){setPickerChosen(chosen);setPickerOpen(true);}else void browse();}}>{busy ? "正在读取…" : chosen.length ? `已选 ${chosen.length} 篇 · 全屏浏览` : "全屏浏览仓库"}</Button></>}
            <small>勾选文件夹会选中其中全部 Markdown 文档。保留完整路径，同名文件分别保存；Skill 包不导入。每批最多 200 篇。</small></div>}</>}

      {!(mode === "upload" && source === "repository") && <label>文档名称<Input required value={title} onChange={e => setTitle(e.target.value)} /></label>}
      <label>适用范围<Select value={scope} onValueChange={value => setScope(value ?? "platform")} items={[{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"特定代码仓"}]}><SelectTrigger aria-label="适用范围" className="w-full h-10! text-base"><SelectValue /></SelectTrigger><SelectContent>{[["platform","平台通用"],["module","业务模块"],["repository","特定代码仓"]].map(([key,text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></label>
      {scope === "module" && <div><DocumentMultiSelect label="业务模块" value={moduleIds} onChange={setModuleIds} options={modules.filter(m => m.status === "active").map(m => ({value:m.id,label:m.name}))} placeholder="选择业务模块（可多选）" />{!modules.some(m => m.status === "active") && <a href="/configuration?tab=modules" target="_blank" rel="noreferrer">去配置中心新建模块 ↗</a>}</div>}
      {scope === "repository" && <label>适用仓库地址（每行一个）<textarea required rows={2} value={repositories} onChange={e => setRepositories(e.target.value)} /></label>}
      <div className="kd-form-two"><DocumentMultiSelect label="适用语言（可多选）" value={language} onChange={values => setLanguage(values.includes("agnostic") && !language.includes("agnostic") ? ["agnostic"] : values.filter(v => v !== "agnostic"))} options={KNOWLEDGE_LANGUAGE_OPTIONS.map(v => ({value:v.id,label:v.label}))} placeholder="选择适用语言" /><DocumentMultiSelect label="产品版本（可多选）" value={versions} onChange={setVersions} options={versionOptions.map(v => ({value:v,label:v}))} placeholder="所有版本" /></div>
      <label>什么时候使用（可选）<Input value={when} onChange={e => setWhen(e.target.value)} placeholder="如：创建、读写或关闭文件时" /></label>
      {error && <p role="alert" className="kd-error">{error}</p>}
      <footer><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? source === "repository" && mode !== "edit" ? "正在读取仓库文件…" : "保存中…" : mode === "edit" ? "保存" : "保存并整理"}</Button></footer>
    </form>
  </DialogContent></Dialog>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}><DialogContent className="kd-repository-picker">
      <DialogHeader className="kd-picker-header"><DialogTitle>选择知识文档</DialogTitle><p title={`${repo} · ${branch}`}>{repo} · {branch}</p></DialogHeader>
      <div className="kd-picker-body"><section className="kd-picker-files">{tree ? <KnowledgeRepositoryTree paths={tree.paths} selected={pickerChosen} onChange={setPickerChosen}/> : <p>{busy ? "正在读取仓库目录…" : "暂未读取到目录"}</p>}</section>
        <aside className="kd-picker-selection"><strong>已选文档 · {pickerChosen.length}</strong><p>文件夹勾选包含所有下级文档</p><div>{pickerChosen.length ? pickerChosen.map(path=><div className="kd-picker-selected-file" key={path}><span title={path}>{path}</span><Button type="button" variant="ghost" size="sm" aria-label={`移除 ${path}`} onClick={()=>setPickerChosen(pickerChosen.filter(p=>p!==path))}>移除</Button></div>) : <p>从左侧勾选文件或文件夹</p>}</div></aside></div>
      {error && <p role="alert" className="kd-error kd-picker-error">{error}</p>}
      <footer className="kd-picker-footer"><span>每批最多 200 篇 · 保留仓内相对路径 · Skill 包单独维护</span><Button type="button" variant="outline" disabled={busy} onClick={()=>void browse()}>刷新目录</Button><Button type="button" variant="outline" onClick={()=>setPickerOpen(false)}>返回</Button><Button type="button" disabled={busy || !pickerChosen.length || pickerChosen.length>200} onClick={()=>{setChosen(pickerChosen);setPickerOpen(false);}}>确认选择 {pickerChosen.length} 篇</Button></footer>
    </DialogContent></Dialog></>;
}

function DocumentMultiSelect({label,value,onChange,options,placeholder}:{label:string;value:string[];onChange:(value:string[])=>void;options:Array<{value:string;label:string}>;placeholder:string}) {
 return <label>{label}<Select multiple value={value} onValueChange={onChange} items={options}><SelectTrigger aria-label={label} className="w-full h-10! text-base"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.length ? options.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>) : <div className="p-3 text-muted-foreground">暂无选项，请先在配置中心维护</div>}</SelectContent></Select></label>;
}
