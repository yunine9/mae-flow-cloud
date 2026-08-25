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
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import {
  KnowledgeTrace,
  knowledgeUsageSnapshot,
} from "../src/knowledgeTrace.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";

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
  hostSkillsDir?: string,
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
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    hostSkillsDir,
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

test("宿主 Skill 正文和附件从任务内只读快照读取,不暴露部署源路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-skill-projection-"));
  const workspace = join(root, "repo");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  const sourceSkill = writeSkill(
    sourceRoot, "java-autout", "HOST-SKILL-DESCRIPTION-MARKER");
  writeFileSync(sourceSkill,
    "---\nname: java-autout\ndescription: HOST-SKILL-DESCRIPTION-MARKER\n"
    + "---\n\nHOST-SKILL-BODY-MARKER\n读取 references/guide.md。\n");
  const reference = join(dirname(sourceSkill), "references", "guide.md");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, "HOST-SKILL-ATTACHMENT-MARKER\n");

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.warnings, []);
  assert.equal(projected.paths.length, 1);
  const projectedSkill = projected.paths[0];
  const projectedReference = join(
    dirname(projectedSkill), "references", "guide.md");
  assert.ok(projectedSkill.startsWith(
    join(realpathSync(workspace), ".mae-flow-work")));

  const requests = await runDirect(workspace, undefined, [
    { text: "读取宿主 Skill 正文。", tool: {
      name: "read", input: { path: projectedSkill },
    } },
    { text: "读取 Skill 引用的附件。", tool: {
      name: "read", input: { path: projectedReference },
    } },
    { text: "完成。" },
  ], false, sourceRoot);
  const seen = JSON.stringify(requests);
  assert.match(seen, /HOST-SKILL-BODY-MARKER/);
  assert.match(seen, /HOST-SKILL-ATTACHMENT-MARKER/);
  assert.ok(!seen.includes(sourceSkill), "模型请求不应出现部署源 SKILL.md 路径");
});

test("宿主 Skill 包含软链接时不投影,避免附件越出部署 Skill 根", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-skill-symlink-"));
  const sourceRoot = join(root, "deployment-skills");
  const sourceSkill = writeSkill(
    sourceRoot, "unsafe-skill", "UNSAFE-SKILL-MARKER");
  const outside = join(root, "outside-secret.md");
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(outside, "SECRET\n");
  symlinkSync(outside, join(dirname(sourceSkill), "reference.md"));

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: join(root, "repo"),
    snapshotRoot: join(root, "repo", ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.paths, []);
  assert.match(projected.warnings.join("\n"), /软链接/);
});

test("宿主 Skill 只读快照损坏后会安全重建", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-skill-rebuild-"));
  const workspace = join(root, "repo");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  writeSkill(sourceRoot, "repair-skill", "REPAIR-SKILL-MARKER");
  const options = {
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  };
  const first = materializeHostSkills(options);
  assert.equal(first.paths.length, 1);
  chmodSync(dirname(first.paths[0]), 0o755);
  chmodSync(first.paths[0], 0o644);
  writeFileSync(first.paths[0], "tampered\n");

  const repaired = materializeHostSkills(options);
  assert.deepEqual(repaired.warnings, []);
  assert.equal(repaired.paths.length, 1);
  assert.match(readFileSync(repaired.paths[0], "utf-8"), /REPAIR-SKILL-MARKER/);
});

test("宿主 Skill 快照祖先是软链接时 fail-closed,不向任务外写入", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-skill-target-link-"));
  const workspace = join(root, "repo");
  const outside = join(root, "outside");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeSkill(sourceRoot, "safe-skill", "SAFE-SKILL-MARKER");
  symlinkSync(outside, join(workspace, ".mae-flow-work"), "dir");

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.paths, []);
  assert.match(projected.warnings.join("\n"), /快照路径包含软链接/);
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

test("用户选择的业务文档开局进入 Pi 上下文并留下加载足迹", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-repo-knowledge-"));
  const knowledgePath = join(workspace, "selected-orders.md");
  writeFileSync(knowledgePath, "# 订单知识\n\nORDER-KNOWLEDGE-MARKER\n");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-repository-knowledge",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(workspace, "events.jsonl")),
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    repositoryKnowledge: [{
      id: "knowledge-1",
      repository: "orders",
      title: "订单知识",
      description: "订单领域约束",
      relative_path: "docs/orders.md",
      digest: "digest",
      path: knowledgePath,
    }],
    knowledgeTrace: new KnowledgeTrace(
      join(workspace, "knowledge-events.jsonl"),
      "T-repository-knowledge", workspace,
    ),
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    assert.match(JSON.stringify(model.requests), /ORDER-KNOWLEDGE-MARKER/);
    const usage = knowledgeUsageSnapshot({ workspace })!;
    assert.ok(usage.events.some((event) => event.id === "knowledge-1"
      && event.action === "loaded"));
  } finally {
    session.dispose();
    await model.stop();
  }
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
