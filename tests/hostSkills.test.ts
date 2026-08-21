/**
 * 宿主级 skill 的契约:团队的两个 UT skill 在内网出不来仓,老宿主
 * 是"每次手动集成进 ut-generator 子 agent";云端给它一个固定的家
 * ——`<数据目录>/skills` 放一次,每个任务自动带(子 Agent 经同一
 * openSession 装配,一并带上)。
 *
 * 这里测的是真到场:skill 的名字与描述必须出现在送给模型的请求里
 * (pi 把 SKILL.md 注进系统提示,而不是提供一个 skill 工具)。
 * 读 SDK 才发现 DefaultResourceLoader 是 includeDefaults=false——
 * 不显式喂路径就一个都不装,所以这条断言必须盯着真实请求,不能只
 * 断言"我传了参数"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

const SCRIPT: Scene[] = [{ text: "写完了。" }];

function writeSkill(dir: string, name: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path,
    `---\nname: ${name}\ndescription: ${body}\n---\n\n正文:按这个口径写单测。\n`);
  return path;
}

async function runOnce(dataDir: string): Promise<string> {
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  try {
    const service = new TaskService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const id = service.create("写点单测").id;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = service.get(id)!.status;
      if (status === "completed" || status === "failed") break;
      await new Promise((tick) => setTimeout(tick, 100));
    }
    assert.equal(service.get(id)!.status, "completed",
      service.get(id)!.detail ?? "");
    return JSON.stringify(model.requests);
  } finally {
    await model.stop();
  }
}

async function runDirect(
  workspace: string,
  repositorySkillPaths?: string[],
  script: Scene[] = SCRIPT,
  linear = false,
): Promise<Array<Record<string, unknown>>> {
  const model = new ScriptedModelServer(
    script, "scripted-v1", linear ? { linear: true } : {});
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
    JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-repository-skills",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(workspace, "events.jsonl")),
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    repositorySkillPaths,
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    return model.requests;
  } finally {
    session.dispose();
    await model.stop();
  }
}

test("宿主级 skill 放一次,每个任务都带到模型眼前", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-skill-"));
  writeSkill(join(dataDir, "skills"), "java-autout",
    "内网单测写法指南 JAVA-AUTOUT-MARKER");
  const seen = await runOnce(dataDir);
  assert.match(seen, /java-autout/, "skill 名字没到模型眼前");
  assert.match(seen, /JAVA-AUTOUT-MARKER/, "skill 描述没到模型眼前");
});

test("没有 skill 目录照常跑——不是每个部署都有内网 skill", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-skill-none-"));
  const seen = await runOnce(dataDir);
  assert.ok(!seen.includes("JAVA-AUTOUT-MARKER"));
});

test("仓内 Skill 未选择时完全不可见,不再自动扫描 .pi/.claude/.cac", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-repo-skill-none-"));
  writeSkill(join(workspace, ".pi", "skills"), "repo-a",
    "REPO-A-MARKER");
  writeSkill(join(workspace, ".claude", "skills"), "repo-b",
    "REPO-B-MARKER");
  writeSkill(join(workspace, ".cac", "skills"), "repo-c",
    "REPO-C-MARKER");

  const seen = JSON.stringify(await runDirect(workspace));
  assert.ok(!seen.includes("REPO-A-MARKER"));
  assert.ok(!seen.includes("REPO-B-MARKER"));
  assert.ok(!seen.includes("REPO-C-MARKER"));
});

test("精确选择仓 A 的 Skill,不会顺带装载同目录仓 B Skill", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-repo-skill-one-"));
  const skillRoot = join(workspace, ".pi", "skills");
  const skillA = writeSkill(skillRoot, "repo-a", "REPO-A-MARKER");
  writeSkill(skillRoot, "repo-b", "REPO-B-MARKER");

  const seen = JSON.stringify(await runDirect(workspace, [skillA]));
  assert.match(seen, /REPO-A-MARKER/);
  assert.ok(!seen.includes("REPO-B-MARKER"));
});

test("子 Agent 与主 Agent 使用同一仓库 Skill allowlist", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-repo-skill-child-"));
  const skillRoot = join(workspace, ".pi", "skills");
  const skillA = writeSkill(skillRoot, "repo-a", "REPO-A-MARKER");
  writeSkill(skillRoot, "repo-b", "REPO-B-MARKER");
  const requests = await runDirect(workspace, [skillA], [
    {
      text: "交给子 Agent。",
      tool: {
        name: "Task",
        input: {
          subagent_type: "reviewer-agent",
          description: "检查实现",
          prompt: "CHILD-SKILL-CHECK",
        },
      },
    },
    { text: "子 Agent 已返回,完成。" },
  ], true);

  assert.ok(requests.length >= 2, "应至少包含主 Agent 与子 Agent 请求");
  const childRequest = JSON.stringify(requests[1]);
  assert.match(childRequest, /CHILD-SKILL-CHECK/);
  assert.match(childRequest, /REPO-A-MARKER/);
  assert.ok(!childRequest.includes("REPO-B-MARKER"));
});
