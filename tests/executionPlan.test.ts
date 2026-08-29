import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearExecutionPlanCache,
  readCurrentExecutionPlan,
} from "../src/executionPlan.ts";

function fixture(valid = true): { kernelRoot: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "mfc-execution-plan-kernel-"));
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-plan-workspace-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "flow"), { recursive: true });
  writeFileSync(join(root, "flow", "flow.json"), "{}\n");
  writeFileSync(join(root, "flow", "playbooks.json"), "{}\n");
  writeFileSync(join(workspace, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 3,
  }));
  const script = join(root, "scripts", "mae-flow.py");
  const response = valid ? {
    schema: "mae-flow-execution-plan/1",
    plan_id: "platform.construction@1.0.0",
    plan_revision: "abc1234567890123",
    step: { id: "build", title: "编码", phase: "写代码", state_revision: 3 },
    strategy: {
      id: "platform.construction", version: "1.0.0", title: "完整实现与自查",
      summary: "完成实现和自查", source: "platform_default",
      selection_reason: "当前是编码阶段",
    },
    contract: { human_decision: false, evidence: [], outputs: ["完整代码"] },
    activities: [{ title: "实现", description: "完成改动", required: true }],
    resources: [{ kind: "tool", name: "容器命令", usage: "when_needed" }],
    knowledge: { loading: "indexed_on_demand", explanation: "按需读取" },
    customization: {
      mode: "bounded", customizable: ["task_instructions"],
      locked: ["真实证据"], effective_source: "platform_default+overrides",
      profile_revision: "feed123456789012",
      layers: [{
        scope: "task", source_id: "task-1", title: "本任务补充",
        instructions: "先核对旧数据",
      }],
    },
  } : { schema: "unknown" };
  writeFileSync(script, [
    "#!/usr/bin/env python3",
    `print(${JSON.stringify(JSON.stringify(response))})`,
  ].join("\n"));
  chmodSync(script, 0o755);
  return { kernelRoot: root, workspace };
}

test("Cloud 只消费内核结构化执行方案，不在 TS 侧猜阶段做法", () => {
  clearExecutionPlanCache();
  const current = fixture();
  const plan = readCurrentExecutionPlan(current);
  assert.equal(plan?.strategy.title, "完整实现与自查");
  assert.equal(plan?.step.id, "build");
  assert.deepEqual(plan?.customization.locked, ["真实证据"]);
  assert.equal(plan?.customization.layers[0].instructions, "先核对旧数据");
});

test("旧内核或损坏输出安全降级为无方案，不影响任务详情", () => {
  clearExecutionPlanCache();
  assert.equal(readCurrentExecutionPlan(fixture(false)), undefined);
  assert.equal(readCurrentExecutionPlan({
    kernelRoot: join(tmpdir(), "missing-kernel"),
    workspace: join(tmpdir(), "missing-workspace"),
  }), undefined);
});
