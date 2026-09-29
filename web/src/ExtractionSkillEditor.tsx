import { Button } from "@/components/ui/button";

/** 萃取页只保留导航，查看和上传统一放在知识库的 Skill 页面。 */
export function ExtractionSkillEditor({ kind }: { kind: "component" | "domain" }) {
  return <Button variant="outline" onClick={() => openExtractionSkill(kind)}>查看 Skill</Button>;
}
export function openExtractionSkill(kind: "component" | "domain") {
  const url = new URL(location.href);
  url.searchParams.set("knowledgePage", "documents");
  url.searchParams.set("knowledgeView", "skills");
  url.searchParams.set("platformSkill", kind);
  history.pushState(history.state, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}
