import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { deflateRawSync } from "node:zlib";
import {
  loadRequirementAssets,
  materializeRequirementAssets,
  parseRequirementBundle,
  readRequirementAsset,
  storeRequirementAssets,
} from "../src/requirementBundle.ts";
import type { RequirementDocumentMeta } from "../src/requirementDocument.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** 测试只造最朴素的 store ZIP；生产解析器同时支持 deflate。 */
function zip(files: Array<{
  name: string;
  content: Buffer | string;
  compress?: boolean;
}>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf-8");
    const content = Buffer.isBuffer(file.content)
      ? file.content : Buffer.from(file.content, "utf-8");
    const packed = file.compress ? deflateRawSync(content) : content;
    const method = file.compress ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
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

test("ZIP 需求材料包：读取 requirement.md、校验图片并改写为安全工作区路径", () => {
  const archive = zip([
    { name: "requirement.md", content: "# 目标\n\n![架构](images/arch.png)", compress: true },
    { name: "images/arch.png", content: PNG, compress: true },
  ]);
  const parsed = parseRequirementBundle("需求材料.zip", archive.toString("base64"));

  assert.equal(parsed.document_name, "requirement.md");
  assert.equal(parsed.assets.length, 1);
  assert.match(parsed.requirement,
    /!\[架构\]\(\.mae-flow-work\/requirement-assets\/[a-f0-9]{24}\.png\)/);
  assert.equal(parsed.assets[0].source_path, "images/arch.png");
  assert.deepEqual(parsed.assets[0].content, PNG);
});

test("ZIP 需求材料包：缺 Markdown、缺图和越界图片都当场拒绝", () => {
  assert.throws(() => parseRequirementBundle("bad.zip", zip([
    { name: "note.txt", content: "no" },
  ]).toString("base64")), /至少需要一份 \.md/);
  assert.throws(() => parseRequirementBundle("bad.zip", zip([
    { name: "requirement.md", content: "![图](images/missing.png)" },
  ]).toString("base64")), /图片不存在/);
  assert.throws(() => parseRequirementBundle("bad.zip", zip([
    { name: "requirement.md", content: "![图](\.\.\/outside.png)" },
  ]).toString("base64")), /越界路径/);
});

test("ZIP 中任意位置有 Markdown 即可，图片按该文档目录解析", () => {
  const parsed = parseRequirementBundle("设计包.zip", zip([
    { name: "docs/design.md", content: "# 设计\n\n![流程](assets/flow.png)" },
    { name: "docs/assets/flow.png", content: PNG },
  ]).toString("base64"));

  assert.equal(parsed.document_name, "docs/design.md");
  assert.equal(parsed.assets[0].source_path, "docs/assets/flow.png");
});

test("ZIP 只有一份 Markdown、没有图片也可以导入", () => {
  const parsed = parseRequirementBundle("纯文档.zip", zip([
    { name: "说明.md", content: "# 纯文字需求\n\n完成基本能力。" },
  ]).toString("base64"));
  assert.equal(parsed.document_name, "说明.md");
  assert.equal(parsed.assets.length, 0);
});

test("任务需求图片可持久化、复核并物化进 Agent 工作区", () => {
  const parsed = parseRequirementBundle("需求材料.zip", zip([
    { name: "requirement.md", content: "![架构](images/arch.png)" },
    { name: "images/arch.png", content: PNG },
  ]).toString("base64"));
  const task = mkdtempSync(join(tmpdir(), "mfc-requirement-bundle-task-"));
  const runtime = mkdtempSync(join(tmpdir(), "mfc-requirement-bundle-runtime-"));
  const assets = parsed.assets.map(({ content: _content, ...asset }) => asset);
  const meta: RequirementDocumentMeta = {
    name: "requirement.md", bundle_name: parsed.bundle_name,
    bytes: Buffer.byteLength(parsed.requirement), context_mode: "inline", assets,
  };

  storeRequirementAssets(task, parsed.assets);
  assert.equal(loadRequirementAssets(task, meta).length, 1);
  materializeRequirementAssets(task, runtime, meta);
  assert.deepEqual(readFileSync(join(runtime, assets[0].path)), PNG);
  assert.deepEqual(readRequirementAsset(task, meta, assets[0].path)?.content, PNG);
});

test("材料包 HTTP 预览与任务图片读取使用同一份服务端校验结果", async () => {
  const archive = zip([
    { name: "requirement.md", content: "# 图文需求\n\n![架构](images/arch.png)" },
    { name: "images/arch.png", content: PNG },
  ]);
  const encoded = archive.toString("base64");
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-bundle-api-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const previewResponse = await fetch(`${base}/requirement-bundles/preview`, {
      method: "POST",
      body: JSON.stringify({ name: "图文需求.zip", content_base64: encoded }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      requirement: string;
      assets: Array<{ path: string; content_base64: string }>;
    };
    assert.equal(preview.assets.length, 1);

    const parsed = parseRequirementBundle("图文需求.zip", encoded);
    const task = service.create(parsed.requirement, {
      requirementDocumentName: parsed.document_name,
      requirementBundleName: parsed.bundle_name,
      requirementAssets: parsed.assets,
    });
    const image = await fetch(`${base}/tasks/${task.id}/requirement-asset?path=${
      encodeURIComponent(parsed.assets[0].path)}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  } finally {
    server.close();
  }
});
