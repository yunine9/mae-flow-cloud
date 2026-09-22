import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeAssetPath,
  knowledgeLibraryPage,
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
  for (const section of nav.split('</> : <>')) {
    assert.match(section, /<NavButton view="library"[^>]+label="知识库"/);
    assert.match(section, /<NavButton view="knowledge"[^>]+label="团队资产"/);
  }
});
