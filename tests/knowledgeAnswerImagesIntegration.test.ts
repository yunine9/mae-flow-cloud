import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Check } from "typebox/value";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import { createKnowledgeAnswerRunner } from "../src/knowledgeAnswerRunner.ts";
import { KnowledgeAnswers } from "../src/knowledgeAnswers.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";

test("图片问答：独立回答会话收到实际原图，图片引用可核对且只允许提问者查看", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-answer-images-"));
  const materialRoot = join(dir, "knowledge-materials"), png = visionProbePng();
  const digest = createHash("sha256").update(png).digest("hex");
  const material = await saveKnowledgeMaterial(materialRoot, { name: "图示.md", content_base64: Buffer.from("# 图示\n![色块](blocks.png)").toString("base64") });
  material.images = [{ id: digest, path: "blocks.png", mimeType: "image/png", bytes: png.length }];
  mkdirSync(join(materialRoot, material.id, "images"));
  writeFileSync(join(materialRoot, material.id, "images", digest), png);
  writeFileSync(join(materialRoot, material.id, "material.json"), JSON.stringify(material));
  let answerReceivedImage = false;
  const runner = createKnowledgeAnswerRunner({ dataDir: dir, search: () => ({} as any),
    model: () => ({ provider: "test", model: "vision", json: {} }),
    createModel: async () => ({ dispose() {}, async run(request) {
      if (request.stage === "researching") {
        const tool = request.tools.find(tool => tool.name === "knowledge_material")!;
        const response = await tool.execute("image", { id: material.id, image_path: "blocks.png" }, request.signal, undefined, { model: { input: ["text", "image"] } } as any);
        assert.deepEqual(Buffer.from((response.content.find(block => block.type === "image") as any).data, "base64"), png);
        return { text: "图片已读取", complete: true };
      }
      const sources = JSON.parse(request.user).received_evidence;
      assert.equal(sources.length, 1);
      assert.equal(sources[0].image.digest, digest);
      assert.equal(request.images?.length, 1);
      assert.deepEqual(Buffer.from(request.images![0].data, "base64"), png);
      assert.match(request.images![0].label, new RegExp(sources[0].id));
      answerReceivedImage = true;
      const result = { points: [{ kind: "answer", body: "图中从左到右有红、绿、蓝色块。", basis: [{ evidence_id: sources[0].id }] }] };
      assert.ok(Check(request.outputTool!.parameters, result));
      return { text: JSON.stringify(result), complete: true };
    } }),
  });
  const answers = new KnowledgeAnswers(dir, runner);
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "fixture-admin-password");
  auth.createUser("alice", "fixture-alice-password", "developer");
  auth.createUser("bob", "fixture-bob-password", "developer");
  const server = createTaskServer(service, { auth, knowledgeAnswers: answers });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await answers.shutdown(); await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (name: string) => (await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password: `fixture-${name}-password` }) })).headers.get("set-cookie")!.split(";")[0];
  const alice = await login("alice"), bob = await login("bob");
  const record = answers.create({ question: "图中有哪几个色块？", context: { material_ids: [material.id] } }, "alice").record;
  for (let n = 0; n < 200 && ["queued", "running"].includes(answers.get(record.id, "alice").status); n++) await new Promise(resolve => setTimeout(resolve, 5));
  const saved = answers.get(record.id, "alice");
  assert.equal(saved.status, "done", saved.error);
  assert.ok(answerReceivedImage);
  assert.match(saved.answer!.markdown, /图片：/);
  assert.doesNotMatch(saved.answer!.markdown, /来源原句/);
  const endpoint = `${base}/knowledge-answers/${record.id}/evidence/${saved.evidence[0].id}/image`;
  const own = await fetch(endpoint, { headers: { cookie: alice } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), png);
  assert.equal((await fetch(endpoint, { headers: { cookie: bob } })).status, 404);
  assert.equal((await fetch(endpoint)).status, 401);
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify({ points: [{ kind: "answer", body: "不能冒充文字原句", basis: [{ evidence_id: saved.evidence[0].id, start_line: 1, end_line: 1 }] }] }), saved.evidence), /不能伪造/);
  writeFileSync(join(materialRoot, material.id, "images", digest), "changed");
  assert.equal((await fetch(endpoint, { headers: { cookie: alice } })).status, 400, "损坏或被替换的原图不能冒充当次证据");
  assert.equal(JSON.parse(readFileSync(join(dir, "knowledge-answers", record.id, "record.json"), "utf8")).evidence[0].image.digest, digest);
});
