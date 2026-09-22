import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { KnowledgeDocuments } from "./KnowledgeDocuments";
import { ComponentResearch } from "./ComponentResearch";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import { knowledgeLibraryPage, type KnowledgeAssetFocus } from "./knowledgeNavigation";

type Page = "documents" | "component" | "domain";
const routePage = () => knowledgeLibraryPage(location.search);

export function KnowledgeLibrary({ category, onCategoryChange, uploadRequest, onOpenTask, onManage }: {
  category: "documents" | "skills"; onCategoryChange: (category: "documents" | "skills") => void; uploadRequest: number;
  onOpenTask: (id: string) => void; onManage: (focus?: KnowledgeAssetFocus) => void;
}) {
  const [page, setPage] = useState<Page>(routePage), [visited, setVisited] = useState<Set<Page>>(() => new Set([routePage()]));
  const [extraction, setExtraction] = useState<"component" | "domain">(() => routePage() === "domain" ? "domain" : "component");
  const [upload, setUpload] = useState(uploadRequest);
  const [document, setDocument] = useState(""), [component, setComponent] = useState(new URLSearchParams(location.search).get("componentResearch") ?? ""), [domain, setDomain] = useState(new URLSearchParams(location.search).get("domainExtraction") ?? "");
  useEffect(() => { const sync = () => { const next = routePage(); setPage(next); if (next !== "documents") setExtraction(next); setVisited(p => new Set([...p, next])); setComponent(new URLSearchParams(location.search).get("componentResearch") ?? ""); setDomain(new URLSearchParams(location.search).get("domainExtraction") ?? ""); }; addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  function choose(next: Page) { setPage(next); if (next !== "documents") setExtraction(next); setVisited(old => new Set([...old, next])); const url = new URL(location.href); url.searchParams.set("knowledgePage", next); history.pushState(history.state, "", url); }
  return <section className="space-y-5">
    <nav className="tw-root flex gap-2 border-b border-line pb-4" aria-label="知识库子页面">
      <Button variant={page === "documents" ? "default" : "outline"} aria-pressed={page === "documents"} onClick={() => choose("documents")}>知识文档</Button>
      <Button variant={page !== "documents" ? "default" : "outline"} aria-pressed={page !== "documents"} onClick={() => choose(extraction)}>知识萃取</Button>
      {page === "documents" && <Button className="ml-auto" onClick={() => setUpload(n => n + 1)}>＋ {category === "skills" ? "添加 Skill" : "添加知识"}</Button>}
    </nav>
    {page !== "documents" && <nav className="tw-root flex items-center gap-2" aria-label="知识萃取类型">
      <span className="mr-2 text-sm text-muted-foreground">萃取类型</span>
      {([["component", "基础组件萃取"], ["domain", "领域知识萃取"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={page === value ? "secondary" : "ghost"} aria-pressed={page === value} onClick={() => choose(value)}>{label}</Button>)}
    </nav>}
    {visited.has("documents") && <div hidden={page !== "documents"}><KnowledgeDocuments category={category} onCategoryChange={onCategoryChange} uploadRequest={upload} onOpenTask={onOpenTask} onManage={onManage} selectedDocument={document}
      onResearch={id => { if (id.startsWith("dkx-")) { setDomain(id); choose("domain"); } else { setComponent(id); choose("component"); } }} /></div>}
    {visited.has("component") && <div hidden={page !== "component"}><ComponentResearch open={page === "component"} focusId={component} onClose={() => choose("documents")} onAdopt={id => { setDocument(id); onCategoryChange("documents"); choose("documents"); }} /></div>}
    {visited.has("domain") && <div hidden={page !== "domain"}><DomainKnowledgeExtraction focusId={domain} /></div>}
  </section>;
}
