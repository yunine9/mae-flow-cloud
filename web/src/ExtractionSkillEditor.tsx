import { Button } from "@/components/ui/button";

/** 萃取页只保留导航，查看和上传统一放在团队资产的 Skill 页面。 */
export function ExtractionSkillEditor({ kind }: { kind: "component" | "domain" }) {
  return <Button variant="outline" onClick={() => {
    const url = new URL(location.href);
    url.searchParams.set("knowledgePage", "documents");
    url.searchParams.set("platformSkill", kind);
    history.pushState(history.state, "", url);
    dispatchEvent(new PopStateEvent("popstate"));
  }}>查看萃取 Skill →</Button>;
}
