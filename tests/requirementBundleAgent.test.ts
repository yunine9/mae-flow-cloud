import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/semanticEvents.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import {
  materializeRequirementAssets,
  parseRequirementBundle,
  storeRequirementAssets,
} from "../src/requirementBundle.ts";
import { requirementContext, type RequirementDocumentMeta } from "../src/requirementDocument.ts";

function zip(files: Array<{ name: string; content: Buffer | string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf-8");
    const content = Buffer.isBuffer(file.content)
      ? file.content : Buffer.from(file.content, "utf-8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("ZIP 图文需求端到端：Agent 收到完整原文、读取真实图片并使用识图结果", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-requirement-agent-"));
  const parsed = parseRequirementBundle("蓝色发布.zip", zip([
    {
      name: "方案/发布设计.md",
      content: "# 蓝色发布拓扑\n\n这是不可丢失的原文验收句。\n\n![发布拓扑](图片/拓扑.png)",
    },
    { name: "方案/图片/拓扑.png", content: visionProbePng() },
  ]).toString("base64"));
  const imagePath = parsed.assets[0].path;
  const main = new ScriptedModelServer([
    {
      text: "我先按需求文档引用读取图片。",
      tool: { name: "inspect_image", input: {
        images: [{ path: imagePath, label: "发布拓扑" }],
        question: "图片中从左到右有哪些颜色？",
      } },
    },
    { text: "原文要求已读取；图片证据显示从左到右是红、绿、蓝。" },
  ], "main-v1");
  const vision = new ScriptedModelServer([
    { text: "结论：红、绿、蓝。可见证据：三个色块。OCR：无。不确定项：无。" },
  ], "vision-v1");
  await main.start();
  await vision.start();
  try {
    const taskWorkspace = join(root, "task");
    const runtimeWorkspace = join(root, "repo");
    const agentDir = join(root, "agent");
    mkdirSync(taskWorkspace);
    mkdirSync(runtimeWorkspace);
    mkdirSync(agentDir);
    storeRequirementAssets(taskWorkspace, parsed.assets);
    const meta: RequirementDocumentMeta = {
      name: parsed.document_name,
      bundle_name: parsed.bundle_name,
      bytes: Buffer.byteLength(parsed.requirement),
      context_mode: "inline",
      assets: parsed.assets.map(({ content: _content, ...asset }) => asset),
    };
    materializeRequirementAssets(taskWorkspace, runtimeWorkspace, meta);

    const mainJson = main.modelsJson("main") as any;
    const visionJson = vision.modelsJson("vision") as any;
    visionJson.providers.vision.models[0].input = ["text", "image"];
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      ...mainJson.providers,
      ...visionJson.providers,
    } }));
    const eventPath = join(root, "events.jsonl");
    const session = await CloudSession.create({
      taskId: "bundle-task",
      workspace: runtimeWorkspace,
      agentDir,
      provider: "main",
      model: "main-v1",
      eventLog: new EventLog(eventPath),
      transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: runtimeWorkspace }),
      humanGate: new HumanGate(join(root, "waiting.json")),
      allowHumanQuestions: false,
      allowSubagents: false,
      vision: {
        choice: { provider: "vision", model: "vision-v1" },
        cacheDir: join(root, "vision-cache"),
      },
    });
    const prompt = requirementContext(parsed.requirement, meta);
    const outcome = await session.start(prompt);

    assert.equal(outcome.status, "turn_finished");
    const firstRequest = JSON.stringify(main.requests[0]);
    assert.match(firstRequest, /不可丢失的原文验收句/);
    assert.ok(firstRequest.includes(imagePath), "Agent 首轮必须拿到真实图片相对路径");
    assert.match(firstRequest, /InspectImage/);
    assert.equal(vision.requests.length, 1, "必须真实发起一次视觉模型请求");
    assert.match(JSON.stringify(vision.requests[0]), /"type":"image"/);
    assert.match(readFileSync(eventPath, "utf-8"), /InspectImage/);
    assert.match(session.finalReply(), /红、绿、蓝/);
    session.dispose();
  } finally {
    await main.stop();
    await vision.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

