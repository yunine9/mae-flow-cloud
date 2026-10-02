import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeAssetPath,
  knowledgeLibraryPage,
  knowledgeStudioView,
  extractionSkillSearch,
  readKnowledgeAssetFocus,
} from "../web/src/knowledgeNavigation.ts";

test("团队知识管理深链可往返三类稳定身份", () => {
  const business = { kind: "business" as const,
    moduleId: "order experience", assetId: "state/rule", version: 7,
    digest: "a".repeat(64) };
  const engineering = { kind: "engineering" as const,
    candidateId: "kc-java-build", digest: "b".repeat(64) };
  const skill = { kind: "skill" as const, directory: "release-safety",
    digest: "c".repeat(64), packageDigest: "d".repeat(64) };

  for (const target of [business, engineering, skill]) {
    const path = knowledgeAssetPath(target);
    assert.ok(path.startsWith("/?"));
    assert.deepEqual(readKnowledgeAssetFocus(new URL(path, "http://local").search),
      target);
  }
});

test("残缺或未知知识深链不会误导航", () => {
  assert.equal(readKnowledgeAssetFocus("?knowledge=business&asset=state"),
    undefined);
  assert.equal(readKnowledgeAssetFocus(
    `?knowledge=business&module=orders&asset=state&version=0&digest=${"a".repeat(64)}`),
    undefined);
  assert.equal(readKnowledgeAssetFocus(
    "?knowledge=engineering&asset=x&digest=not-a-digest"), undefined);
  assert.equal(readKnowledgeAssetFocus(
    `?knowledge=skill&asset=x&digest=${"a".repeat(64)}`), undefined);
  assert.equal(readKnowledgeAssetFocus("?knowledge=unknown&asset=x"), undefined);
  assert.equal(readKnowledgeAssetFocus("?knowledge=skill"), undefined);
});


test("知识库刷新与后退优先打开显式页签，记住任务不劫持知识文档页", () => {
  assert.equal(knowledgeLibraryPage("?knowledgePage=documents&domainExtraction=dkx-1&componentResearch=cr-2"), "documents");
  assert.equal(knowledgeLibraryPage("?knowledgePage=component&domainExtraction=dkx-1"), "component");
  assert.equal(knowledgeLibraryPage("?knowledgePage=domain&componentResearch=cr-2"), "domain");
  assert.equal(knowledgeLibraryPage("?componentResearch=cr-2"), "component");
  assert.equal(knowledgeLibraryPage("?domainExtraction=dkx-1"), "domain");
});


test("管理员和开发者均有独立的一级知识库入口", () => {
  const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  const nav = app.slice(app.indexOf('<SidebarContent aria-label="视图切换"'), app.indexOf('</SidebarContent>'));
  const sections = nav.split('</> : <>');
  assert.equal(sections.length, 2, "侧栏仍分管理员与开发者两套");
  // #447 拍板:知识库是知识与团队资产的唯一一级入口,侧栏不再并列「团队资产」
  // (原断言要求两个按钮并存,是收口前的旧口径)。
  for (const section of sections) {
    assert.match(section, /<NavButton view="library"[^>]+label="知识库"/);
    assert.doesNotMatch(section, /<NavButton view="knowledge"/);
  }
  // 去掉侧栏按钮不等于删掉团队经验:它仍可从知识库「＋新增」菜单和 ?experience=1 深链到达,
  // 两条路都落到 view="knowledge" 的经验页签。
  assert.match(app, /get\("experience"\) === "1"\) return "knowledge"/, "experience 深链仍打开团队资产视图");
  assert.match(app, /onManage=\{focus => \{[^}]*"\/\?experience=1"[^}]*setView\("knowledge"\)/, "知识库的维护入口切到团队资产视图");
  const library = readFileSync(new URL("../web/src/KnowledgeLibrary.tsx", import.meta.url), "utf8");
  assert.match(library, /onClick=\{\(\) => onManage\(\)\}>团队经验与维护</, "知识库新增菜单保留团队经验入口");
});


test("工作室深链区分 Skill、执行过程与知识成果", () => {
  assert.equal(knowledgeStudioView("?knowledgePage=documents&platformSkill=domain"), "skills");
  assert.equal(knowledgeStudioView("?knowledgePage=domain"), "workbench");
  assert.equal(knowledgeStudioView("?knowledgePage=domain&domainExtraction=dkx-1"), "knowledge");
  assert.equal(knowledgeStudioView("?knowledgePage=component&componentResearch=new"), "workbench");
  assert.equal(knowledgeStudioView("?knowledgePage=documents&domainExtraction=dkx-1"), "knowledge");
  assert.equal(knowledgeStudioView("?knowledgeView=workbench&knowledgePage=domain&domainExtraction=dkx-1"), "workbench");
  assert.equal(knowledgeStudioView("?knowledgeView=knowledge&platformSkill=domain"), "knowledge");
});

test("萃取方法入口清除新旧任务定位，组件与领域均可直接维护对应 Skill", () => {
  const current = "?kbPage=research&kbKind=component&kbModule=engineering%3Acpp&kbTask=cr-old&kbReview=1&domainExtraction=dkx-old&componentResearch=cr-old&knowledgeDocument=kd-old&knowledgeDocuments=1&researchDocument=kd-research&component=old&knowledgeProbe=1&knowledgeConsolidation=1&knowledgePage=component&knowledgeView=knowledge&theme=cloud";
  for (const kind of ["component", "domain"] as const) {
    const search = extractionSkillSearch(current, kind), query = new URLSearchParams(search);
    assert.equal(query.get("platformSkill"), kind);
    assert.equal(query.get("theme"), "cloud");
    assert.equal(knowledgeLibraryPage(search), "documents");
    assert.equal(knowledgeStudioView(search), "skills");
    for (const key of ["kbPage", "kbKind", "kbModule", "kbTask", "kbReview", "domainExtraction", "componentResearch", "knowledgeDocument", "knowledgeDocuments", "researchDocument", "component", "knowledgeProbe", "knowledgeConsolidation"]) assert.equal(query.has(key), false, key);
    assert.equal(extractionSkillSearch(search, kind), search, "刷新后的同一入口保持稳定");
  }
});
