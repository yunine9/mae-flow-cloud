/**
 * 内核纵向闭环集成:克隆 fieldtest-java → 内核 bootstrap → 真 pi 会话
 * 跑 init/current → 内核门禁当场拦伪造状态的命令。
 *
 * 剧本假模型扮演 Agent 的手,内核扮演它自己——门禁打回文案、流程
 * 初始化输出、状态文件全部来自真实 dispatch/CLI,不是桩。
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

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const KERNEL_ROOT = process.env.MAE_FLOW_HOME
  ?? resolve(REPO_ROOT, "..", "mae-flow");
const FIELDTEST = process.env.MAE_FLOW_FIELDTEST_JAVA
  ?? resolve(REPO_ROOT, "..", "mae-flow-fieldtest-java");
const READY = existsSync(join(KERNEL_ROOT, "hooks", "dispatch.py"))
  && existsSync(FIELDTEST);

const MAEFLOW = 'python ".mae-flow-work/bin/mae-flow.py"';

const SCRIPT: Scene[] = [
  { text: "按引导初始化流程",
    tool: { name: "bash", input: { command: `${MAEFLOW} init` } } },
  { tool: { name: "bash", input: { command: `${MAEFLOW} current` } } },
  { tool: { name: "bash",
            input: { command: "echo hacked > .mae-flow.json" } } },
  { text: "好的,先到这里。" },
];

test(
  "内核纵向闭环:bootstrap → init/current → 门禁拦伪造状态",
  { skip: READY ? false : "缺 mae-flow 内核或 fieldtest-java,跳过(跳过≠通过)" },
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
        "交付 REQ2026081401:通知服务增加静默时段配置");
      const deadline = Date.now() + 120_000;
      let task = service.get(created.id)!;
      while (!["completed", "failed"].includes(task.status)) {
        if (Date.now() > deadline) throw new Error("任务超时未收口");
        await new Promise((resolve) => setTimeout(resolve, 200));
        task = service.get(created.id)!;
      }
      assert.equal(task.status, "completed", task.detail);

      const repoDir = join(task.workspace, "mae-flow-fieldtest-java");
      // 内核真实开工:状态文件与转发壳都在克隆里,不在原仓。
      assert.ok(existsSync(join(repoDir, ".mae-flow.json")));
      assert.ok(existsSync(
        join(repoDir, ".mae-flow-work", "bin", "mae-flow.py")));
      assert.ok(!existsSync(join(FIELDTEST, ".mae-flow.json")));

      const rows = readFileSync(join(task.workspace, "transcript.jsonl"),
        "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const results = new Map<string, any>();
      const calls = new Map<string, any>();
      for (const row of rows) {
        for (const block of row.message?.content ?? []) {
          if (block.type === "tool_use") calls.set(block.id, block);
          if (block.type === "tool_result") results.set(block.tool_use_id, block);
        }
      }
      const byCommand = (fragment: string) =>
        [...calls.values()].find((block) =>
          String(block.input?.command ?? "").includes(fragment));

      // init 真实执行:流程初始化输出来自内核,不是模型嘴上说。
      const init = byCommand("mae-flow.py\" init");
      assert.ok(init, "缺 init 调用");
      assert.match(String(results.get(init.id)?.content), /流程已初始化/);
      const current = byCommand("mae-flow.py\" current");
      assert.match(String(results.get(current!.id)?.content), /当前步骤/);

      // 机器只拦谎言,在云端活着:伪造状态被内核 dispatch 当场打回。
      const forged = byCommand("echo hacked");
      assert.ok(forged, "缺伪造状态的调用");
      const verdict = results.get(forged.id);
      assert.equal(verdict?.is_error, true);
      assert.match(String(verdict?.content), /禁止经 Bash 直接访问/);
    } finally {
      await model.stop();
    }
  },
);
