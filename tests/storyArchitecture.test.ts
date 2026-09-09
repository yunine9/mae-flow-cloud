import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storyArchitecture } from "../src/storyArchitecture.ts";
import { ARCHIFY_ROOT, renderArchify } from "../src/archifyRender.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { materializeArchifyReferences } from "../src/archifyReferences.ts";

const source = { schema_version: 1, diagram_type: "architecture", meta: { title: "订单同步模块", locale: "zh-CN" },
  components: [{ id: "sync", type: "backend", label: "同步与校验", pos: [40, 40], size: [180, 64] }], connections: [] };
const block = (value: unknown) => `\n\`\`\`archify\n${JSON.stringify(value)}\n\`\`\`\n`;

test("Story 图源按原文版本投影，保留行号，忽略普通代码块中的嵌套示例", () => {
  const text = "# Story\n```plantuml\nclass Order\n```\n" + block(source);
  const a = storyArchitecture(text);
  assert.equal(a.diagrams[0].title, "订单同步模块");
  assert.equal(a.diagrams[0].line, 6);
  assert.deepEqual(a.warnings, []);
  assert.notEqual(storyArchitecture(text + "\n更新职责").revision, a.revision);
  assert.equal(storyArchitecture("````text\n" + block(source) + "````").diagrams.length, 0);
  assert.equal(storyArchitecture("~~~archify\n" + JSON.stringify(source) + "\n~~~").diagrams.length, 1);
});

test("缺失、未完成、不支持或坏图源提供诊断，其他正常图仍可展示", () => {
  assert.deepEqual(storyArchitecture("# 老 Story\n只有类图").diagrams, []);
  const projection = storyArchitecture("```archify\n{bad}\n```" + block({ diagram_type: "class" }) + block(source));
  assert.equal(projection.warnings.length, 2);
  assert.equal(projection.diagrams.length, 1);
  assert.equal(projection.diagrams[0].id, "diagram-3");
  assert.match(storyArchitecture("```archify\n{}").warnings[0], /未闭合/);
  assert.match(storyArchitecture(block({ ...source, extra: "a".repeat(256 * 1024) })).warnings[0], /超过/);
});

test("真实 Archify 五种类型零安装渲染，中文与交互脚本保留，页面禁止联网", async () => {
  const files = ["web-app.architecture.json", "agent-tool-call.workflow.json", "cache-miss-request.sequence.json",
    "event-stream.dataflow.json", "agent-run.lifecycle.json"];
  for (const file of files) {
    const example = JSON.parse(readFileSync(join(ARCHIFY_ROOT, "examples", file), "utf8"));
    example.meta.locale = "zh-CN";
    example.meta.title = "订单模块验证";
    const result = await renderArchify(example);
    assert.equal(result.error, undefined, `${file}: ${result.error}`);
    assert.match(result.html!, /订单模块验证/);
    assert.match(result.html!, /<svg/);
    assert.match(result.html!, /connect-src 'none'/);
    assert.match(result.html!, /Archify\.view\.zoomIn/);
  }
});

test("图源不能让渲染器读取外部品牌、仓库或写出指定路径；坏关系不冒充成功", async () => {
  for (const field of ["brand", "sources", "repository"]) {
    const unsafe = { ...source, [field]: "https://example.invalid/private" };
    assert.equal(storyArchitecture(block(unsafe)).diagrams.length, 0);
    assert.match((await renderArchify(unsafe)).error!, /不读取外部/);
  }
  const result = await renderArchify({ ...source, connections: [{ from: "sync", to: "missing" }] });
  assert.ok(result.error); assert.equal(result.html, undefined);
  const harmless = await renderArchify({ ...source, meta: { ...source.meta, output: "/not-a-writable-path/probe.html" } });
  assert.equal(harmless.error, undefined);
  assert.match(harmless.html!, /订单同步模块/);
});

test("Agent 工作区的离线渲染器依赖齐全，可直接验证实际图源", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-archify-references-"));
  try {
    materializeArchifyReferences(root);
    const input = join(root, "input.json"), output = join(root, "preview.html");
    writeFileSync(input, JSON.stringify(source));
    execFileSync(process.execPath, [join(root, "renderers/architecture/render-architecture.mjs"), input, output],
      { cwd: root, timeout: 15000, stdio: "pipe" });
    assert.match(readFileSync(output, "utf8"), /订单同步模块/);
    assert.match(readFileSync(output, "utf8"), /<svg/);
    writeFileSync(input, JSON.stringify({ ...source, connections: [{ from: "sync", to: "missing" }] }));
    assert.throws(() => execFileSync(process.execPath,
      [join(root, "renderers/architecture/render-architecture.mjs"), input, output],
      { cwd: root, timeout: 15000, stdio: "pipe" }), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("架构 API 复用真实分析 Story、鉴权与版本检查，不接收任意文件图源", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-archify-api-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("owner", "owner-password", "developer");
  const service = new TaskService({ dataDir: join(root, "data"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("全局设计", { account: "owner", ticket: "REQ-ARCH", requirementAnalysis: true });
  const internal = (service as any).tasks.get(task.id);
  internal.cwd = join(task.workspace, "repo");
  internal.summary.requirement_graph = { stage: "analysis", repositories: [], dependencies: [] };
  const directory = join(internal.cwd, ".mae-flow-work", "REQ-ARCH");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "story.md"); writeFileSync(path, "# Story" + block(source));
  const server = createTaskServer(service, { auth });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const url = `${base}/tasks/${task.id}/architecture`;
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "owner-password" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const list = await fetch(url, { headers }).then((r) => r.json()) as { revision: string; diagrams: Array<{ source?: unknown }> };
    assert.equal(list.diagrams.length, 1);
    assert.equal(list.diagrams[0].source, undefined);
    const response = await fetch(`${url}/diagram-1?revision=${list.revision}`, { headers });
    assert.equal(response.status, 200);
    assert.match((await response.json() as { html: string }).html, /订单同步模块/);
    writeFileSync(path, "# Story\n职责改变" + block(source));
    assert.equal((await fetch(`${url}/diagram-1?revision=${list.revision}`, { headers })).status, 409);
    assert.equal((await fetch(`${url}/diagram-1`, { headers })).status, 409);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(source) })).status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done())); await service.shutdown(); rmSync(root, { recursive: true, force: true });
  }
});
