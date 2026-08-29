/**
 * 内核纵向闭环集成:克隆 fieldtest-java,沿真实流程 happy path 一路
 * 走到需求质询(Grill)门口——init → 需求落盘 → config-review →
 * 配置确认卡(双问题) → 交付方式 → CODE Reviewer 一问 → 分支创建,
 * 途中夹一条伪造状态的命令验证内核门禁仍然在场。
 *
 * 剧本假模型扮演 Agent 的手,内核扮演它自己:每一步的推进判定、
 * ASKUSER 收据结构、choice 收据、分支证据全部由真实 dispatch/CLI
 * 裁决——这条测试红了,说明云端宿主与流程步骤文档不兼容,
 * 而不是剧本写错。缺内核仓或 fieldtest-java 时跳过并明说(跳过≠通过)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import * as fixture from "./kernelFixture.ts";

const { KERNEL_ROOT, FIELDTEST, KERNEL_SKIP } = fixture;

const MAEFLOW = 'python ".mae-flow-work/bin/mae-flow.py"';
const TICKET = "REQ2026081401";
const BRANCH = `master_cloudbot_${TICKET}`;

const CONFIG_CARD = {
  questions: [
    { question: "上述完整配置是否正确?",
      options: ["确认以上全部配置", "需要修改"],
      recommended: "确认以上全部配置" },
    { question: "交付方式?",
      options: ["完整开发", "已定位问题修复", "局部修改", "处理评审意见"],
      recommended: "完整开发" },
  ],
};

const REVIEWER_CARD = {
  questions: [
    { question: "是否启用独立 CODE Reviewer?",
      options: ["不启用", "启用(人工检视前先由 Agent 预检)"],
      recommended: "不启用" },
  ],
};

/** 幕号 = 本会话已出现的 tool_result 数。消息 ID 是动态哈希,
 * 用 bash 内联提取——真实 Agent 也是这么干的,不算剧本作弊。 */
const SCRIPT: Scene[] = [
  { text: "按引导初始化流程",
    tool: { name: "bash", input: { command: `${MAEFLOW} init` } } },
  { tool: { name: "bash", input: { command: `${MAEFLOW} current` } } },
  { tool: { name: "bash", input: { command:
      `MSGID=$(${MAEFLOW} messages | awk '/交付/{print $1; exit}') && ` +
      `${MAEFLOW} requirement-record --message-id "$MSGID" --ticket ${TICKET}` } } },
  { tool: { name: "bash", input: { command:
      `${MAEFLOW} config-review --set 工号=cloudbot --set 基线分支=master ` +
      `--set 单号=${TICKET} --set 单号类型=REQ ` +
      `--set 需求文档=docs/req/REQ-${TICKET}.md ` +
      `--set UT生成方式=java-autout` } } },
  { tool: { name: "AskUserQuestion", input: CONFIG_CARD } },
  { tool: { name: "bash", input: { command: `${MAEFLOW} done` } } },
  { tool: { name: "bash", input: { command: `${MAEFLOW} done --choice full` } } },
  { tool: { name: "AskUserQuestion", input: REVIEWER_CARD } },
  { tool: { name: "bash",
            input: { command: `${MAEFLOW} done --choice disabled` } } },
  { tool: { name: "bash",
            input: { command: "echo hacked > .mae-flow.json" } } },
  { tool: { name: "bash", input: { command:
      `git checkout -b ${BRANCH} && ${MAEFLOW} done` } } },
  { text: "分支已就绪,进入需求质询。" },
];

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

test(
  "内核纵向闭环:走到 Grill 门口不冒充完成,门禁全程在场",
  { skip: KERNEL_SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-kernel-"));
    const model = new ScriptedModelServer(SCRIPT);
    await model.start();
    const service = new TaskService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
      host: { kernelRoot: KERNEL_ROOT, repoPath: FIELDTEST, python: "python3" },
    });
    try {
      const created = service.create(
        `交付 ${TICKET}:通知服务增加静默时段配置,静默时段内普通通知不推送,紧急通知照常。`);

      // 第一停:配置确认卡(双问题),Web 决定按问题分开回答。
      const first = await until(() => {
        const task = service.get(created.id)!;
        if (task.status === "failed") throw new Error(task.detail);
        return task.status === "waiting_for_human" ? task : undefined;
      }, "配置确认卡");
      assert.equal(
        (first.waiting!.question as any).questions.length, 2);
      await service.decide(created.id, {
        state_version: first.waiting!.state_version,
        answers: {
          "上述完整配置是否正确?": "确认以上全部配置",
          "交付方式?": "完整开发",
        },
      });

      // 第二停:CODE Reviewer 一问卡。
      const second = await until(() => {
        const task = service.get(created.id)!;
        if (task.status === "failed") throw new Error(task.detail);
        return task.status === "waiting_for_human"
          && task.waiting!.waiting_id !== first.waiting!.waiting_id
          ? task : undefined;
      }, "CODE Reviewer 卡");
      await service.decide(created.id, {
        state_version: second.waiting!.state_version,
        answers: { "是否启用独立 CODE Reviewer?": "不启用" },
      });

      const stopped = await until(() => {
        const task = service.get(created.id)!;
        return task.status === "failed" ? task : undefined;
      }, "Grill 门口显式停机");
      assert.match(stopped.detail ?? "", /grill/,
        "模型在 Grill 门口提前 end_turn 只能停机，不能伪 completed");

      // 内核状态机是唯一裁决源:走到哪一步以 .mae-flow.json 为准。
      const repoDir = join(stopped.workspace, "mae-flow-fieldtest-java");
      const state = JSON.parse(
        readFileSync(join(repoDir, ".mae-flow.json"), "utf-8"));
      assert.match(String(state.current), /^grill/,
        `预期进入需求质询,实际停在 ${state.current}`);
      assert.equal(state.config?.["单号"], TICKET);

      // 需求确定性落盘 + 分支真实创建。
      assert.ok(existsSync(join(repoDir, "docs", "req", `REQ-${TICKET}.md`)));
      const branch = execFileSync(
        "git", ["branch", "--show-current"],
        { cwd: repoDir, encoding: "utf-8" }).trim();
      assert.equal(branch, BRANCH);

      // 门禁全程在场:中途伪造状态被内核打回。
      const rows = readFileSync(join(stopped.workspace, "transcript.jsonl"),
        "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const results = new Map<string, any>();
      const calls = new Map<string, any>();
      for (const row of rows) {
        for (const block of row.message?.content ?? []) {
          if (block.type === "tool_use") calls.set(block.id, block);
          if (block.type === "tool_result") {
            results.set(block.tool_use_id, block);
          }
        }
      }
      const forged = [...calls.values()].find((block) =>
        String(block.input?.command ?? "").includes("echo hacked"));
      assert.ok(forged, "缺伪造状态的调用");
      const verdict = results.get(forged.id);
      assert.equal(verdict?.is_error, true);
      assert.match(String(verdict?.content), /禁止经 Bash 直接访问/);

      // 原仓不被污染。
      assert.ok(!existsSync(join(FIELDTEST, ".mae-flow.json")));
    } finally {
      await model.stop();
    }
  },
);
