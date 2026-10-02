import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeAssetPath,
  extractionSkillSearch,
  readKnowledgeAssetFocus,
} from "../web/src/knowledgeNavigation.ts";

test("B1验收3：保留业务资产与 Skill 的稳定身份深链", () => {
  const business = { kind: "business" as const,
    moduleId: "order experience", assetId: "state/rule", version: 7,
    digest: "a".repeat(64) };
  const skill = { kind: "skill" as const, directory: "release-safety",
    digest: "c".repeat(64), packageDigest: "d".repeat(64) };

  for (const target of [business, skill]) {
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


test("B1验收1：领域萃取方法使用现有阅读页，组件创建页不暴露方法维护", () => {
  const current = "?kbPage=research&kbKind=domain&kbModule=business%3Atrade&kbTask=dkx-old&kbReview=1&knowledgeDocument=kd-old&theme=cloud";
  const search = extractionSkillSearch(current, "domain"), query = new URLSearchParams(search);
  assert.equal(query.get("kbPage"), "module");
  assert.equal(query.get("kbModule"), "platform");
  assert.equal(query.get("knowledgeDocument"), "platform-skill-domain");
  assert.equal(query.get("theme"), "cloud");
  for (const key of ["kbKind", "kbTask", "kbReview"]) assert.equal(query.has(key), false, key);
  assert.equal(extractionSkillSearch(search, "domain"), search);
  const create = readFileSync(new URL("../web/src/KnowledgeResearchCreate.tsx", import.meta.url), "utf8");
  assert.match(create, /mode === "domain" && <ExtractionSkillEditor/);
  const library = readFileSync(new URL("../web/src/KnowledgeLibrary.tsx", import.meta.url), "utf8");
  assert.match(library, /route\.page === "module"[\s\S]*PlatformSkillPane/);
});

test("B1验收1：任务和配置链接打开当前阅读页，不经过旧页面", () => {
  for (const filename of ["KnowledgeFootprint", "ComponentKnowledgeCheck"]) {
    const source = readFileSync(new URL(`../web/src/${filename}.tsx`, import.meta.url), "utf8");
    assert.match(source, /kbPage=module&kbModule=unassigned&knowledgeDocument=/);
  }
  const config = readFileSync(new URL("../web/src/ComponentRepositories.tsx", import.meta.url), "utf8");
  assert.match(config, /kbPage=module&kbModule=engineering/);
});
