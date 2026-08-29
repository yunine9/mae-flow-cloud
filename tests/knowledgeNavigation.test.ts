import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeAssetPath,
  readKnowledgeAssetFocus,
} from "../web/src/knowledgeNavigation.ts";

test("团队知识管理深链可往返三类稳定身份", () => {
  const business = { kind: "business" as const,
    moduleId: "order experience", assetId: "state/rule" };
  const engineering = { kind: "engineering" as const,
    candidateId: "kc-java-build" };
  const skill = { kind: "skill" as const, directory: "release-safety" };

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
  assert.equal(readKnowledgeAssetFocus("?knowledge=unknown&asset=x"), undefined);
  assert.equal(readKnowledgeAssetFocus("?knowledge=skill"), undefined);
});
