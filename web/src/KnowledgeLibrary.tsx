import { useEffect, useState } from "react";
import { ChevronDown, Plus, Upload, Sparkles } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { KnowledgeModuleHome } from "./KnowledgeModuleHome";
import { KnowledgeModuleReader } from "./KnowledgeModuleReader";
import { KnowledgeTaskCenter, KnowledgeTaskCapsule, KnowledgeExperienceCapsule } from "./KnowledgeTaskCenter";
import { KnowledgeResearchCreate } from "./KnowledgeResearchCreate";
import { KnowledgeSkillImport } from "./KnowledgeSkillImport";
import { KnowledgeSkillTask } from "./KnowledgeSkillTask";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import { ComponentResearch } from "./ComponentResearch";
import { PlatformSkillPane, type PlatformSkillKind } from "./PlatformSkill";
import { KnowledgeStudioContext, type ExtractionKind } from "./KnowledgeStudioContext";
import { MemoryBoard } from "./MemoryBoard";
import { getMemoryInsights } from "./api";
import { memoryCounts } from "./memoryPresentation";
import type { KnowledgeProductionAction } from "../../src/knowledgeProductionTypes";

type Page = "home" | "module" | "tasks" | "research" | "import" | "task" | "experience";
type Kind = ExtractionKind | "skill-extraction" | "skill-submission";
function readRoute() {
  const q = new URLSearchParams(location.search), page = q.get("kbPage");
  const valid = ["home", "module", "tasks", "research", "import", "task", "experience"].includes(page ?? "");
  const kind = q.get("kbKind") as Kind | null;
  return { page: (valid ? page : "home") as Page,
    module: q.get("kbModule") ?? "", document: q.get("knowledgeDocument") ?? "",
    kind: kind ?? "domain", id: q.get("kbTask") ?? "", review: q.get("kbReview") === "1" };
}
export function KnowledgeLibrary({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const [route, setRoute] = useState(readRoute);
  const [summary, setSummary] = useState({ running: 0, attention: 0, total: 0 });
  useEffect(() => { const sync = () => setRoute(readRoute()); addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  // 任务中心页自己轮询并通过 onSummaryChange 回报数量，这里只在别的页轮询，避免两处同时每 5 秒请求。
  const onTasksPage = route.page === "tasks";
  useEffect(() => {
    if (onTasksPage) return;
    let live = true;
    const refresh = async () => { try { const r = await fetch("/knowledge-tasks"); if (!r.ok) return; const data = await r.json(); if (live && data.summary) setSummary(data.summary); } catch { /* 任务中心提供重试及错误信息。 */ } };
    void refresh(); const timer = setInterval(refresh, 5000); return () => { live = false; clearInterval(timer); };
  }, [onTasksPage]);
  // 经验变化慢，不轮询：进出页面时各读一次，从经验页审完回来就是新数。读失败卡片只显示入口说明（旁路 fail-open）。
  const [experience, setExperience] = useState<{ pending: number; accepted: number } | null>(null);
  useEffect(() => {
    let live = true;
    getMemoryInsights().then(value => { if (live) setExperience(memoryCounts(value.memories)); }).catch(() => { if (live) setExperience(null); });
    return () => { live = false; };
  }, [route.page]);
  function navigate(page: Page, values: Record<string, string> = {}) {
    const url = new URL(location.href);
    for (const key of ["kbPage", "kbModule", "kbKind", "kbTask", "kbReview", "kbStage", "knowledgeDocument", "domainExtraction", "componentResearch", "knowledgeView", "knowledgePage", "platformSkill", "source_task", "memory_id"]) url.searchParams.delete(key);
    url.searchParams.set("kbPage", page);
    for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
    history.pushState(history.state, "", url); setRoute(readRoute());
  }
  function openTask(kind: Kind, id: string, review = false, action?: KnowledgeProductionAction) {
    if (id === "new" || !id) { navigate("research", { kbKind: kind }); return; }
    if (id === "history") { navigate("tasks"); return; }
    if (action?.href) {
      history.pushState(history.state, "", new URL(action.href, location.href)); setRoute(readRoute()); return;
    }
    navigate("task", { kbKind: kind, kbTask: id, kbReview: review ? "1" : "",
      kbStage: action?.view === "archive" ? "publish" : "",
      knowledgeDocument: action?.document_id ?? "" });
  }
  // 全屏态的样式让容器里每个子元素各占满一行宽：只容得下一个工作区。经验页、平台 Skill 页是
  // "返回按钮 + 内容"两段，进全屏会把内容挤成几十像素（2026-10-08 真服务实测），所以留在页内。
  const platformSkill = route.page === "module" && route.module === "platform" && ["platform-skill-domain", "platform-skill-component"].includes(route.document);
  const focused = route.page === "task" || (route.page === "module" && !platformSkill);
  return <KnowledgeStudioContext.Provider value={{ view: route.review ? "knowledge" : "workbench", openExecution: (kind, id) => openTask(kind, id ?? "new"), openResult: (kind, id) => openTask(kind, id, true) }}>
    <section className={`knowledge-hub ${focused ? "is-focused" : ""}`} aria-label="知识库">
      <header className="knowledge-hub-header">
        <div className="knowledge-page-title"><button type="button" className="knowledge-hub-brand" onClick={() => navigate("home")}><strong>知识库</strong></button></div>
        <div className="knowledge-hub-actions">
          <KnowledgeExperienceCapsule counts={experience} active={route.page === "experience"} onClick={() => navigate("experience")} />
          <KnowledgeTaskCapsule summary={summary} active={route.page === "tasks"} onClick={() => navigate("tasks")} />
          <DropdownMenu><DropdownMenuTrigger render={<Button className="knowledge-hub-add" />}><Plus size={18} />新增<ChevronDown size={14} /></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={10} className="knowledge-hub-add-menu">
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("research", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Sparkles size={19} /></span><span><strong>研究知识</strong><small>萃取领域、基础组件，或制作 Skill</small></span></DropdownMenuItem>
            <DropdownMenuItem className="knowledge-hub-add-option" onClick={() => navigate("import", { kbModule: route.module })}><span className="knowledge-hub-add-icon"><Upload size={19} /></span><span><strong>导入 Skill</strong><small>导入完整技能包，归入模块或语言</small></span></DropdownMenuItem>
          </DropdownMenuContent></DropdownMenu>
        </div>
      </header>
      {route.page === "home" && <KnowledgeModuleHome onOpenModule={key => navigate("module", { kbModule: key })} onOpenDocument={(id, key) => navigate("module", { kbModule: key ?? "unassigned", knowledgeDocument: id })} />}
      {route.page === "module" && (platformSkill
        ? <div className="knowledge-hub-task"><KnowledgeBackButton onClick={() => navigate("home")} /><PlatformSkillPane key={route.document} kind={route.document.slice(15) as PlatformSkillKind} onSaved={() => {}} /></div>
        : <KnowledgeModuleReader moduleKey={route.module} selectedDocumentId={route.document} onBack={() => navigate("home")} onResearch={(id, documentId) => documentId ? openTask(id.startsWith("dkx-") ? "domain" : "component", id, true) : navigate("tasks")} />)}
      {route.page === "tasks" && <KnowledgeTaskCenter onBack={() => navigate("home")} onOpen={(kind, id, action) => openTask(kind, id, action.view !== "progress", action)} onSummaryChange={setSummary} />}
      {route.page === "research" && <KnowledgeResearchCreate moduleKey={route.module} initialKind={route.kind} onBack={() => navigate("home")} onCreated={(kind, id) => openTask(kind, id)} onCreatedMany={() => navigate("tasks")} onOpenDocument={(id, key) => navigate("module", { kbModule: key, knowledgeDocument: id })} />}
      {route.page === "import" && <KnowledgeSkillImport moduleKey={route.module} onBack={() => navigate("home")} onCreated={id => openTask("skill-submission", id, true)} />}
      {route.page === "experience" && <div className="knowledge-hub-task"><KnowledgeBackButton onClick={() => navigate("home")} /><MemoryBoard onOpenTask={onOpenTask} /></div>}
      {route.page === "task" && <div className="knowledge-hub-task">
        {route.kind === "domain" && <DomainKnowledgeExtraction focused onBack={() => navigate("tasks")} onViewKnowledge={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} key={route.id} focusId={route.id} surface={route.review ? "knowledge" : "workbench"} />}
        {route.kind === "component" && <ComponentResearch key={route.id} open focused focusId={route.id} surface={route.review ? "knowledge" : "workbench"} onClose={() => navigate("tasks")} backLabel="任务中心" onAdopt={id => navigate("module", { kbModule: "unassigned", knowledgeDocument: id })} />}
        {(route.kind === "skill-extraction" || route.kind === "skill-submission") && <KnowledgeSkillTask kind={route.kind} id={route.id} onBack={() => navigate("tasks")} onSubmitted={id => openTask("skill-submission", id, true)} />}
      </div>}
    </section>
  </KnowledgeStudioContext.Provider>;
}
