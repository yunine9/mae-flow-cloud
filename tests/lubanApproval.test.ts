/** 小鲁班插件纯文本审批：验签、本人隔离、审批码、过期与幂等。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { WaitingRecord } from "../src/humanGate.ts";
import {
  loadLubanPluginSecret,
  LubanApprovalGateway,
  signLubanPluginCallback,
  type LubanApprovalService,
} from "../src/lubanApproval.ts";
import { createTaskServer } from "../src/server.ts";
import {
  TaskService,
  type TaskSummary,
} from "../src/taskService.ts";
import { Notifier } from "../src/notifier.ts";

const SECRET = "test-luban-plugin-secret-32-bytes-minimum";
const NOW = 1_800_000_000_000;
const TIMESTAMP = String(NOW / 1_000);

function waiting(
  taskId: string,
  questions: Array<{ question: string; options?: string[] }>,
  version = 1,
): WaitingRecord {
  return {
    waiting_id: `${taskId}:call-1`, task_id: taskId,
    step: "build_review", call_id: "call-1",
    question: { questions }, context: "编译与 UT 已通过，请核对本轮改动。",
    state_version: version, status: "waiting", decision: "", notes: "",
    created_at: "2026-08-23T00:00:00.000Z", resolved_at: "", reminders: 0,
  };
}

function task(
  id: string,
  account: string,
  title: string,
  record = waiting(id, [{ question: "Diff 通过吗？", options: ["通过", "打回"] }]),
): TaskSummary {
  return {
    id, title, requirement: title, status: "waiting_for_human",
    waiting: record, luban_account: account,
    workspace: `/tmp/${id}`, created_at: "2026-08-23T00:00:00.000Z",
  };
}

class FakeApprovalService implements LubanApprovalService {
  calls: Array<{ id: string; decision?: string; notes?: string }> = [];

  constructor(readonly tasks: TaskSummary[]) {}

  list(): TaskSummary[] {
    return this.tasks;
  }

  async decide(id: string, input: {
    state_version: number;
    decision?: string;
    notes?: string;
  }): Promise<TaskSummary> {
    const found = this.tasks.find((item) => item.id === id)!;
    if (found.status !== "waiting_for_human" || !found.waiting
        || found.waiting.state_version !== input.state_version) {
      throw new Error("任务状态已变化");
    }
    this.calls.push({ id, decision: input.decision, notes: input.notes });
    found.status = "running";
    found.waiting = undefined;
    return found;
  }
}

function callback(
  gateway: LubanApprovalGateway,
  body: Record<string, unknown>,
  signatureOverride?: string,
) {
  const rawBody = JSON.stringify(body);
  return gateway.handle({
    rawBody,
    timestamp: TIMESTAMP,
    signature: signatureOverride
      ?? signLubanPluginCallback(SECRET, TIMESTAMP, rawBody),
  });
}

function codeOf(text: string): string {
  const match = text.match(/【([A-F0-9]{10})】/);
  assert.ok(match, `没有找到审批码：${text}`);
  return match[1];
}

function gateway(service: FakeApprovalService): LubanApprovalGateway {
  return new LubanApprovalGateway(service, {
    secret: SECRET, now: () => NOW,
    accountEnabled: (account) => ["alice", "bob"].includes(account),
  });
}

test("手机审批只列本人待办，详情使用绑定当前版本的短审批码", async () => {
  const service = new FakeApprovalService([
    task("task-1", "alice", "支付接口修复"),
    task("task-2", "bob", "不能泄露给 Alice 的任务"),
  ]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "m-1", sender: "alice", content: "mae-flow 待审批",
  });
  assert.equal(listed.status, 200);
  assert.match(listed.text, /支付接口修复/);
  assert.doesNotMatch(listed.text, /不能泄露/);

  const code = codeOf(listed.text);
  const detail = await callback(entry, {
    message_id: "m-2", sender: "alice", content: `mae-flow 详情 ${code}`,
  });
  assert.equal(detail.status, 200);
  assert.match(detail.text, /编译与 UT 已通过/);
  assert.match(detail.text, /1\. 通过/);
  assert.match(detail.text, new RegExp(`mae-flow 选择 ${code}`));

  service.tasks[0].waiting!.state_version += 1;
  const stale = await callback(entry, {
    message_id: "m-3", sender: "alice", content: `mae-flow 详情 ${code}`,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /已更新|已过期/);
});

test("选择与退回始终提交选项原文；同 message_id 并发/重放不重复决定", async () => {
  const service = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = gateway(service);
  const listed = await callback(entry, {
    message_id: "list", sender: "alice", content: "mae-flow 待审批",
  });
  const code = codeOf(listed.text);
  const body = { message_id: "approve-1", sender: "alice", content: `mae-flow 通过 ${code}` };
  const [first, repeated] = await Promise.all([
    callback(entry, body), callback(entry, body),
  ]);
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.replayed, true);
  assert.deepEqual(service.calls, [{
    id: "task-1", decision: "通过", notes: "小鲁班手机审批",
  }]);

  const rejectService = new FakeApprovalService([task("task-3", "alice", "异常补充")]);
  const rejectEntry = gateway(rejectService);
  const rejectCode = codeOf((await callback(rejectEntry, {
    message_id: "list-2", sender: "alice", content: "mae-flow 待审批",
  })).text);
  const noReason = await callback(rejectEntry, {
    message_id: "reject-empty", sender: "alice", content: `mae-flow 退回 ${rejectCode}`,
  });
  assert.equal(noReason.status, 400);
  const rejected = await callback(rejectEntry, {
    message_id: "reject", sender: "alice",
    content: `mae-flow 退回 ${rejectCode} 请补充异常场景`,
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejectService.calls[0].decision, "打回");
  assert.match(rejectService.calls[0].notes!, /请补充异常场景/);
});

test("验签、时间窗、账号与消息 ID 冲突均 fail-closed", async () => {
  const service = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = gateway(service);
  const bad = await callback(entry, {
    message_id: "bad", sender: "alice", content: "mae-flow 待审批",
  }, "sha256=" + "0".repeat(64));
  assert.equal(bad.status, 401);

  const rawBody = JSON.stringify({
    message_id: "old", sender: "alice", content: "mae-flow 待审批",
  });
  const oldTimestamp = String((NOW - 600_000) / 1_000);
  const old = await entry.handle({
    rawBody, timestamp: oldTimestamp,
    signature: signLubanPluginCallback(SECRET, oldTimestamp, rawBody),
  });
  assert.equal(old.status, 401);

  const disabled = await callback(entry, {
    message_id: "disabled", sender: "mallory", content: "mae-flow 待审批",
  });
  assert.equal(disabled.status, 403);

  const first = await callback(entry, {
    message_id: "same", sender: "alice", content: "mae-flow 待审批",
  });
  assert.equal(first.status, 200);
  const collision = await callback(entry, {
    message_id: "same", sender: "alice", content: "mae 帮助",
  });
  assert.equal(collision.status, 409);
});

test("多题澄清只读不提交，避免纯文本答案错配", async () => {
  const service = new FakeApprovalService([task(
    "task-many", "alice", "多题澄清",
    waiting("task-many", [
      { question: "兼容旧接口吗？", options: ["兼容", "不兼容"] },
      { question: "需要灰度吗？", options: ["需要", "不需要"] },
    ]),
  )]);
  const entry = gateway(service);
  const code = codeOf((await callback(entry, {
    message_id: "many-list", sender: "alice", content: "mae-flow 待审批",
  })).text);
  const attempt = await callback(entry, {
    message_id: "many-choose", sender: "alice", content: `mae-flow 选择 ${code} 1`,
  });
  assert.equal(attempt.status, 400);
  assert.match(attempt.text, /电脑端/);
  assert.equal(service.calls.length, 0);
});

test("通过快捷命令绝不把“不通过”当成正向选项", async () => {
  const service = new FakeApprovalService([task(
    "task-negative", "alice", "负向措辞",
    waiting("task-negative", [{
      question: "是否放行？", options: ["不通过", "稍后处理"],
    }]),
  )]);
  const entry = gateway(service);
  const code = codeOf((await callback(entry, {
    message_id: "negative-list", sender: "alice", content: "mae-flow 待审批",
  })).text);
  const result = await callback(entry, {
    message_id: "negative-pass", sender: "alice", content: `mae-flow 通过 ${code}`,
  });
  assert.equal(result.status, 400);
  assert.match(result.text, /无法安全判断/);
  assert.equal(service.calls.length, 0);
});

test("HTTP 回调复用主服务端口且不需要浏览器 Cookie", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-luban-http-"));
  const taskService = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const approvalService = new FakeApprovalService([task("task-1", "alice", "支付修复")]);
  const entry = gateway(approvalService);
  const server = createTaskServer(taskService, { lubanApproval: entry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rawBody = JSON.stringify({
      message_id: "http-1", sender: "alice", content: "mae-flow 待审批",
    });
    const response = await fetch(`${base}/integrations/luban/plugin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mfc-luban-timestamp": TIMESTAMP,
        "x-mfc-luban-signature": signLubanPluginCallback(
          SECRET, TIMESTAMP, rawBody),
      },
      body: rawBody,
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { text: string };
    assert.match(result.text, /支付修复/);

    const unsigned = await fetch(`${base}/integrations/luban/plugin`, {
      method: "POST", body: rawBody,
    });
    assert.equal(unsigned.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("插件密钥文件必须足够长且权限为 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-luban-secret-"));
  const file = join(dir, "plugin.secret");
  writeFileSync(file, SECRET);
  chmodSync(file, 0o600);
  assert.equal(loadLubanPluginSecret(file), SECRET);
  chmodSync(file, 0o644);
  assert.throws(() => loadLubanPluginSecret(file), /0600/);
});

test("启用手机入口后，待办通知告诉用户调用插件而不是只给内网链接", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    backoffMs: [],
  });
  const record = await notifier.notifyWaiting({
    waitingId: "waiting-1", taskId: "task-1", account: "alice",
    step: "build_review", summary: "Diff 通过吗？",
    link: "http://intranet/work/task-1",
  });
  assert.match(record.text, /mae-flow 待审批/);
});
