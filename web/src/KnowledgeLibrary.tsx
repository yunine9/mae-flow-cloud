import { useEffect, useState } from "react";
import { ChevronDown, Plus, Upload, Sparkles } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { KnowledgeModuleHome } from "./KnowledgeModuleHome";
import { KnowledgeModuleReader } from "./KnowledgeModuleReader";
import { KnowledgeTaskCenter, KnowledgeTaskCapsule } from "./KnowledgeTaskCenter";
import { KnowledgeResearchCreate } from "./KnowledgeResearchCreate";
import { KnowledgeSkillImport } from "./KnowledgeSkillImport";
import { KnowledgeSkillTask } from "./KnowledgeSkillTask";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import { ComponentResearch } from "./ComponentResearch";
import { KnowledgeDocuments } from "./KnowledgeDocuments";
import { KnowledgeStudioContext, type ExtractionKind } from "./KnowledgeStudioContext";
import { knowledgeLibraryPage, knowledgeStudioView, type KnowledgeAssetFocus } from "./knowledgeNavigation";
import "./knowledge-library.css";

type Page = "home" | "module" | "tasks" | "research" | "import" | "task" | "legacy";
type Kind = ExtractionKind | "skill-extraction" | "skill-submission";
function readRoute() {
  const q = new URLSearchParams(location.search), page = q.get("kbPage");
  const valid = ["home", "module", "tasks", "research", "import", "task"].includes(page ?? "");
  const oldPage = knowledgeLibraryPage(location.search);
  const kind = q.get("kbKind") as Kind | null;
  return { page: (valid ? page : q.has("domainExtraction") || q.has("componentResearch") ? "task" : q.has("knowledgeDocument") || q.has("platformSkill") ? "legacy" : "home") as Page,
    module: q.get("kbModule") ?? "", document: q.get("knowledgeDocument") ?? "",
    kind: kind ?? (oldPage === "component" ? "component" : "domain"),
    id: q.get("kbTask") ?? q.get("domainExtraction") ?? q.get("componentResearch") ?? "",
    review: q.get("kbReview") === "1" || (!valid && knowledgeStudioView(location.search) === "knowledge") };
}
export function KnowledgeLibrary({ onCategoryChange, onOpenTask, onManage }: {
  category: "documents" | "skills"; onCategoryChange: (category: "documents" | "skills") => void; uploadRequest: number;
  onOpenTask: (id: string) => void; onManage: (focus?: KnowledgeAssetFocus) => void;
}) {
  const [route, setRoute] = useState(readRoute);
  const [summary, setSummary] = useState({ running: 0, attention: 0, total: 0 });
  useEffect(() => { const sync = () => setRoute(readRoute()); addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  useEffect(() => {
    let live = true;
    const refresh = async () => { try { const r = await fetch("/knowledge-tasks"); if (!r.ok) return; const data = await r.json(); if (live && data.summary) setSummary(data.summary); } catch { /* 任务中心提供重试及错误信息。 */ } };
    void refresh(); const timer = setInterval(refresh, 5000); return () => { live = false; clearInterval(timer); };
  }, []);
  function navigate(page: Page, values: Record<string, string> = {}) {
    const url = new URL(location.href);
    for (const key of ["kbPage", "kbModule", "kbKind", "kbTask", "kbReview", "knowledgeDocument", "domainExtraction", "componentResearch", "knowledgeView", "knowledgePage", "platformSkill"]) url.searchParams.delete(key);
    url.searchParams.set("kbPage", page);
    for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
    history.pushState(history.state, "", url); setRoute(readRoute());
  }
  function openTask(kind: Kind, id: string, review = false) {
    if (id === "new" || !id) { navigate("research", { kbKind: kind }); return; }
    if (id === "history") { navigate("tasks"); return; }
    navigate("task", { kbKind: kind, kbTask: id, kbReview: review ? "1" : "", ...(kind === "domain" ? { domainExtraction: id } : kind === "component" ? { componentResearch: id } : {}) });
  }
  const focused = route.page === "module" || route.page === "task";
  return <KnowledgeStudioContext.Provider value={{ view: route.review ? "knowledge" : "workbench", openExecution: (kind, id) => openTask(kind, id ?? "new"), openResult: (kind, id) => openTask(kind, id, true) }}>
    <section className={`knowledge-hub ${focused ? "is-focused" : ""}`} aria-label="知识库">
      <header className="knowledge-hub-header">
        <div className="knowledge-page-title">{route.page === "legacy" && <KnowledgeBackButton onClick={() => navigate("home")} />}<button type="button" className="knowledge-hub-brand" onClick={() => navigate("home")}><strong>知识库</strong></button></div>
        <div className="knowledge-hub-actions">
          <KnowledgeTaskCapsule summary={summary} active={route.page === "tasks"} onClick={() => navigate("tasks")} />
          <DropdownMenu><DropdownMenuTrigger render={<Button className="knowledge-hub-add" />}><Plus size={18} />新增<ChevronDown size={14} /></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={10} className="knowledge-hub-add-menu">
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("research", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Sparkles size={19} /></span><span><strong>研究知识</strong><small>萃取领域、基础组件，或制作 Skill</small></span></DropdownMenuItem>
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("import", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Upload size={19} /></span><span><strong>导入 Skill</strong><small>导入完整技能包，归入模块或语言</small></span></DropdownMenuItem>
          <DropdownMenuSeparator /><DropdownMenuItem className="knowledge-hub-manage" onClick={() => onManage()}>团队经验与维护</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      {route.page === "home" && <KnowledgeModuleHome onOpenModule={key => navigate("module", { kbModule: key })} onOpenDocument={(id, key) => navigate("module", { kbModule: key ?? "unassigned", knowledgeDocument: id })} />}
      {route.page === "module" && <KnowledgeModuleReader moduleKey={route.module} selectedDocumentId={route.document} onBack={() => navigate("home")} onResearch={(id, documentId) => documentId ? openTask(id.startsWith("dkx-") ? "domain" : "component", id, true) : navigate("tasks")} />}
      {route.page === "tasks" && <KnowledgeTaskCenter onBack={() => navigate("home")} onOpen={(kind, id, review) => openTask(kind, id, review)} onSummaryChange={setSummary} />}
      {route.page === "research" && <KnowledgeResearchCreate moduleKey={route.module} initialKind={route.kind} onBack={() => navigate("home")} onCreated={() => navigate("tasks")} />}
      {route.page === "import" && <KnowledgeSkillImport moduleKey={route.module} onBack={() => navigate("home")} onCreated={() => navigate("tasks")} />}
      {route.page === "task" && <div className="knowledge-hub-task">
        {route.kind === "domain" && <DomainKnowledgeExtraction focused onBack={() => navigate("tasks")} onViewKnowledge={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} key={route.id} focusId={route.id} surface={route.review ? "knowledge" : "workbench"} />}
        {route.kind === "component" && <ComponentResearch key={route.id} open focused focusId={route.id} surface={route.review ? "knowledge" : "workbench"} onClose={() => navigate("tasks")} backLabel="任务中心" onAdopt={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} />}
        {(route.kind === "skill-extraction" || route.kind === "skill-submission") && <KnowledgeSkillTask kind={route.kind} id={route.id} onBack={() => navigate("tasks")} onSubmitted={id => openTask("skill-submission", id, true)} />}
      </div>}
      {route.page === "legacy" && <div className="knowledge-hub-task"><KnowledgeDocuments studio category={new URLSearchParams(location.search).has("platformSkill") ? "skills" : "documents"} onCategoryChange={onCategoryChange} selectedDocument={route.document} onOpenTask={onOpenTask} onManage={onManage} onResearch={id => openTask(id.startsWith("dkx-") ? "domain" : "component", id, true)} /></div>}
    </section>
  </KnowledgeStudioContext.Provider>;
}
