/**
 * 下单事实契约(.mae-flow-order.json)端到端:表单收齐的单号/基线/
 * 工号/交付方式由宿主机械写进工作区,真内核直接消费——
 *
 * 1. config-review **不带** 单号/基线分支/工号 的 --set,三项由下单
 *    事实补上,单号类型推导(REQ→feat)照旧;
 * 2. 配置确认卡只剩 Q1(交付方式下单已选,Q2 不问)——"又被问一遍"
 *    的摩擦从结构上消失;
 * 3. `done --choice tweak` 前**没有**任何交付方式卡,内核按下单事实
 *    放行并入 tw_ 链;替用户改选(--choice full)则被拒绝。
 *
 * 推进判定全由真内核裁决。缺内核仓或 fieldtest-java 时跳过并明说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { KERNEL_ROOT, FIELDTEST, KERNEL_SKIP } from "./kernelFixture.ts";

const MAEFLOW = 'python ".mae-flow-work/bin/mae-flow.py"';

// Q1 单独成卡:交付方式下单已定,配置确认不再问它——这正是本契约
// 要钉死的形状。若内核仍把 Q2 列出来,答案缺席会让确认卡对不上账,
// 测试就红:形状本身即断言。
const Q1_ONLY_CARD = {
  questions: [
    { question: "上述完整配置是否正确?",
      options: ["确认以上全部配置", "需要修改"] },
  ],
};

const REVIEWER_CARD = {
  questions: [
    { question: "是否启用独立 CODE Reviewer?",
      options: ["不启用", "启用(人工检视前先由 Agent 预检)"] },
  ],
};

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

test("下单事实:三项配置免问、Q2 不出、tweak 免卡入链、改选被拒", {
  skip: KERNEL_SKIP,
}, async () => {
  const ticket = "REQ2026081920";
  const branch = `master_cloudbot_${ticket}`;
  const script: Scene[] = [
    { text: "按引导初始化",
      tool: { name: "bash", input: { command: `${MAEFLOW} init` } } },
    { tool: { name: "bash", input: { command:
        `MSGID=$(${MAEFLOW} messages | awk '/交付/{print $1; exit}') && ` +
        `${MAEFLOW} requirement-record --message-id "$MSGID" --ticket ${ticket}` } } },
    // 关键:单号/基线分支/工号 一个 --set 都不给——该由下单事实补。
    { tool: { name: "bash", input: { command:
        `${MAEFLOW} config-review ` +
        `--set 需求文档=docs/req/REQ-${ticket}.md ` +
        `--set UT生成方式=java-autout` } } },
    { tool: { name: "AskUserQuestion", input: Q1_ONLY_CARD } },
    { tool: { name: "bash", input: { command: `${MAEFLOW} done` } } },
    // 先演一次背叛:替用户改选 full——内核必须按下单事实拒绝。
    { tool: { name: "bash",
              input: { command: `${MAEFLOW} done --choice full` } } },
    // 按下单事实执行:没有出过任何交付方式卡,直接放行。
    { tool: { name: "bash",
              input: { command: `${MAEFLOW} done --choice tweak` } } },
    { tool: { name: "AskUserQuestion", input: REVIEWER_CARD } },
    { tool: { name: "bash",
              input: { command: `${MAEFLOW} done --choice disabled` } } },
    { tool: { name: "bash", input: { command:
        `git checkout -b ${branch} && ${MAEFLOW} done` } } },
    { text: "下单事实契约演练完毕。" },
  ];
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-order-"));
  const skillDir = join(dataDir, "skills", "java-autout");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    "---\nname: java-autout\ndescription: 只负责 Java 单元测试编写\n---\n");
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, repoPath: FIELDTEST, python: "python3" },
  });
  try {
    const created = service.create(
      `交付 ${ticket}:下单事实契约演练——配置一次收齐不再问`,
      { account: "cloudbot", ticket, lane: "局部修改" });
    const cards: string[] = [];
    const perCard: Array<Record<string, string>> = [
      { "上述完整配置是否正确?": "确认以上全部配置" },
      { "是否启用独立 CODE Reviewer?": "不启用" },
    ];
    for (const answers of perCard) {
      const task = await until(() => {
        const now = service.get(created.id)!;
        if (now.status === "failed") throw new Error(now.detail);
        return now.status === "waiting_for_human"
          && !cards.includes(now.waiting!.waiting_id) ? now : undefined;
      }, `第 ${cards.length + 1} 张卡`);
      cards.push(task.waiting!.waiting_id);
      await service.decide(created.id, {
        state_version: task.waiting!.state_version,
        answers,
      });
    }
    const settled = await until(() => {
      const now = service.get(created.id)!;
      return now.status === "failed" || now.status === "completed"
        ? now : undefined;
    }, "任务收口");
    // 剧本只走到 tw_open 就结束，终态硬不变式应如实拒绝 completed；
    // 本用例关注的是此前已落袋的下单事实，不靠伪终态放行。
    assert.equal(settled.status, "failed");
    assert.match(settled.detail ?? "", /tw_open|尚未到 terminal/);
    const repoDir = join(dataDir, created.id, "mae-flow-fieldtest-java");
    // 宿主真把下单事实落了盘,且不混进交付提交(info/exclude 登记)。
    const order = JSON.parse(readFileSync(
      join(repoDir, ".mae-flow-order.json"), "utf-8"));
    assert.deepEqual(order, {
      execution_contract: {
        schema: "mae-flow-execution/1",
        host: "cloud",
        compile: "pipeline",
        ut_write: "agent",
        ut_run: "pipeline",
        codecheck: "pipeline",
        git_push: "host",
      },
      "UT生成方式": "java-autout",
      "单号": ticket, "基线分支": "master",
      "工号": "cloudbot", "交付方式": "局部修改",
    });
    if (existsSync(join(repoDir, ".git", "info"))) {
      const exclude = readFileSync(
        join(repoDir, ".git", "info", "exclude"), "utf-8");
      assert.match(exclude, /\.mae-flow-order\.json/,
        "现场文件必须挡在交付提交之外");
      // 内核会话产物同样是平台关切(run9 实锤:openspec/config.yaml 漏登
      // 记,prepush 修复 Agent 把它提交进了用户的 .gitignore 随 MR 推走)。
      for (const artifact of [
        ".mae-flow.json.exited", ".mae-flow-work/", "openspec/config.yaml",
        "docs/req/",
      ]) {
        assert.ok(exclude.includes(artifact),
          `内核会话产物 ${artifact} 必须在平台 exclude 里,不能指望用户仓的 .gitignore`);
      }
    }
    const state = JSON.parse(
      readFileSync(join(repoDir, ".mae-flow.json"), "utf-8"));
    // 三项免问事实进了台账,推导(REQ→feat)仍是内核的判定。
    assert.equal(state.config?.["单号"], ticket);
    assert.equal(state.config?.["工号"], "cloudbot");
    assert.equal(state.config?.["基线分支"], "master");
    assert.equal(state.config?.["单号类型"], "feat");
    // 免卡入链:背叛的 full 被拒,按下单事实的 tweak 放行。
    assert.match(String(state.current), /^tw_/,
      `tweak 应入 tw_ 链,实际 ${state.current}`);
    assert.equal(state.choices?.workflow, "tweak");
    const transcript = readFileSync(
      join(dataDir, created.id, "transcript.jsonl"), "utf-8");
    // 全程只出过两张卡,且没有一张问过交付方式。
    assert.equal(cards.length, 2);
    assert.ok(!transcript.includes("交付方式?"),
      "交付方式不许再被任何卡问一遍");
    assert.ok(transcript.includes("下单时选定的交付方式"),
      "替用户改选必须被内核点名拒绝");
  } finally {
    await model.stop();
  }
});
