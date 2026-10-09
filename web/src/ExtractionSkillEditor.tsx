import { Button } from "@/components/ui/button";
import { extractionSkillSearch } from "./knowledgeNavigation";

/** 萃取页只保留导航，查看和上传统一放在知识库的 Skill 页面。 */
export function ExtractionSkillEditor({ kind }: { kind: "component" | "domain" }) {
  return <Button variant="outline" onClick={() => openExtractionSkill(kind)}>萃取方法</Button>;
}
export function openExtractionSkill(kind: "component" | "domain") {
  const url = new URL(location.href);
  url.search = extractionSkillSearch(url.search, kind);
  // 从未提交的研究表单过来，页面的返回与「使用此 Skill」都回到原入口。
  const fromResearch = new URLSearchParams(location.search).get("kbPage") === "research";
  history.pushState({ ...history.state, knowledgeResearchReturn: fromResearch ? location.search : undefined }, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}
