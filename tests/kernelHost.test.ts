/**
 * 合成 Hook 载荷的形状契约:pretooluse / posttooluse 必须带同源
 * tool_use_id。内核的子 Agent 生命周期对账以 pretooluse 的
 * tool_use_id 为 invocation_id、按 posttooluse 的同名字段精确配对;
 * pre 侧缺失时内核只能自造 id 并按"当前步同类开放启动恰一条"兜底,
 * 同类子 Agent 并行派发即判 ambiguous、返回全部丢失(run3 实测,
 * 两个 build_agent_review REVIEWER 只有 started 没有 returned)。
 * 用捕获 stdin 的 dispatch.py 桩直接验证载荷,不需要真内核。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelHost } from "../src/kernelHost.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

function stubKernel(): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-stub-kernel-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "dispatch.py"), [
    "import json, os, sys",
    "line = json.dumps({'event': sys.argv[1],",
    "                   'payload': json.loads(sys.stdin.read() or '{}')},",
    "                  ensure_ascii=False)",
    "path = os.path.join(os.path.dirname(__file__), '..', 'captured.jsonl')",
    "with open(path, 'a') as f:",
    "    f.write(line + '\\n')",
    "",
  ].join("\n"));
  return root;
}

function captured(root: string): Array<{ event: string; payload: any }> {
  return readFileSync(join(root, "captured.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
}

function toolEvent(
  kind: "tool_requested" | "tool_finished",
  callId: string,
): SemanticEvent {
  return {
    eventId: 1, taskId: "t1", sessionId: "main", ts: "", kind,
    payload: {
      call_id: callId,
      name: "Task",
      input: { subagent_type: "craft-reviewer-agent", prompt: "..." },
      ...(kind === "tool_finished"
        ? { is_error: false, result: "检视完成" } : {}),
    },
  };
}

test("合成载荷:pre/post 两侧 tool_use_id 同源,生命周期可精确对账", async () => {
  const root = stubKernel();
  const host = new KernelHost({
    kernelRoot: root,
    workspace: mkdtempSync(join(tmpdir(), "mfc-stub-ws-")),
    transcriptPath: join(root, "transcript.jsonl"),
    taskId: "t1",
  });
  await host.preTool(toolEvent("tool_requested", "call_A"));
  await host.postTool(toolEvent("tool_finished", "call_A"));
  const rows = captured(root);
  const pre = rows.find((row) => row.event === "pretooluse");
  const post = rows.find((row) => row.event === "posttooluse");
  assert.equal(pre?.payload.tool_use_id, "call_A");
  assert.equal(post?.payload.tool_use_id, "call_A");
  assert.equal(pre?.payload.tool_use_id, post?.payload.tool_use_id);
});
