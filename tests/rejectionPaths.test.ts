/**
 * 打回与分叉路径(外部实弹空白补齐):
 *
 * 1. 配置卡答"需要修改"——流程必须停在 config_confirm 重审,
 *    推进只能发生在第二张卡的肯定决定之后(否定答案不是背书);
 * 2. 交付方式四选的另外三条(hotfix/tweak/review)——branch_create
 *    之后必须各自落进 hf_open/tw_open/rf_triage 链,收据机制对
 *    全部选项成立,不只是 happy path 的 full。
 *
 * 推进判定全由真内核裁决。缺内核仓或 fieldtest-java 时跳过并明说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const KERNEL_ROOT = process.env.MAE_FLOW_HOME
  ?? resolve(REPO_ROOT, "..", "mae-flow");
const FIELDTEST = process.env.MAE_FLOW_FIELDTEST_JAVA
  ?? resolve(REPO_ROOT, "..", "mae-flow-fieldtest-java");
const READY = existsSync(join(KERNEL_ROOT, "hooks", "dispatch.py"))
  && existsSync(FIELDTEST);

const MAEFLOW = 'python ".mae-flow-work/bin/mae-flow.py"';

function configCard() {
  return {
    questions: [
      { question: "上述完整配置是否正确?",
        options: ["确认以上全部配置", "需要修改"] },
      { question: "交付方式?",
        options: ["完整开发", "已定位问题修复", "局部修改", "处理评审意见"] },
    ],
  };
}

const REVIEWER_CARD = {
  questions: [
    { question: "是否启用独立 CODE Reviewer?",
      options: ["不启用", "启用(人工检视前先由 Agent 预检)"] },
  ],
};

function reviewScene(ticket: string, worker: string): Scene {
  return { tool: { name: "bash", input: { command:
    `${MAEFLOW} config-review --set 工号=${worker} --set 基线分支=master ` +
    `--set 单号=${ticket} --set 单号类型=REQ ` +
    `--set 需求文档=docs/req/REQ-${ticket}.md ` +
    `--set "编译方式=mvn -B -q compile" --set UT生成方式=java-autout ` +
    `--set "UT运行命令=mvn -B test"` } } };
}

function openingScenes(ticket: string): Scene[] {
  return [
    { text: "按引导初始化",
      tool: { name: "bash", input: { command: `${MAEFLOW} init` } } },
    { tool: { name: "bash", input: { command:
        `MSGID=$(${MAEFLOW} messages | awk '/交付/{print $1; exit}') && ` +
        `${MAEFLOW} requirement-record --message-id "$MSGID" --ticket ${ticket}` } } },
  ];
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface Walk {
  service: TaskService;
  id: string;
}

/** 依次代答等待卡;返回按出现顺序的 waiting_id 列表。 */
async function answerCards(
  walk: Walk,
  answersPerCard: Array<Record<string, string>>,
): Promise<string[]> {
  const seen: string[] = [];
  for (const answers of answersPerCard) {
    const task = await until(() => {
      const now = walk.service.get(walk.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human"
        && !seen.includes(now.waiting!.waiting_id)
        ? now : undefined;
    }, `第 ${seen.length + 1} 张卡`);
    seen.push(task.waiting!.waiting_id);
    await walk.service.decide(walk.id, {
      state_version: task.waiting!.state_version,
      answers,
    });
  }
  return seen;
}

async function runWalk(
  script: Scene[],
  requirement: string,
  answersPerCard: Array<Record<string, string>>,
): Promise<{ state: any; transcript: string; cards: string[] }> {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reject-"));
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, repoPath: FIELDTEST, python: "python3" },
  });
  try {
    const created = service.create(requirement);
    const cards = await answerCards({ service, id: created.id },
      answersPerCard);
    await until(() => {
      const now = service.get(created.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "completed" ? now : undefined;
    }, "任务收口");
    const repoDir = join(dataDir, created.id, "mae-flow-fieldtest-java");
    return {
      state: JSON.parse(
        readFileSync(join(repoDir, ".mae-flow.json"), "utf-8")),
      transcript: readFileSync(
        join(dataDir, created.id, "transcript.jsonl"), "utf-8"),
      cards,
    };
  } finally {
    await model.stop();
  }
}

test("配置打回:否定答案不是背书,重审后才准推进", {
  skip: READY ? false : "缺 mae-flow 内核或 fieldtest-java,无法裁决",
}, async () => {
  const ticket = "REQ2026081404";
  const script: Scene[] = [
    ...openingScenes(ticket),
    reviewScene(ticket, "wrongbot"),          // 第一版配置(将被打回)
    { tool: { name: "AskUserQuestion", input: configCard() } },
    { tool: { name: "bash", input: { command: `${MAEFLOW} done` } } },
    reviewScene(ticket, "cloudbot"),          // 按打回意见修正重审
    { tool: { name: "AskUserQuestion", input: configCard() } },
    { tool: { name: "bash", input: { command: `${MAEFLOW} done` } } },
    { tool: { name: "bash",
              input: { command: `${MAEFLOW} done --choice full` } } },
    { text: "已带修正配置重审并推进。" },
  ];
  const { state, transcript, cards } = await runWalk(
    script,
    `交付 ${ticket}:打回路径演练——配置先错后对`,
    [
      { "上述完整配置是否正确?": "需要修改", "交付方式?": "完整开发" },
      { "上述完整配置是否正确?": "确认以上全部配置", "交付方式?": "完整开发" },
    ],
  );
  assert.equal(cards.length, 2, "打回必须引出第二张配置卡");
  // 推进标记只许出现一次,且必须在第二张卡(重审)的工具行之后——
  // 内核把"需要修改"当背书放行就是事故。
  const advanceAt = transcript.indexOf("config_confirm done → 进入");
  const secondCardAt = transcript.lastIndexOf("上述完整配置是否正确?");
  assert.ok(advanceAt > -1, "重审确认后必须推进");
  assert.equal(transcript.indexOf("config_confirm done → 进入",
    advanceAt + 1), -1, "推进标记只许一次");
  assert.ok(advanceAt > secondCardAt,
    "推进必须发生在重审卡之后(否定答案不得当背书)");
  // 修正后的配置才是台账真相。
  assert.equal(state.config?.["工号"], "cloudbot");
});

test("交付方式分叉:hotfix/tweak/review 各入各链", {
  skip: READY ? false : "缺 mae-flow 内核或 fieldtest-java,无法裁决",
}, async () => {
  const routes = [
    { choice: "hotfix", answer: "已定位问题修复", expect: /^hf_/ },
    { choice: "tweak", answer: "局部修改", expect: /^tw_/ },
    { choice: "review", answer: "处理评审意见", expect: /^rf_/ },
  ];
  for (const [index, route] of routes.entries()) {
    const ticket = `REQ202608141${index + 5}`;
    const branch = `master_cloudbot_${ticket}`;
    const script: Scene[] = [
      ...openingScenes(ticket),
      reviewScene(ticket, "cloudbot"),
      { tool: { name: "AskUserQuestion", input: configCard() } },
      { tool: { name: "bash", input: { command: `${MAEFLOW} done` } } },
      { tool: { name: "bash",
                input: { command: `${MAEFLOW} done --choice ${route.choice}` } } },
      { tool: { name: "AskUserQuestion", input: REVIEWER_CARD } },
      { tool: { name: "bash",
                input: { command: `${MAEFLOW} done --choice disabled` } } },
      { tool: { name: "bash", input: { command:
          `git checkout -b ${branch} && ${MAEFLOW} done` } } },
      { text: "分支就绪,进入对应交付链。" },
    ];
    const { state } = await runWalk(
      script,
      `交付 ${ticket}:${route.answer}路径演练`,
      [
        { "上述完整配置是否正确?": "确认以上全部配置",
          "交付方式?": route.answer },
        { "是否启用独立 CODE Reviewer?": "不启用" },
      ],
    );
    assert.match(String(state.current), route.expect,
      `${route.choice} 应入 ${route.expect},实际 ${state.current}`);
    assert.equal(state.choices?.workflow, route.choice);
  }
});
