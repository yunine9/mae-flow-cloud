import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentResearchPipeline, type ComponentWork, type ComponentWorkResult } from "../src/componentResearchPipeline.ts";
const result = (t: ComponentWork): ComponentWorkResult => ({ findings: "读取代码与实际调用后的结论", open_questions: [],
  ...(t.phase === "inventory" ? { components: [{ id: "pool", title: "异步任务", repository_ids: ["base"], scope: "src/pool.cpp" }] } : {}),
  ...(t.phase === "plan" ? { paradigms: [{ id: "submit", title: "提交任务", need: "后台执行" }] } : {}) });
test("持久任务：评审失败最多三次，接续保留完成项；不丢失范式、不混用方法版本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-pipeline-")), file = join(dir, "state.json"); const counts = new Map<string, number>();
  try {
    const execute = async (t: ComponentWork) => { counts.set(t.id, (counts.get(t.id) ?? 0) + 1); return result(t); };
    const first = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await assert.rejects(first.run({ signal: new AbortController().signal, execute, review: async t => t.phase === "paradigm" ? "来源不支持示例" : undefined, changed() {} }), /来源不支持/);
    assert.equal(counts.get("paradigm-pool-submit"), 3); assert.equal(counts.get("contracts-pool"), 1);
    const next = new ComponentResearchPipeline(file, "skill1", ["base"]);
    await next.run({ signal: new AbortController().signal, execute, review: async () => undefined, changed() {} });
    assert.equal(counts.get("contracts-pool"), 1); assert.equal(counts.get("paradigm-pool-submit"), 4);
    assert.ok(next.state.tasks.every(t => t.status === "done")); assert.equal(next.state.tasks.length, 7);
    assert.throws(() => new ComponentResearchPipeline(file, "skill2", ["base"]), /方法版本/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
