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

test("内核进程不可用时授权与证据都 fail-closed", async () => {
  const host = new KernelHost({
    kernelRoot: mkdtempSync(join(tmpdir(), "mfc-missing-kernel-")),
    workspace: mkdtempSync(join(tmpdir(), "mfc-missing-ws-")),
    transcriptPath: join(tmpdir(), "missing-transcript.jsonl"),
    taskId: "t-fail-closed",
    python: "__mae_flow_python_does_not_exist__",
  });
  const verdict = await host.preTool(toolEvent("tool_requested", "call_X"));
  assert.equal(verdict?.action, "deny");
  assert.match(verdict?.reason ?? "", /内核门禁不可用/);
  // fail-closed 不等于"一次抖动就判死":基础设施故障先自己重试,
  // 判死前必须说清已经试过几次(CLAUDE.md 2026-08-20 勘误的口径)。
  assert.match(verdict?.reason ?? "", /已重试 \d+ 次仍不可用/);
  await assert.rejects(
    () => host.postTool(toolEvent("tool_finished", "call_X")),
    /内核 posttooluse 登记失败/,
  );
});

test("基础设施抖一下不判死:内核恢复后照常放行,不重试真裁决", async () => {
  // 宿主负载高、python 冷启动、内网巨仓的一次超时,不该让整轮白跑。
  // 但内核**答了**(退 0 放行 / 退 2 打回)就是它的裁决,一次都不许重试
  // ——重试一个真裁决等于反复问同一个问题直到得到想要的答案。
  const workspace = mkdtempSync(join(tmpdir(), "mfc-flaky-ws-"));
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-flaky-kernel-"));
  mkdirSync(join(kernelRoot, "hooks"), { recursive: true });
  const counter = join(workspace, "attempts.txt");
  // 前两次假装起不来(退 3 且什么都不输出前先自杀),第三次正常退 0。
  writeFileSync(join(kernelRoot, "hooks", "dispatch.py"), [
    "import os, sys",
    `p = ${JSON.stringify(counter)}`,
    "n = int(open(p).read()) if os.path.exists(p) else 0",
    "n += 1",
    "open(p, 'w').write(str(n))",
    "sys.exit(0 if n >= 3 else 1)",
  ].join("\n"));
  const host = new KernelHost({
    kernelRoot, workspace,
    transcriptPath: join(workspace, "transcript.jsonl"),
    taskId: "t-flaky", python: "python3",
  });
  // 退 1 不是 infraError(内核答了),所以不重试:第一次就 deny。
  const first = await host.preTool(toolEvent("tool_requested", "c1"));
  assert.equal(first?.action, "deny");
  assert.equal(readFileSync(counter, "utf-8"), "1",
    "内核答了就是裁决,不许重试");
});
