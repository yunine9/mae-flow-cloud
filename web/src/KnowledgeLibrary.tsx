import { useEffect, useRef, useState } from "react";
import { Blocks, BookOpen, Layers, PanelLeftClose, PanelLeftOpen, Plus, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KnowledgeDocuments } from "./KnowledgeDocuments";
import { ComponentKnowledgeWorkspace } from "./ComponentKnowledgeWorkspace";
import { ComponentResearch } from "./ComponentResearch";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import { KnowledgeStudioContext, type ExtractionKind, type KnowledgeStudioView } from "./KnowledgeStudioContext";
import { knowledgeLibraryPage, knowledgeStudioView, type KnowledgeAssetFocus } from "./knowledgeNavigation";

type Page = "documents" | ExtractionKind;
const readRoute = () => {
  const query = new URLSearchParams(location.search);
  return { view: knowledgeStudioView(location.search), page: knowledgeLibraryPage(location.search),
    document: query.get("knowledgeDocument") ?? "", component: query.get("componentResearch") ?? "", domain: query.get("domainExtraction") ?? "" };
};

export function KnowledgeLibrary({ onCategoryChange, uploadRequest, onOpenTask, onManage }: {
  category: "documents" | "skills"; onCategoryChange: (category: "documents" | "skills") => void; uploadRequest: number;
  onOpenTask: (id: string) => void; onManage: (focus?: KnowledgeAssetFocus) => void;
}) {
  const documentCategory = useRef<"documents" | "skills">("documents");
  const [route, setRoute] = useState(readRoute), [expanded, setExpanded] = useState(true);
  const [visited, setVisited] = useState(new Set<string>());
  const [upload, setUpload] = useState(uploadRequest);
  const [kind, setKind] = useState<ExtractionKind>(() => route.page === "component" ? "component" : "domain");
  useEffect(() => { const sync = () => { const next = readRoute(); setRoute(next); if (next.page !== "documents") setKind(next.page); }; addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  useEffect(() => { setUpload(uploadRequest); }, [uploadRequest]);
  useEffect(() => { onCategoryChange(route.view === "skills" ? "skills" : "documents"); }, [route.view]);
  function navigate(view: KnowledgeStudioView, page: Page, id?: string) {
    const url = new URL(location.href);
    url.searchParams.set("knowledgeView", view); url.searchParams.set("knowledgePage", page);
    if (view !== "skills") url.searchParams.delete("platformSkill");
    if (id !== undefined && page !== "documents") url.searchParams.set(page === "domain" ? "domainExtraction" : "componentResearch", id);
    if (url.href !== location.href) history.pushState(history.state, "", url);
    setRoute(readRoute());
    if (page !== "documents") setKind(page);
  }
  const openExecution = (next: ExtractionKind, id = "new") => navigate("workbench", next, id);
  const openResult = (next: ExtractionKind, id: string) => navigate("knowledge", next, id);
  const documentPage = route.view === "skills" || route.page === "documents";
  if (documentPage) documentCategory.current = route.view === "skills" ? "skills" : "documents";
  const surface = route.view === "knowledge" ? "knowledge" : "workbench";
  const panel = documentPage ? "documents" : route.page === "domain" ? "domain" : route.view === "workbench" || !!route.component ? "component" : "governance";
  useEffect(() => { setVisited(old => new Set([...old, panel])); }, [panel]);
  const mounted = (name: string) => panel === name || visited.has(name);
  return <KnowledgeStudioContext.Provider value={{ view: route.view, openExecution, openResult }}>
    <section className={`knowledge-studio ${route.view === "knowledge" ? "studio-result" : ""} ${expanded ? "studio-expanded" : ""}`} aria-label="知识工作室">
      <header className="studio-header">
        <div className="studio-brand"><Button size="icon" variant="ghost" aria-label={expanded ? "显示平台导航" : "展开工作室"} onClick={() => setExpanded(!expanded)}>{expanded ? <PanelLeftOpen /> : <PanelLeftClose />}</Button><Layers size={22} /><strong>知识工作室</strong></div>
        <nav className="studio-navigation" aria-label="知识工作室导航">
          {([["skills", "Skills", Blocks], ["workbench", "工作台", SquareTerminal], ["knowledge", "知识", BookOpen]] as const).map(([view, label, Icon]) => <button key={view} aria-current={route.view === view ? "page" : undefined} onClick={() => navigate(view, view === "workbench" ? kind : "documents")}><Icon size={17} />{label}</button>)}
        </nav>
        <div className="studio-header-actions">{documentPage && <Button onClick={() => setUpload(n => n + 1)}><Plus size={16} />{route.view === "skills" ? "上传 Skill" : "添加知识"}</Button>}</div>
      </header>
      {route.view === "workbench" && <nav className="studio-kind-switch" aria-label="萃取类型">{(["domain", "component"] as const).map(value => <Button key={value} variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => navigate("workbench", value)}>{value === "domain" ? "领域知识萃取" : "组件知识萃取"}</Button>)}</nav>}
      {route.view === "knowledge" && documentPage && <nav className="studio-kind-switch" aria-label="知识范围"><Button variant="secondary" aria-pressed>全部文档</Button><Button variant="ghost" onClick={() => navigate("knowledge", "component", "")}>组件用法与检查</Button></nav>}
      <div className="studio-content">
        {mounted("documents") && <div className="studio-panel" hidden={panel !== "documents"}><KnowledgeDocuments studio category={documentCategory.current} onCategoryChange={value => navigate(value === "skills" ? "skills" : "knowledge", "documents")} uploadRequest={upload} onOpenTask={onOpenTask} onManage={onManage} selectedDocument={route.document}
          onResearch={id => openExecution(id.startsWith("dkx-") ? "domain" : "component", id)} /></div>}
        {mounted("domain") && <div className="studio-panel" hidden={panel !== "domain"}><DomainKnowledgeExtraction focusId={route.domain} surface={panel === "domain" ? surface : undefined} /></div>}
        {mounted("component") && <div className="studio-panel" hidden={panel !== "component"}><ComponentResearch open={panel === "component"} focusId={route.component || "history"} surface={panel === "component" ? surface : undefined} onClose={() => navigate("knowledge", "documents")} onAdopt={id => { const url = new URL(location.href); url.searchParams.set("knowledgeDocument", id); history.replaceState(history.state, "", url); navigate("knowledge", "documents"); }} /></div>}
        {mounted("governance") && <div className="studio-panel" hidden={panel !== "governance"}><ComponentKnowledgeWorkspace open={panel === "governance"} onClose={() => navigate("knowledge", "documents")} onAdopt={id => { const url = new URL(location.href); url.searchParams.set("knowledgeDocument", id); history.replaceState(history.state, "", url); navigate("knowledge", "documents"); }} /></div>}
      </div>
    </section>
  </KnowledgeStudioContext.Provider>;
}
