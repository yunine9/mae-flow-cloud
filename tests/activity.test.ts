/**
 * 行为摘要的契约:
 * - 折叠:连续同类动作并成一段,读文件报数量与主导目录,不逐条刷屏;
 * - 此刻:悬着的工具调用最准("正在执行命令…"),没有就报最后动作;
 * - 异常信号只陈述事实且带阈值:连续失败/文件打转/门禁反复拦/卡壳;
 *   不在跑的任务绝不报卡壳(误报比不报更坏);
 * - 容错:事件日志坏一行跳一行,观测旁路不许因半行 JSON 塌页。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { readJson } from "../src/jsonBody.ts";
import {
  buildActivity, readActivityEvents, type ActivityView,
} from "../src/activity.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

let nextId = 0;
let nextMs = Date.parse("2026-08-20T02:00:00Z");

function at(offsetSeconds: number): string {
  return new Date(
    Date.parse("2026-08-20T02:00:00Z") + offsetSeconds * 1000).toISOString();
}

function event(
  kind: string,
  payload: Record<string, unknown>,
  ts?: string,
): Record<string, unknown> {
  nextMs += 1000;
  nextId += 1;
  return {
    eventId: nextId, taskId: "t1", sessionId: "s1",
    ts: ts ?? new Date(nextMs).toISOString(), kind, payload,
  };
}

function toolPair(
  name: string,
  input: Record<string, unknown>,
  options?: { isError?: boolean; result?: string; ts?: string },
): Array<Record<string, unknown>> {
  const callId = `c${nextId + 1}`;
  return [
    event("tool_requested", { call_id: callId, name, input }, options?.ts),
    event("tool_finished", {
      call_id: callId, name, input,
      is_error: options?.isError ?? false,
      result: options?.result ?? "ok",
    }, options?.ts),
  ];
}

test("折叠:连续读文件并成一段,报数量与主导目录", () => {
  const events = [
    ...toolPair("Read", { file_path: "src/pay/A.java" }),
    ...toolPair("Read", { file_path: "src/pay/B.java" }),
    ...toolPair("Read", { file_path: "src/pay/C.java" }),
    ...toolPair("Read", { file_path: "docs/req.md" }),
    ...toolPair("Edit", { file_path: "src/pay/A.java" }),
  ];
  const view = buildActivity(events, { running: true });
  assert.equal(view.segments.length, 2);
  const [reads, edits] = view.segments;
  assert.equal(reads.kind, "read");
  assert.match(reads.title, /阅读 4 个文件/);
  assert.match(reads.title, /src\/pay\/ 为主/);
  assert.equal(edits.kind, "edit");
  assert.match(edits.title, /A\.java/);
});

test("此刻在干嘛:悬着的 Bash 调用报「正在执行命令」", () => {
  const events = [
    ...toolPair("Read", { file_path: "src/a.ts" }),
    event("tool_requested", {
      call_id: "hang", name: "Bash", input: { command: "mvn compile" },
    }),
  ];
  const view = buildActivity(events, { running: true });
  assert.match(view.now, /正在执行命令/);
  assert.match(view.now, /mvn compile/);
  assert.ok(view.now_since);
  // 停了的任务不说"正在"——那是对着尸体报心跳。
  const stopped = buildActivity(events, { running: false });
  assert.equal(stopped.now, "");
});

test("异常信号:同一命令连续失败 3 次才报,报的是事实", () => {
  const fail = () => toolPair("Bash", { command: "mvn test" },
    { isError: true, result: "BUILD FAILURE" });
  const twice = buildActivity(
    [...fail(), ...fail()], { running: true });
  assert.equal(
    twice.alerts.filter((a) => a.kind === "repeat-failure").length, 0);
  const thrice = buildActivity(
    [...fail(), ...fail(), ...fail()], { running: true });
  const alert = thrice.alerts.find((a) => a.kind === "repeat-failure");
  assert.ok(alert);
  assert.match(alert.title, /连续失败 3 次/);
  assert.match(alert.detail ?? "", /mvn test/);
  // 中途成功一次就归零:那不是撞墙,是正常的改错重试。
  const recovered = buildActivity(
    [...fail(), ...fail(),
      ...toolPair("Bash", { command: "mvn test" }), ...fail()],
    { running: true });
  assert.equal(
    recovered.alerts.filter((a) => a.kind === "repeat-failure").length, 0);
});

test("异常信号:30 分钟内同一文件反复改/门禁反复拦", () => {
  const nowMs = Date.parse(at(3600));
  const churn: Array<Record<string, unknown>> = [];
  for (let round = 0; round < 6; round += 1) {
    churn.push(...toolPair("Edit", { file_path: "src/x.ts" },
      { ts: at(3000 + round * 10) }));
  }
  churn.push(...toolPair("Edit", { file_path: "src/y.ts" },
    { ts: at(3100), isError: true, result: "被 mae-flow 门禁打回" }));
  churn.push(...toolPair("Edit", { file_path: "src/y.ts" },
    { ts: at(3110), isError: true, result: "[mae-flow] 拦截" }));
  const view = buildActivity(churn, { running: true, now: nowMs });
  assert.ok(view.alerts.some((a) =>
    a.kind === "file-churn" && /改了 6 次/.test(a.title)));
  assert.ok(view.alerts.some((a) =>
    a.kind === "gate-block" && /拦截 2 次/.test(a.title)));
});

test("卡壳只对在跑的任务报,且命令长跑与无动作阈值分开", () => {
  const nowMs = Date.parse(at(1200)); // 最后事件之后 ~20 分钟
  const idle = [...toolPair("Read", { file_path: "a.ts" }, { ts: at(0) })];
  const runningView = buildActivity(idle, { running: true, now: nowMs });
  assert.ok(runningView.alerts.some((a) =>
    a.kind === "stall" && /没有任何执行动作/.test(a.title)));
  const stoppedView = buildActivity(idle, { running: false, now: nowMs });
  assert.equal(stoppedView.alerts.length, 0);
  // 命令还在跑:20 分钟不算卡(mvn 编译很正常),30 分钟才报且说清是命令未返回。
  const longRun = [
    ...toolPair("Read", { file_path: "a.ts" }, { ts: at(0) }),
    event("tool_requested", {
      call_id: "slow", name: "Bash", input: { command: "mvn install" },
    }, at(10)),
  ];
  const patient = buildActivity(longRun, { running: true, now: nowMs });
  assert.equal(patient.alerts.filter((a) => a.kind === "stall").length, 0);
  const overdue = buildActivity(longRun, {
    running: true, now: Date.parse(at(31 * 60)),
  });
  assert.ok(overdue.alerts.some((a) =>
    a.kind === "stall" && /未返回/.test(a.title)));
});

test("路由 GET /tasks/:id/activity:真任务收口后能拿到折叠摘要;不存在 404",
  async () => {
    const script: Scene[] = [{ text: "一步收工。" }];
    const model = new ScriptedModelServer(script);
    await model.start();
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-activity-api-")),
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const server = createTaskServer(service);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({ requirement: "演练:行为摘要路由" }),
      }).then((response) => readJson(response));
      const deadline = Date.now() + 30_000;
      while (service.get(created.id)!.status !== "completed") {
        if (Date.now() > deadline) throw new Error("任务未收口");
        await new Promise((tick) => setTimeout(tick, 50));
      }

      const response = await fetch(`${base}/tasks/${created.id}/activity`);
      assert.equal(response.status, 200);
      const view = (await readJson(response)) as ActivityView;
      assert.ok(view.events_seen > 0);
      assert.ok(Array.isArray(view.segments));
      // 已收口的任务不说"正在":对着尸体不报心跳。
      assert.equal(view.now, "");
      assert.equal(view.alerts.length, 0);

      const missing = await fetch(`${base}/tasks/task-99/activity`);
      assert.equal(missing.status, 404);
    } finally {
      server.close();
      await model.stop();
    }
  });

test("容错读账本:坏行跳过,好行照常进摘要", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-activity-"));
  const path = join(dir, "events.jsonl");
  const good = toolPair("Read", { file_path: "src/ok.ts" });
  writeFileSync(path, [
    JSON.stringify(good[0]),
    "{ 半行坏 JSON",
    JSON.stringify(good[1]),
    "",
  ].join("\n"), "utf-8");
  const events = readActivityEvents(path);
  assert.equal(events.length, 2);
  const view = buildActivity(events, { running: false });
  assert.equal(view.segments.length, 1);
  assert.match(view.segments[0].title, /阅读 1 个文件/);
  assert.equal(readActivityEvents(join(dir, "missing.jsonl")).length, 0);
});
