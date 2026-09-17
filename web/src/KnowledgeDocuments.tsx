import { Markdown } from "./markdown";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { FileText, Search, Upload, RefreshCw, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getBusinessModules, productVersionRequest, type BusinessModule } from "./api";
import { documentRequest, type KnowledgeDocument, type TrialResult, type ChapterHit } from "./knowledgeDocumentsApi";
import { KNOWLEDGE_LANGUAGE_OPTIONS, knowledgeLanguageLabel } from "./KnowledgeLanguages";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { KnowledgeAssetFocus } from "./knowledgeNavigation";
const labels: Record<string, string> = { queued: "等待整理", indexing: "正在整理", ready: "可检索", failed: "整理失败", disabled: "已停用" };
const scopeLabel = (doc: KnowledgeDocument) => doc.scope_label || ({ platform: "平台通用", module: "业务模块", repository: "代码仓" })[doc.scope];
const languageLabel = knowledgeLanguageLabel;
export function KnowledgeDocuments({ onManage, uploadRequest = 0 }: { uploadRequest?: number; onManage: (focus?: KnowledgeAssetFocus) => void }) {
  const [rows, setRows] = useState<KnowledgeDocument[]>([]), [selected, setSelected] = useState("");
  const [doc, setDoc] = useState<KnowledgeDocument>(), [error, setError] = useState("");
  const [kind, setKind] = useState("all");
  const [filter, setFilter] = useState("all"), [term, setTerm] = useState("");
  const [tab, setTab] = useState("content"), [query, setQuery] = useState("");
  const [trial, setTrial] = useState<TrialResult>(), [hit, setHit] = useState<ChapterHit>();
  const [busy, setBusy] = useState(false), [form, setForm] = useState<"upload" | "edit" | "replace">();
  const lastUploadRequest = useRef(uploadRequest);
  useEffect(() => {
    if (uploadRequest !== lastUploadRequest.current) { setForm("upload"); lastUploadRequest.current = uploadRequest; }
  }, [uploadRequest]);
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const request = useRef(0), selectedRef = useRef(selected); selectedRef.current = selected;
  async function refresh() {
    const result = await documentRequest<{ documents: KnowledgeDocument[] }>();
    setRows(result.documents); setSelected(id => id || result.documents[0]?.id || "");
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
    setDoc(undefined); setTrial(undefined); setHit(undefined); setError("");
    if (selected) void documentRequest<KnowledgeDocument>(`/${encodeURIComponent(selected)}`).then(value => {
      if (request.current === version) setDoc(value);
    }).catch(e => { if (request.current === version) setError(e.message); });
  }, [selected]);
  const row = rows.find(value => value.id === selected), status = row?.indexing;
  const visible = rows.filter(r => (filter === "all" || r.scope === filter) && (kind === "all" || r.form === kind) && r.title.toLowerCase().includes(term.toLowerCase()));
  async function search() {
    if (!selected || !query.trim()) return;
    const version = ++request.current;
    setBusy(true); setError(""); setTrial(undefined); setHit(undefined);
    try {
      const result = await documentRequest<TrialResult>(`/${encodeURIComponent(selected)}/search`, { query });
      if (version === request.current) {
        const current = await documentRequest<KnowledgeDocument>(`/${encodeURIComponent(selected)}`);
        if (version !== request.current) return;
        setDoc(current); setTrial(result); setHit(result.hits.find(h => h.revision === current.revision));
      }
    } catch (e) { if (version === request.current) setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function update(body: unknown) {
    const id = selected; setBusy(true); setError("");
    try {
      const saved = await documentRequest<KnowledgeDocument>(`/${encodeURIComponent(id)}`, body);
      if (selectedRef.current === id) { setDoc(saved); setTrial(undefined); setHit(undefined); }
      await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const lines = doc?.content?.split("\n") ?? [];
  const validHit = hit?.revision === doc?.revision ? hit : undefined;
  return <div className="knowledge-documents">
    <header className="kd-toolbar">
      <div className="kd-search-input"><Search size={19} /><Input aria-label="搜索文档" placeholder="搜索知识名称" value={term} onChange={e => setTerm(e.target.value)} /></div>
      <Select value={filter} onValueChange={v => setFilter(v ?? "all")} items={[{value:"all",label:"所有范围"},{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"代码仓"}]}><SelectTrigger aria-label="知识范围"><SelectValue /></SelectTrigger><SelectContent>{[["all","所有范围"],["platform","平台通用"],["module","业务模块"],["repository","代码仓"]].map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
        <Select value={kind} onValueChange={value => setKind(value ?? "all")} items={[{value:"all",label:"全部类型"},{value:"document",label:"文档"},{value:"skill",label:"Skill"},{value:"rule",label:"规则"},{value:"example",label:"示例"},{value:"experience",label:"已采纳经验"}]}><SelectTrigger aria-label="知识类型" className="kd-type-select"><SelectValue /></SelectTrigger><SelectContent>{[["all","全部类型"],["document","文档"],["skill","Skill"],["rule","规则"],["example","示例"],["experience","已采纳经验"]].map(([value,label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
    </header>
    {error && <div role="alert" className="kd-error">{error}</div>}
    <div className="kd-layout">
      <aside className="kd-library"><div className="kd-list-heading">团队知识 <span>{visible.length}</span></div>
        <div className="kd-doc-list">{visible.map(item => <button key={item.id} className={`kd-doc-row ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
          <FileText size={29} className="kd-file-icon" /><span className="kd-doc-info"><strong title={item.title}>{item.title}</strong><small>{scopeLabel(item)}{item.technologies.length ? ` · ${item.technologies.map(languageLabel).join("、")}` : ""}</small></span>
          <span className={`kd-status ${item.indexing?.state}`}>{labels[item.indexing?.state ?? "queued"]}</span>
        </button>)}{!visible.length && <div className="kd-empty">{rows.length ? "没有匹配的文档" : "上传一份手册，开始积累可复用知识。"}</div>}</div>

      </aside>
      <section className="kd-detail">{!doc ? <div className="kd-empty">{selected ? "正在读取文档…" : "选择文档，查看内容或试搜知识"}</div> : <>
        <header className="kd-doc-header"><div><h2>{doc.title}</h2><div className="kd-tags"><span>{scopeLabel(doc)}</span>{doc.technologies.map(v => <span key={v}>{languageLabel(v)}</span>)}<span>{doc.product_versions.join("、") || "所有版本"}</span><span className={`kd-status ${status?.state}`}>{labels[status?.state ?? "queued"]}</span></div></div>
          <div className="kd-actions">{doc.external ? <Button variant="outline" onClick={() => onManage(doc.focus)}>查看与维护</Button> : <><Button variant="outline" onClick={() => setForm("edit")}>编辑适用范围</Button><Button variant="outline" onClick={() => setForm("replace")}>替换文档</Button><DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" aria-label="更多文档操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={busy} onClick={() => void update({ active: !doc.active })}>{doc.active ? "停用文档" : "启用文档"}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></>}</div></header>
        <div className="kd-meta">{status?.state === "ready" ? `${status.sections === undefined ? "索引已就绪" : `已整理 ${status.sections} 个章节`} · 原始文档保持不变` : status?.state === "failed" ? status.error : status?.state === "disabled" ? "已停用，不再用于 Agent 检索" : "后台正在准备知识索引，可先阅读原文"}
          {status?.state === "failed" && <Button variant="outline" size="sm" onClick={() => void documentRequest(`/${encodeURIComponent(selected)}/retry`, {}).then(refresh).catch(e => setError(e.message))}><RefreshCw size={14} /> 重试</Button>}</div>
        {doc.source && <div className="kd-source"><span title={doc.source.repository}>来自 {doc.source.repository} · {doc.source.branch} · {doc.source.path} · {doc.source.revision.slice(0, 8)}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void update({ repository_import: doc.source })}>从仓库更新</Button></div>}
        <nav className="kd-tabs">{[["content", "阅读文档"], ["search", "试搜知识"], ...(!doc.external ? [["history", "修改记录"]] : [])].map(([key, text]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{text}</button>)}</nav>
        {tab === "search" && <><form className="kd-trial-query" onSubmit={e => { e.preventDefault(); void search(); }}><div className="kd-search-input"><Search size={20} /><Input aria-label="试搜问题" placeholder="例如：写入文件后，应该由谁关闭文件？" value={query} onChange={e => setQuery(e.target.value)} /></div><Button type="submit" disabled={busy || !query.trim() || !doc.active}>{busy ? "检索中…" : "试搜"}</Button></form>
          {trial?.warnings.length ? <p role="status" className="kd-warning">{trial.available ? trial.warnings.join("；") : "知识索引尚未准备好或检索服务暂不可用。原文已保存，可先查看文档内容，稍后再试搜。"}</p> : null}
          <div className="kd-results"><aside><strong>{trial ? trial.available ? `找到 ${trial.hits.length} 个相关章节` : "暂不能检索" : "相关章节"}</strong>{trial?.hits.map((item, i) => <button key={`${item.start_line}-${i}`} className={hit === item ? "active" : ""} onClick={() => setHit(item)}><span><b>{item.heading?.split(" > ").at(-1) || doc.title}</b><small>第 {item.start_line ?? 1}–{item.end_line ?? "?"} 行</small></span></button>)}{trial?.available && !trial.hits.length && <p className="kd-empty">没有找到相关章节，试试更具体的问题。</p>}</aside>
            <article className="kd-reader">{validHit ? <><header><div><small>{validHit.heading}</small><small>原文第 {validHit.start_line ?? 1}–{validHit.end_line ?? lines.length} 行</small></div><Button variant="ghost" onClick={() => setTab("content")}>查看完整文档 ↗</Button></header><Markdown text={lines.slice((validHit.start_line ?? 1) - 1, validHit.end_line).join("\n")} /></> : <div className="kd-empty">{hit ? "文档已更新，请重新试搜" : "输入一个真实问题，查看命中的规则与原文。"}</div>}</article></div>
</>}
        {tab === "content" && <div className="kd-full-content"><Markdown text={doc.content ?? ""} /></div>}
        {tab === "history" && <div className="kd-history">{[...doc.history].reverse().map((entry, i) => <div key={i}><strong>{entry.action}</strong><span>{entry.operator}</span><time>{new Date(entry.at).toLocaleString()}</time></div>)}</div>}
      </>}</section>
    </div>
    {form && <DocumentForm mode={form} doc={form === "upload" ? undefined : doc} modules={modules} onSkillImport={() => { setForm(undefined); onManage({kind:"skill",directory:"",digest:"",packageDigest:""}); }} onClose={() => setForm(undefined)} onSaved={async saved => { setForm(undefined); await refresh(); setSelected(saved.id); setDoc(saved); setTrial(undefined); setHit(undefined); }} />}
  </div>;
}

function DocumentForm({ mode, doc, modules, onClose, onSaved, onSkillImport }: { onSkillImport: () => void; mode: string; doc?: KnowledgeDocument; modules: BusinessModule[]; onClose: () => void; onSaved: (doc: KnowledgeDocument) => void }) {
  const [source, setSource] = useState(doc?.source ? "repository" : "upload"), [title, setTitle] = useState(doc?.title ?? "");
  const [content, setContent] = useState<string>(), [filename, setFilename] = useState("");
  const [scope, setScope] = useState(doc?.scope ?? "platform"), [moduleIds, setModuleIds] = useState(doc?.module_ids ?? []);
  const [repositories, setRepositories] = useState(doc?.repositories.join("\n") ?? ""), [language, setLanguage] = useState(doc?.technologies ?? []);
  const [versions, setVersions] = useState(doc?.product_versions ?? []), [when, setWhen] = useState(doc?.when_to_use ?? "");
  const [repo, setRepo] = useState(doc?.source?.repository ?? ""), [branch, setBranch] = useState(doc?.source?.branch ?? "master"), [path, setPath] = useState(doc?.source?.path ?? "");
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
      onSaved(await documentRequest<KnowledgeDocument>(doc ? `/${encodeURIComponent(doc.id)}` : "", body));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="kd-upload-dialog"><DialogHeader><DialogTitle>{mode === "edit" ? "编辑适用范围" : mode === "replace" ? "替换文档" : "上传知识"}</DialogTitle></DialogHeader>
    <form onSubmit={e => { e.preventDefault(); void save(); }}>
      {mode !== "edit" && <><nav className="kd-source-tabs"><button type="button" className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}>直接上传</button><button type="button" className={source === "repository" ? "active" : ""} onClick={() => setSource("repository")}>从 CodeHub 仓库导入</button>{mode === "upload" && <button type="button" onClick={onSkillImport}>上传 Skill 包 ↗</button>}</nav>
        {source === "upload" ? <label className="kd-dropzone"><Upload size={25} /><strong>{filename || "选择 Markdown 文档"}</strong><span>UTF-8 · .md · 最大 2 MiB</span><input aria-label="选择 Markdown 文档" type="file" accept=".md,text/markdown" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { if (file.size > 2 * 1024 * 1024 || !/\.md$/i.test(file.name)) throw new Error("请选择 2 MiB 以内的 Markdown 文件"); const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); setContent(text); setFilename(file.name); if (!doc) setTitle(file.name); setError(""); } catch (e) { setContent(undefined); setFilename(""); setError((e as Error).message); } }} /></label>
          : <div className="kd-repo-fields"><label>CodeHub 仓库地址<Input required value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://codehub.example.com/team/repo.git" /></label><div className="kd-form-two"><label>分支<Input required value={branch} onChange={e => setBranch(e.target.value)} /></label><label>仓内文件路径<Input required value={path} onChange={e => { setPath(e.target.value); if (!doc) setTitle(e.target.value.split("/").at(-1) ?? ""); }} placeholder="docs/cpp/file-guide.md" /></label></div><small>使用你已配置的个人 Git 凭据，只读取指定文件。</small></div>}</>}
      <label>文档名称<Input required value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>适用范围<Select value={scope} onValueChange={value => setScope(value ?? "platform")} items={[{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"特定代码仓"}]}><SelectTrigger aria-label="适用范围" className="w-full h-10! text-base"><SelectValue /></SelectTrigger><SelectContent>{[["platform","平台通用"],["module","业务模块"],["repository","特定代码仓"]].map(([key,text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></label>
      {scope === "module" && <div><DocumentMultiSelect label="业务模块" value={moduleIds} onChange={setModuleIds} options={modules.filter(m => m.status === "active").map(m => ({value:m.id,label:m.name}))} placeholder="选择业务模块（可多选）" />{!modules.some(m => m.status === "active") && <a href="/configuration?tab=modules" target="_blank" rel="noreferrer">去配置中心新建模块 ↗</a>}</div>}
      {scope === "repository" && <label>适用仓库地址（每行一个）<textarea required rows={2} value={repositories} onChange={e => setRepositories(e.target.value)} /></label>}
      <div className="kd-form-two"><DocumentMultiSelect label="适用语言（可多选）" value={language} onChange={values => setLanguage(values.includes("agnostic") && !language.includes("agnostic") ? ["agnostic"] : values.filter(v => v !== "agnostic"))} options={KNOWLEDGE_LANGUAGE_OPTIONS.map(v => ({value:v.id,label:v.label}))} placeholder="选择适用语言" /><DocumentMultiSelect label="产品版本（可多选）" value={versions} onChange={setVersions} options={versionOptions.map(v => ({value:v,label:v}))} placeholder="所有版本" /></div>
      <label>什么时候使用（可选）<Input value={when} onChange={e => setWhen(e.target.value)} placeholder="如：创建、读写或关闭文件时" /></label>
      {error && <p role="alert" className="kd-error">{error}</p>}
      <footer><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy}>{busy ? source === "repository" && mode !== "edit" ? "正在读取仓库文件…" : "保存中…" : mode === "edit" ? "保存" : "保存并整理"}</Button></footer>
    </form>
  </DialogContent></Dialog>;
}

function DocumentMultiSelect({label,value,onChange,options,placeholder}:{label:string;value:string[];onChange:(value:string[])=>void;options:Array<{value:string;label:string}>;placeholder:string}) {
 return <label>{label}<Select multiple value={value} onValueChange={onChange} items={options}><SelectTrigger aria-label={label} className="w-full h-10! text-base"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.length ? options.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>) : <div className="p-3 text-muted-foreground">暂无选项，请先在配置中心维护</div>}</SelectContent></Select></label>;
}
