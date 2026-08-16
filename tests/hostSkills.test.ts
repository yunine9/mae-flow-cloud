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

const SCRIPT: Scene[] = [{ text: "写完了。" }];

function writeSkill(dir: string, name: string, body: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n\n正文:按这个口径写单测。\n`);
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
