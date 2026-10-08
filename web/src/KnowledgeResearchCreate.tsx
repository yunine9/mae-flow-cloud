import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
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
import { loadKnowledgeModules, knowledgeFileName, type KnowledgeModule } from "./knowledgeModules";

export interface KnowledgeResearchDraft {
  mode: "domain" | "component" | "skill-extraction";
  destination: string; language: string; target: string; goal: string; branch: string;
  issue: string; issueDescription: string; repo: string; path: string; materials: MaterialSummary[];
}

export function KnowledgeResearchCreate({ moduleKey = "", initialKind, draft, onDraftChange, onBack, onCreated, onCreatedMany, onOpenDocument }: { moduleKey?: string; initialKind?: string; draft?: KnowledgeResearchDraft; onDraftChange: Dispatch<SetStateAction<KnowledgeResearchDraft | undefined>>; onBack: () => void; onCreated: (kind: "domain" | "component" | "skill-extraction", id: string) => void; onCreatedMany?: () => void; onOpenDocument?: (id: string, moduleKey: string) => void }) {
  const initial: KnowledgeResearchDraft = { mode: initialKind === "skill-extraction" ? initialKind : moduleKey.startsWith("engineering:") || initialKind === "component" ? "component" : "domain", destination: moduleKey, language: moduleKey.startsWith("engineering:") ? moduleKey.slice(12) : "", target: "", goal: "", branch: "master", issue: "", issueDescription: "", repo: "", path: "", materials: [] };
  // 草稿由知识库保存，查看方法或已有知识不会丢输入；创建成功后由调用方清理。
  const { mode, destination, language, target, goal, branch, issue, issueDescription, repo, path, materials } = draft ?? initial;
  const change = (patch: Partial<KnowledgeResearchDraft>) => onDraftChange(current => ({ ...(current ?? initial), ...patch }));
  const setMode = (mode: KnowledgeResearchDraft["mode"]) => change({ mode });
  const setDestination = (destination: string) => change({ destination }), setLanguage = (language: string) => change({ language }), setTarget = (target: string) => change({ target });
  const setGoal = (goal: string) => change({ goal }), setBranch = (branch: string) => change({ branch }), setIssue = (issue: string) => change({ issue }), setIssueDescription = (issueDescription: string) => change({ issueDescription });
  const setRepo = (repo: string) => change({ repo }), setPath = (path: string) => change({ path }), setMaterials = (materials: MaterialSummary[]) => change({ materials });
  const [modules, setModules] = useState<BusinessModule[]>([]), [components, setComponents] = useState<ComponentRepository[]>([]);
  const [uploading, setUploading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [library, setLibrary] = useState<KnowledgeModule[]>([]);
  // 同一模块再研究会落到同名文件，发布时才被「已有正式知识」拦下（2026-10-08 走查实测）；
  // 选模块时先列出已有知识，补充或修订走那篇知识的「更新知识」。读取失败只是不提示，不挡创建。
  useEffect(() => { let live = true; void loadKnowledgeModules().then(data => { if (live) setLibrary(data.modules); }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; void Promise.all([getBusinessModules(), componentRequest<{ components: ComponentRepository[] }>("/component-repositories")]).then(([m,c]) => { if (live) { setModules(m.modules); setComponents(c.components); } }).catch(e => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  const module = modules.find(m => `business:${m.id}` === destination), existing = library.find(m => m.key === destination)?.documents.filter(d => d.active && d.form !== "skill") ?? [], languageComponents = components.filter(c => c.enabled && c.languages.includes(language));
  // 一个组件一次研究一篇知识；选「全部组件」就每个组件各建一个任务（2026-10-08 用户）。
  const chosen = target || (languageComponents.length === 1 ? languageComponents[0].id : "");
  const selectedComponents = chosen === "all" ? languageComponents : languageComponents.filter(c => c.id === chosen);
  async function create() {
    setBusy(true); setError("");
    try {
      const result = mode === "domain" ? await componentRequest<{ id: string }>("/domain-extraction", { module_id: module?.id, baseline_branch: branch, issue_no: issue, issue_description: issueDescription, instructions: goal || undefined, material_ids: materials.map(m => m.id) })
        : mode === "component" ? await (async () => {
          const created = [];
          for (const component of selectedComponents) created.push(await componentRequest<{ id: string }>("/component-research", { language, component_id: component.id }));
          return created.length === 1 ? created[0] : undefined;
        })()
        : await componentRequest<{ id: string }>("/knowledge/skill-extract", { repo, intent: goal, path_hint: path || undefined, ...destinationMetadata(destination) });
      if (result) onCreated(mode, result.id); else onCreatedMany?.();
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const canCreate = mode === "domain" ? !!module && !!issue.trim() && !!issueDescription.trim() && (!module.repositories.length || !!branch.trim()) : mode === "component" ? !!language && !!selectedComponents.length : !!destination && !!repo.trim() && !!goal.trim();
  return <section className="knowledge-create" aria-label="研究知识"><header className="knowledge-create-header"><div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} /><h2>研究知识</h2></div>{mode === "domain" && <ExtractionSkillEditor kind={mode} />}</header>
    <div className="knowledge-create-modes" role="group" aria-label="研究方式">{([["domain","业务知识",BookOpen],["component","组件用法",Boxes],["skill-extraction","制作 Skill",Puzzle]] as const).map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={mode===id} onClick={() => {setMode(id);setError("");}}><Icon size={16} />{label}</button>)}</div>
    {error && <p role="alert" className="text-danger mb-4">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); if (canCreate && !busy) void create(); }}><div className="knowledge-create-grid"><div className="knowledge-create-fields">
      {mode === "domain" && <><label>业务模块<KnowledgeDestination businessOnly value={destination.startsWith("business:") ? destination : ""} onChange={setDestination} /></label><div className="field-pair"><label>统一基准分支<Input value={branch} onChange={e => setBranch(e.target.value)} /></label><label>关联单号<Input required value={issue} onChange={e => setIssue(e.target.value)} placeholder="需求或问题单号" /></label></div><label>单号描述<Input required maxLength={2000} aria-label="单号描述" value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述，请勿额外添加单号或前后缀" /><small className="knowledge-create-hint">将原样用作 MR 标题。</small></label><label><span>研究要求 <small className="knowledge-create-hint">选填</small></span><Textarea value={goal} rows={4} onChange={e => setGoal(e.target.value)} placeholder="希望澄清哪些业务规则或仓内约定？" /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} /></>}
      {mode === "component" && <><label>工程语言<Select value={language} onValueChange={v => { setLanguage(v ?? ""); setTarget(""); }} items={KNOWLEDGE_LANGUAGE_OPTIONS.map(l => ({value:l.id,label:l.label}))}><SelectTrigger aria-label="工程语言"><SelectValue placeholder="选择语言" /></SelectTrigger><SelectContent>{KNOWLEDGE_LANGUAGE_OPTIONS.map(l => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent></Select></label><label>组件<Select value={chosen} onValueChange={v => setTarget(v ?? "")} items={[...languageComponents.map(c => ({ value: c.id, label: c.name })), ...(languageComponents.length > 1 ? [{ value: "all", label: "全部组件（每个组件各建一个任务）" }] : [])]}><SelectTrigger aria-label="组件"><SelectValue placeholder={language ? "选择要研究的组件" : "先选择语言"} /></SelectTrigger><SelectContent>{languageComponents.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}{languageComponents.length > 1 && <SelectItem value="all">全部组件（每个组件各建一个任务）</SelectItem>}</SelectContent></Select><small className="knowledge-create-hint">每个组件一篇知识；已研究过的组件会打开原任务，补充或刷新请用「补充遗漏能力」「更新知识」。</small></label></>}
      {mode === "skill-extraction" && <><label>制作要求<Textarea required rows={4} value={goal} onChange={e => setGoal(e.target.value)} placeholder="这个 Skill 用来完成什么，适用于哪些场景？" /></label><label>参考仓库<Input required value={repo} onChange={e => setRepo(e.target.value)} placeholder="代码仓地址" /></label><label>参考路径 <small className="knowledge-create-hint">选填</small><Input value={path} onChange={e => setPath(e.target.value)} placeholder="留空则研究整个参考仓" /></label><label>知识归属<KnowledgeDestination value={destination} onChange={setDestination} /></label></>}
    </div><aside className="knowledge-create-aside"><h3>{mode === "domain" ? "关联业务仓" : mode === "component" ? "研究范围" : "制作结果"}</h3><ul>{mode === "domain" ? module?.repositories.map(r => <li key={r}><strong>{r.split("/").at(-1)?.replace(/\.git$/, "")}</strong><small>{r}</small><small>{branch}</small></li>) : mode === "component" ? selectedComponents.map(c => <li key={c.id}><strong>{c.name}</strong><small>{c.repository} · {c.branch}</small></li>) : <li><strong>完整 Skill 包</strong><small>起草后进入文稿审查，确认归属和内容后发布。</small></li>}</ul>{mode === "domain" && !module && <p className="knowledge-create-hint">选择模块后显示关联仓库。</p>}{mode === "domain" && module && existing.length > 0 && <div className="mt-6"><h3>已有正式知识 · {existing.length} 篇</h3><ul>{existing.map(d => <li key={d.id}><button type="button" className="knowledge-inline-link border-0 bg-transparent p-0 font-semibold" onClick={() => onOpenDocument?.(d.id, destination)}>{d.title}</button><small>{knowledgeFileName(d)}</small></li>)}</ul><p className="knowledge-create-hint mt-3">补充或修订这些内容，请打开该知识点「更新知识」；新研究写到同名文件时不能发布。</p></div>}{mode === "component" && !selectedComponents.length && <p className="knowledge-create-hint">{language && !languageComponents.length ? "该语言还没有登记组件，请先在配置中心登记。" : "选择语言和组件后显示研究范围。"}</p>}</aside></div>
    <footer className="knowledge-create-footer"><p className="knowledge-create-hint">创建后进入知识任务中心，可随时查看进度与研究记录。</p><Button type="submit" disabled={busy || uploading || !canCreate}>{busy ? "正在创建…" : "开始研究"}</Button></footer></form>
  </section>;
}
