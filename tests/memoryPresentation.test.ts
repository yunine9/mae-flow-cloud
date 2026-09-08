import test from "node:test";
import assert from "node:assert/strict";
import { memoryPreparation, memorySearchPresentation } from "../web/src/memoryPresentation.ts";

test("检索加载和请求失败不能冒充未启用；刷新失败不能冒充仍然在线", () => {
  assert.equal(memorySearchPresentation().state, "unknown");
  assert.equal(memorySearchPresentation(undefined, true).label, "检索状态读取失败");
  assert.equal(memorySearchPresentation("ready", true).state, "unknown");
  assert.equal(memorySearchPresentation("absent").label, "语义检索未启用");
  assert.match(memorySearchPresentation("absent").title, /仍可记录、浏览和按索引推送/);
  assert.equal(memorySearchPresentation("unavailable").label, "语义检索暂不可用");
  assert.equal(memorySearchPresentation("ready").label, "语义检索在线");
});

test("模板、旧记录以及重启遗留的模板都表示已入库，不虚构在途整理", () => {
  for (const draft of [undefined, "template"] as const) {
    const result = memoryPreparation({ source: "annotation", draft });
    assert.equal(result.label, "已记录");
    assert.match(result.title, /可用于检索和推送/);
    assert.doesNotMatch(result.label, /起草中|整理中/);
  }
});

test("模型正在整理、成功和失败分别呈现；失败仍保留记忆", () => {
  assert.equal(memoryPreparation({ source: "prepush_fix", drafting: true }).label, "整理中");
  assert.equal(memoryPreparation({ source: "annotation", draft: "model", drafting: false }).label, "已整理");
  const failed = memoryPreparation({ source: "annotation", draft: "failed", drafting: false });
  assert.equal(failed.label, "整理失败");
  assert.match(failed.title, /已保留模板记录/);
  assert.equal(memoryPreparation({ source: "user_note" }).label, "已记录");
});
