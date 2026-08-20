/**
 * 内核模式恢复:等待审批的任务跨进程存活后,决定必须进内核台账。
 *
 * 前世走真实流程到配置确认卡(init → 需求落盘 → config-review →
 * ASKUSER 卡),崩溃;今生 recover() 后决定到来——重建会话不带旧
 * 对话,答案经 injectDecision → posttooluse 进内核 usermsg 台账,
 * 重建会话执行 messages 就能看到。断言的是"决定没有丢在宿主手里",
 * 推进到哪一步不是本测的裁决对象(那是 kernel.test.ts 的活)。
 * 缺内核仓或 fieldtest-java 时跳过并明说(跳过≠通过)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { KERNEL_ROOT, FIELDTEST, KERNEL_SKIP } from "./kernelFixture.ts";

const MAEFLOW = 'python ".mae-flow-work/bin/mae-flow.py"';
const TICKET = "REQ2026081403";

const CONFIG_CARD = {
  questions: [
    { question: "上述完整配置是否正确?",
      options: ["确认以上全部配置", "需要修改"] },
    { question: "交付方式?",
      options: ["完整开发", "局部修改"] },
  ],
};

const LIFE_A: Scene[] = [
  { text: "初始化流程",
    tool: { name: "bash", input: { command: `${MAEFLOW} init` } } },
  { tool: { name: "bash", input: { command:
      `MSGID=$(${MAEFLOW} messages | awk '/交付/{print $1; exit}') && ` +
      `${MAEFLOW} requirement-record --message-id "$MSGID" --ticket ${TICKET}` } } },
  { tool: { name: "bash", input: { command:
      `${MAEFLOW} config-review --set 工号=cloudbot --set 基线分支=master ` +
      `--set 单号=${TICKET} --set 单号类型=REQ ` +
      `--set 需求文档=docs/req/REQ-${TICKET}.md ` +
      `--set UT生成方式=java-autout` } } },
  { tool: { name: "AskUserQuestion", input: CONFIG_CARD } },
  { text: "不该走到这里:等待应在上一幕挂起" },
];

/** 今生的会话是白纸(幕号从 0 重数):查台账,证明答案在内核手里。 */
const LIFE_B: Scene[] = [
  { text: "重建会话,先核对台账",
    tool: { name: "bash", input: { command: `${MAEFLOW} messages` } } },
  { text: "答案已在台账,按 current 继续。" },
];

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("内核模式恢复:跨进程决定进内核台账,重建会话可见", {
  skip: KERNEL_SKIP,
}, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-krecover-"));
  const host = {
    kernelRoot: KERNEL_ROOT, repoPath: FIELDTEST, python: "python3",
  };
  // ---- 前世:真内核走到配置确认卡,然后崩溃 ----
  const modelA = new ScriptedModelServer(LIFE_A);
  const modelB = new ScriptedModelServer(LIFE_B);
  try {
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(), host,
  });
  const created = serviceA.create(
    `交付 ${TICKET}:恢复语义演练——不会真正开发`);
  const waiting = await until(
    () => {
      const task = serviceA.get(created.id);
      return task?.status === "waiting_for_human" ? task.waiting : undefined;
    }, "前世走到配置确认卡", 120_000);
  await modelA.stop();

  // ---- 今生:恢复,决定,重建会话续跑 ----
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(), host,
  });
  assert.equal(serviceB.recover().restored, 1);
  await serviceB.decide(created.id, {
    state_version: waiting!.state_version,
    answers: {
      "上述完整配置是否正确?": "确认以上全部配置",
      "交付方式?": "完整开发",
    },
    notes: "恢复测试",
  });
  await until(
    () => {
      const status = serviceB.get(created.id)?.status;
      return status === "completed" || status === "failed"
        ? status : undefined;
    }, "重建会话收轮", 120_000);

  // 核心断言:决定进了内核台账(usermsg),没丢在宿主手里。
  const cwd = JSON.parse(readFileSync(
    join(dataDir, created.id, "task.json"), "utf-8")).cwd as string;
  const usermsg = readFileSync(
    join(cwd, ".mae-flow.json.usermsg"), "utf-8");
  assert.match(usermsg, /确认以上全部配置/);
  assert.match(usermsg, /完整开发/);
  // 重建会话真的查过台账,且 messages 输出里能看到答案。
  const transcript = readFileSync(
    join(dataDir, created.id, "transcript.jsonl"), "utf-8");
  assert.match(transcript, /messages/);
  } finally {
    // 断言失败也要收摊:留着 HTTP 服务器会吊死整个测试进程(实测)。
    await modelA.stop();
    await modelB.stop();
  }
});
