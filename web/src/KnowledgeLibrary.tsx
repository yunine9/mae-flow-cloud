import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { KnowledgeDocuments } from "./KnowledgeDocuments";
import { ComponentKnowledgeWorkspace } from "./ComponentKnowledgeWorkspace";
import { DomainKnowledgeExtraction } from "./DomainKnowledgeExtraction";
import { knowledgeLibraryPage, type KnowledgeAssetFocus } from "./knowledgeNavigation";

type Page = "documents" | "component" | "domain";
const routePage = () => knowledgeLibraryPage(location.search);

export function KnowledgeLibrary({ category, onCategoryChange, uploadRequest, onOpenTask, onManage }: {
  category: "documents" | "skills"; onCategoryChange: (category: "documents" | "skills") => void; uploadRequest: number;
  onOpenTask: (id: string) => void; onManage: (focus?: KnowledgeAssetFocus) => void;
}) {
  const [page, setPage] = useState<Page>(routePage), [visited, setVisited] = useState<Set<Page>>(() => new Set([routePage()]));
  const [upload, setUpload] = useState(uploadRequest);
  const [document, setDocument] = useState(new URLSearchParams(location.search).get("knowledgeDocument") ?? ""), [component, setComponent] = useState(new URLSearchParams(location.search).get("componentResearch") ?? ""), [domain, setDomain] = useState(new URLSearchParams(location.search).get("domainExtraction") ?? "");
  useEffect(() => { const sync = () => { const next = routePage(); setPage(next); if (new URLSearchParams(location.search).has("platformSkill")) onCategoryChange("skills"); setVisited(p => new Set([...p, next])); setDocument(new URLSearchParams(location.search).get("knowledgeDocument") ?? ""); setComponent(new URLSearchParams(location.search).get("componentResearch") ?? ""); setDomain(new URLSearchParams(location.search).get("domainExtraction") ?? ""); }; addEventListener("popstate", sync); return () => removeEventListener("popstate", sync); }, []);
  function choose(next: Page) { setPage(next); setVisited(old => new Set([...old, next])); const url = new URL(location.href); url.searchParams.set("knowledgePage", next); history.pushState(history.state, "", url); }
  return <section className="space-y-5">
    <nav className="tw-root flex gap-2 border-b border-line pb-4" aria-label="知识库子页面">
      <Button variant={page === "documents" ? "default" : "outline"} aria-pressed={page === "documents"} onClick={() => choose("documents")}>知识文档</Button>
      <Button variant={page === "component" ? "default" : "outline"} aria-pressed={page === "component"} onClick={() => choose("component")}>组件知识</Button>
      <Button variant={page === "domain" ? "default" : "outline"} aria-pressed={page === "domain"} onClick={() => choose("domain")}>领域知识萃取</Button>
      {page === "documents" && <Button className="ml-auto" onClick={() => setUpload(n => n + 1)}>＋ {category === "skills" ? "添加 Skill" : "添加知识"}</Button>}
    </nav>
    {visited.has("documents") && <div hidden={page !== "documents"}><KnowledgeDocuments category={category} onCategoryChange={onCategoryChange} uploadRequest={upload} onOpenTask={onOpenTask} onManage={onManage} selectedDocument={document}
      onResearch={id => { if (id.startsWith("dkx-")) { setDomain(id); choose("domain"); } else { setComponent(id); choose("component"); } }} /></div>}
    {visited.has("component") && <div hidden={page !== "component"}><ComponentKnowledgeWorkspace open={page === "component"} focusId={component} onClose={() => choose("documents")} onAdopt={id => { setDocument(id); onCategoryChange("documents"); choose("documents"); }} /></div>}
    {visited.has("domain") && <div hidden={page !== "domain"}><DomainKnowledgeExtraction focusId={domain} /></div>}
  </section>;
}
