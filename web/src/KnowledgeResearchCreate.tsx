import { useEffect, useState } from "react";
import { BookOpen, Boxes, Puzzle } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getBusinessModules, type BusinessModule } from "./api";
import { componentRequest, type ComponentRepository } from "./componentResearchApi";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { KNOWLEDGE_LANGUAGE_OPTIONS } from "./KnowledgeLanguages";
import { KnowledgeDestination, destinationMetadata } from "./KnowledgeDestination";
import { ExtractionSkillEditor } from "./ExtractionSkillEditor";

export function KnowledgeResearchCreate({ moduleKey = "", initialKind, onBack, onCreated }: { moduleKey?: string; initialKind?: string; onBack: () => void; onCreated: (kind: "domain" | "component" | "skill-extraction", id: string) => void }) {
  const [mode, setMode] = useState<"domain" | "component" | "skill-extraction">(initialKind === "skill-extraction" ? initialKind : moduleKey.startsWith("engineering:") || initialKind === "component" ? "component" : "domain");
  const [destination, setDestination] = useState(moduleKey), [modules, setModules] = useState<BusinessModule[]>([]), [components, setComponents] = useState<ComponentRepository[]>([]);
  const [language, setLanguage] = useState(moduleKey.startsWith("engineering:") ? moduleKey.slice(12) : ""), [scope, setScope] = useState("all");
  const [goal, setGoal] = useState(""), [branch, setBranch] = useState("master"), [issue, setIssue] = useState(""), [issueDescription, setIssueDescription] = useState("");
  const [repo, setRepo] = useState(""), [path, setPath] = useState("");
  const [materials, setMaterials] = useState<MaterialSummary[]>([]), [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let live = true; void Promise.all([getBusinessModules(), componentRequest<{ components: ComponentRepository[] }>("/component-repositories")]).then(([m,c]) => { if (live) { setModules(m.modules); setComponents(c.components); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const module = modules.find(m => `business:${m.id}` === destination), selectedComponents = components.filter(c => c.enabled && c.languages.includes(language));
  async function create() {
    setBusy(true); setError("");
    try {
      const result = mode === "domain" ? await componentRequest<{ id: string }>("/domain-extraction", { module_id: module?.id, baseline_branch: branch, issue_no: issue, issue_description: issueDescription, instructions: goal || undefined, material_ids: materials.map(m => m.id) })
        : mode === "component" ? await componentRequest<{ id: string }>("/component-research", { language, mode: scope, ...(scope === "topic" ? { topic: goal } : {}) })
        : await componentRequest<{ id: string }>("/knowledge/skill-extract", { repo, intent: goal, path_hint: path || undefined, ...destinationMetadata(destination) });
      onCreated(mode, result.id);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const canCreate = mode === "domain" ? !!module && !!issue.trim() && !!issueDescription.trim() && (!module.repositories.length || !!branch.trim()) : mode === "component" ? !!language && !!selectedComponents.length && (scope === "all" || !!goal.trim()) : !!destination && !!repo.trim() && !!goal.trim();
  return <section className="knowledge-create" aria-label="研究知识"><header className="knowledge-create-header"><div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} /><h2>研究知识</h2></div>{mode === "domain" && <ExtractionSkillEditor kind={mode} />}</header>
    <div className="knowledge-create-modes" role="group" aria-label="研究方式">{([["domain","业务知识",BookOpen],["component","组件用法",Boxes],["skill-extraction","制作 Skill",Puzzle]] as const).map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={mode===id} onClick={() => {setMode(id);setError("");}}><Icon size={16} />{label}</button>)}</div>
    {error && <p role="alert" className="text-danger mb-4">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); if (canCreate && !busy) void create(); }}><div className="knowledge-create-grid"><div className="knowledge-create-fields">
      {mode === "domain" && <><label>业务模块<KnowledgeDestination businessOnly value={destination.startsWith("business:") ? destination : ""} onChange={setDestination} /></label><div className="field-pair"><label>统一基准分支<Input value={branch} onChange={e => setBranch(e.target.value)} /></label><label>关联单号<Input required value={issue} onChange={e => { setIssue(e.target.value); setIssueDescription(""); }} placeholder="需求或问题单号" /></label></div><label>单号描述<Input required maxLength={2000} aria-label="单号描述" value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述，请勿额外添加单号或前后缀" /><small className="knowledge-create-hint">将原样用作 MR 标题。</small></label><label>研究要求 <small className="knowledge-create-hint">选填</small><Textarea value={goal} rows={4} onChange={e => setGoal(e.target.value)} placeholder="希望澄清哪些业务规则或仓内约定？" /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} /></>}
      {mode === "component" && <><label>工程语言<Select value={language} onValueChange={v => setLanguage(v ?? "")} items={KNOWLEDGE_LANGUAGE_OPTIONS.map(l => ({value:l.id,label:l.label}))}><SelectTrigger aria-label="工程语言"><SelectValue placeholder="选择语言" /></SelectTrigger><SelectContent>{KNOWLEDGE_LANGUAGE_OPTIONS.map(l => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select></label><div className="flex gap-5 text-sm">{[["all","全部组件"],["topic","指定主题"]].map(([id,name]) => <label key={id} className="!flex items-center gap-2"><input type="radio" name="scope" checked={scope===id} onChange={() => setScope(id)} />{name}</label>)}</div>{scope === "topic" && <label>研究主题<Textarea required rows={4} value={goal} onChange={e => setGoal(e.target.value)} placeholder="例如：定时器取消与回调的边界条件" /></label>}</>}
      {mode === "skill-extraction" && <><label>制作要求<Textarea required rows={4} value={goal} onChange={e => setGoal(e.target.value)} placeholder="这个 Skill 用来完成什么，适用于哪些场景？" /></label><label>参考仓库<Input required value={repo} onChange={e => setRepo(e.target.value)} placeholder="代码仓地址" /></label><label>参考路径 <small className="knowledge-create-hint">选填</small><Input value={path} onChange={e => setPath(e.target.value)} placeholder="留空则研究整个参考仓" /></label><label>知识归属<KnowledgeDestination value={destination} onChange={setDestination} /></label></>}
    </div><aside className="knowledge-create-aside"><h3>{mode === "domain" ? "关联业务仓" : mode === "component" ? "研究范围" : "制作结果"}</h3><ul>{mode === "domain" ? module?.repositories.map(r => <li key={r}><strong>{r.split("/").at(-1)?.replace(/\.git$/, "")}</strong><small>{r}</small><small>{branch}</small></li>) : mode === "component" ? selectedComponents.map(c => <li key={c.id}><strong>{c.name}</strong><small>{c.repository} · {c.branch}</small></li>) : <li><strong>完整 Skill 包</strong><small>起草后进入文稿审查，确认归属和内容后发布。</small></li>}</ul>{mode === "domain" && !module && <p className="knowledge-create-hint">选择模块后显示关联仓库。</p>}{mode === "component" && !selectedComponents.length && <p className="knowledge-create-hint">请选择已配置基础组件仓的语言。</p>}</aside></div>
    <footer className="knowledge-create-footer"><p className="knowledge-create-hint">创建后进入知识任务中心，可随时查看进度与研究记录。</p><Button type="submit" disabled={busy || uploading || !canCreate}>{busy ? "正在创建…" : "开始研究"}</Button></footer></form>
  </section>;
}
