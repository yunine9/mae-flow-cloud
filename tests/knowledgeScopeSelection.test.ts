import assert from "node:assert/strict";
import { test } from "node:test";
import { businessModuleKnowledgeScopeRequest } from "../web/src/api.ts";
import { knowledgeReadGeneration } from "../web/src/knowledgeReadCache.ts";
import { canonicalKnowledgeExclusions, knowledgeScopeRows, selectKnowledgeDirectory } from "../web/src/knowledgeScopeSelection.ts";

test("目录筛选按路径边界排除子目录，保留可恢复的未知排除项", () => {
  const rows = knowledgeScopeRows(["docs", "docs/a", "docs/a/child", "docs/ab"], ["docs/a", "docs/removed"]);
  assert.deepEqual(rows.find(row => row.path === "docs"), { path: "docs", missing: false, excluded: false, inherited: false, partial: true });
  assert.equal(rows.find(row => row.path === "docs/a/child")?.inherited, true);
  assert.equal(rows.find(row => row.path === "docs/ab")?.excluded, false);
  assert.equal(rows.find(row => row.path === "docs/removed")?.missing, true);
  assert.deepEqual(selectKnowledgeDirectory(["docs/a", "docs/removed"], "docs/removed", true), ["docs/a"]);
  assert.deepEqual(knowledgeScopeRows(["docs"], [], ["docs/removed"]).find(row => row.path === "docs/removed"),
    { path: "docs/removed", missing: true, excluded: false, inherited: false, partial: false }, "恢复未知排除项后仍留在弹窗中，可在保存前再次调整");
});

test("恢复父目录同时恢复子目录，排除父目录合并已有排除项", () => {
  assert.deepEqual(selectKnowledgeDirectory(["docs/a/child", "docs/ab"], "docs/a", false), ["docs/a", "docs/ab"]);
  assert.deepEqual(selectKnowledgeDirectory(["docs/a/child", "docs/ab"], "docs/a", true), ["docs/ab"]);
  assert.deepEqual(selectKnowledgeDirectory(["docs/a", "docs/ab"], "docs", true), []);
  assert.deepEqual(selectKnowledgeDirectory(["docs/a"], "docs/a/child", true), ["docs/a"]);
  assert.deepEqual(canonicalKnowledgeExclusions(["docs/a/b", "docs/a", "docs/a", "docs/ab"]), ["docs/a", "docs/ab"]);
});

test("筛选 API 只在保存成功时清空读取缓存，冲突保留错误消息", async t => {
  const scope = { module_revision: 8, repositories: [{ repository: "https://git.test/code.git", directories: ["docs", "docs/a"], excluded_paths: ["docs/a"] }] };
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  let status = 200;
  t.mock.method(globalThis, "fetch", async (path: string, options?: RequestInit) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(status === 200 ? scope : { error: "模块已被更新，请重新读取目录" }), { status });
  });
  const generation = knowledgeReadGeneration();
  assert.deepEqual(await businessModuleKnowledgeScopeRequest("module/one"), scope);
  assert.equal(knowledgeReadGeneration(), generation);
  assert.equal(calls[0].path, "/business-modules/module%2Fone/knowledge-scope");
  assert.equal(calls[0].options?.cache, "no-store");
  assert.ok(calls[0].options?.signal instanceof AbortSignal);
  const input = { expected_revision: 7, repositories: [{ repository: scope.repositories[0].repository, excluded_paths: [] }] };
  await businessModuleKnowledgeScopeRequest("module/one", input);
  assert.equal(calls[1].options?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].options?.body)), input);
  assert.equal(knowledgeReadGeneration(), generation + 1);
  status = 409;
  await assert.rejects(businessModuleKnowledgeScopeRequest("module/one", input), /模块已被更新/);
  assert.equal(knowledgeReadGeneration(), generation + 1);
});
