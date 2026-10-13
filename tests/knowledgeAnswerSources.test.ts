import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { createKnowledgeAnswerSources, knowledgeAnswerSourceCatalog } from "../src/knowledgeAnswerSources.ts";
import type { KnowledgeAnswerExecution, KnowledgeAnswerContext, KnowledgeAnswerRecord } from "../src/knowledgeAnswerTypes.ts";
import { consumptionFixture, componentSection } from "./componentConsumptionFixture.ts";

function execution(context?: KnowledgeAnswerContext) {
  const record: KnowledgeAnswerRecord = { id: "qa-test", question: "查当前实现及测试", context, owner: "owner", status: "running", stage: "researching",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), evidence: [], activity: [], warnings: [] };
  const controller = new AbortController();
  const input: KnowledgeAnswerExecution = { record, root: "/test", signal: controller.signal, progress() {}, warn(message) { record.warnings.push(message); },
    addEvidence(value) { const evidence = { ...value, id: `e${record.evidence.length + 1}`, digest: createHash("sha256").update(value.content).digest("hex"), retrieved_at: new Date().toISOString() };
      record.evidence.push(evidence); return evidence; } };
  return { input, record, controller };
}
const run = async (sources: ReturnType<typeof createKnowledgeAnswerSources>, name: string, args: object) => {
  const result: any = await sources.tools.find(t => t.name === name)!.execute("test", args, undefined, undefined, {} as any);
  const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  try { return { result, data: JSON.parse(text), text }; } catch { return { result, data: undefined, text }; }
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "qa-sources-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function withEnv(values: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
function executable(dir: string, body: string) {
  const file = join(dir, "source-cli.mjs");
  writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 }); return file;
}

test("问答无范围显式浏览全库；明确模块隔离，目录和搜索不生成正文引用，修订变化拒绝旧位置", async () => {
  const f = fixture();
  try {
    for (const id of ["alpha", "beta"]) {
      createBusinessModule(f.dir, { id, name: id, owner: "owner", description: "业务规则", repositories: [`https://example.test/${id}.git`] }, "owner");
      publishBusinessKnowledgeAsset(f.dir, id, { id: "rule", title: `${id}规则`, summary: "条件", when_to_use: "查询规则", content: `# ${id}\n${id}条件` }, "owner");
    }
    const published = saveKnowledgeDocument(f.dir, { title: "平台规则", content: "# 范围\n先检查条件\n保留例外" }, "owner");
    const search = new KnowledgeSearch(f.dir), all = execution();
    const sources = createKnowledgeAnswerSources(all.input, { dataDir: f.dir, search });
    const referenceQuestion = execution({ document_id: published.id });
    const referenceSources = createKnowledgeAnswerSources(referenceQuestion.input, { dataDir: f.dir, search });
    assert.ok(referenceSources.description.includes(published.id));
    assert.ok(referenceSources.description.includes(published.revision));
    assert.ok(referenceSources.description.includes("平台规则"));
    assert.equal(referenceQuestion.record.evidence.length, 0, "显式参考文档只提供可直接展开的定位信息，正文仍须实际读取");
    const missingReference = execution({ document_id: "deleted-reference" });
    createKnowledgeAnswerSources(missingReference.input, { dataDir: f.dir, search });
    assert.ok(missingReference.record.warnings.some(w => w.includes("参考文档不可读")));
    const sourceList = await run(sources, "knowledge_sources", {});
    assert.equal(sourceList.data.repositories.length, 2, "未选范围时可沿知识定位全部已登记模块仓");
    const list = await run(sources, "knowledge_search", { action: "list" });
    assert.ok(list.data.documents.some((d: any) => d.id === "module:beta:rule"));
    assert.equal(all.record.evidence.length, 0);
    await run(sources, "knowledge_search", { action: "search", query: "条件" });
    assert.equal(all.record.evidence.length, 0, "检索摘要不可引用成原文");
    const read = await run(sources, "knowledge_search", { action: "read", id: published.id, revision: published.revision, start_line: 2, end_line: 3 });
    assert.match(read.data.content, /保留例外/);
    assert.equal(all.record.evidence[0].start_line, 2);
    assert.equal(all.record.evidence[0].end_line, 3);
    saveKnowledgeDocument(f.dir, { content: "# 已更新\n新位置" }, "owner", published.id);
    const stale = await run(sources, "knowledge_search", { action: "read", id: published.id, revision: published.revision, start_line: 2 });
    assert.equal(stale.result.isError, true); assert.match(stale.text, /旧行号/);
    assert.equal(all.record.evidence.length, 1);
    const scoped = createKnowledgeAnswerSources(execution({ module_ids: ["alpha"] }).input, { dataDir: f.dir, search });
    const denied = await run(scoped, "knowledge_search", { action: "read", id: "module:beta:rule", revision: "1" });
    assert.equal(denied.result.isError, true);
    const oldTask = search.catalog({ repo: "", repositories: [], moduleIds: [] });
    assert.ok(!oldTask.assets.some(a => a.id.startsWith("module:")), "现有任务默认不变成全库读取");
  } finally { f.cleanup(); }
});

test("来源不可用和新增依据预算拒绝均明确失败，不制造引用或静默截断", async () => {
  const f = fixture(), restore = withEnv({ MAE_FLOW_EC_BIN: join(f.dir, "missing-ec"), MAE_FLOW_WXDOUBAO_BIN: join(f.dir, "missing-wireless"), WXDOUBAO_USERID: "qa-user", WXDOUBAO_TOKEN: "test-source-credential" });
  try {
    const q = execution(), doc = saveKnowledgeDocument(f.dir, { title: "原文", content: "真实条件" }, "owner");
    q.input.addEvidence = () => { throw new Error("证据上下文预算已用完"); };
    const sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const denied = await run(sources, "knowledge_search", { action: "read", id: doc.id, revision: doc.revision });
    assert.equal(denied.result.isError, true); assert.match(denied.text, /预算/); assert.equal(q.record.evidence.length, 0);
    const unavailable = await run(sources, "business_knowledge", { question: "无线概念" });
    assert.equal(unavailable.result.isError, true); assert.match(unavailable.text, /未安装/); assert.equal(q.record.evidence.length, 0);
    const ec = await run(sources, "code_search", { action: "kw", query: "写法" });
    assert.equal(ec.result.isError, true); assert.equal(q.record.evidence.length, 0);
    const catalog = knowledgeAnswerSourceCatalog(f.dir, new KnowledgeSearch(f.dir));
    assert.equal(catalog.sources.find(s => s.kind === "everycode")!.available, false);
    assert.ok(q.record.warnings.length >= 2);
  } finally { restore(); f.cleanup(); }
});

test("实际问答读取可保存支付代码属性引用，敏感字面量和后续密钥不进入依据", async () => {
  const f = fixture();
  try {
    const content = ["const result = await sdk.charges.create({", "  amount,", "  apiKey: args.apiKey,", "  source: metadata.token,", "});"].join("\n");
    const safe = saveKnowledgeDocument(f.dir, { title: "公开支付示例", content }, "owner");
    const invalid = ['apiKey: "args.apiKey",', 'apiKey: args.apiKey + "fixture-suffix",',
      'const cfg = "apiKey: args.apiKey,";',
      `${content}\npassword: "fixture-only-password",`].map(content => saveKnowledgeDocument(f.dir, { title: "不能展示的示例", content }, "owner"));
    const q = execution(), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const saved = await run(sources, "knowledge_search", { action: "read", id: safe.id, revision: safe.revision });
    assert.notEqual(saved.result.isError, true, saved.text);
    assert.equal(q.record.evidence.length, 1);
    assert.equal(q.record.evidence[0].source_id, safe.id);
    assert.match(q.record.evidence[0].content, /3:   apiKey: args\.apiKey,/);
    const original = structuredClone(q.record.evidence);
    for (const document of invalid) {
      const denied = await run(sources, "knowledge_search", { action: "read", id: document.id, revision: document.revision });
      assert.equal(denied.result.isError, true);
      assert.match(denied.text, /疑似密钥/);
      assert.doesNotMatch(denied.text, /权限全开|人人可读/);
      assert.doesNotMatch(denied.text, /fixture-only-password|fixture-suffix|args\.apiKey/);
      assert.deepEqual(q.record.evidence, original);
    }
  } finally { f.cleanup(); }
});

test("组件读取保留公共配置、所选用法与尾部约束，长文分页才增加实际已读证据", async () => {
  const f = consumptionFixture();
  try {
    const section = componentSection();
    section.content += "\n" + "有条件的正文。".repeat(6000) + "\n最终必须等待退出。";
    const published = f.publish([section, componentSection("cpp", "other-usage")]);
    const q = execution(), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.data, search: new KnowledgeSearch(f.data) });
    let offset = 0, combined = "", pages = 0;
    while (true) {
      const read = await run(sources, "knowledge_search", { action: "read", id: published.id, revision: published.revision, paradigm_id: "pool-submit", offset });
      assert.notEqual(read.result.isError, true, read.text);
      combined += read.data.content; pages++;
      assert.equal(q.record.evidence.length, pages);
      assert.ok(q.record.evidence.at(-1)!.content.length <= 16000);
      if (read.data.complete) break;
      offset = read.data.next_offset;
    }
    assert.ok(pages > 1); assert.match(combined, /接入配置/); assert.match(combined, /使用 pool v2/);
    assert.match(combined, /最终必须等待退出/); assert.doesNotMatch(combined, /选定用法：other-usage/);
    assert.match(combined, /源码修订/);
  } finally { f.cleanup(); }
});

test("固定源码只用登记仓与用户所选模块仓、惰性准备一次，同轮不受工作区或新提交影响", async () => {
  const f = fixture();
  try {
    const root = join(f.dir, "repo"); mkdirSync(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
    writeFileSync(join(root, "sample.cpp"), "int value = 1;\n"); git("add", "."); git("commit", "-qm", "base");
    const revision = git("rev-parse", "HEAD");
    writeFileSync(join(f.dir, "component-repositories.json"), JSON.stringify([{ id: "base", name: "基础仓", repository: "https://example.test/base.git", branch: "main", path: "", languages: ["cpp"], description: "基础", enabled: true },
      { id: "disabled", name: "禁用", repository: "https://example.test/disabled.git", branch: "main", path: "", languages: ["cpp"], description: "禁用", enabled: false }]));
    for (const id of ["alpha", "beta"]) createBusinessModule(f.dir, { id, name: id, owner: "owner", repositories: [`https://example.test/${id}.git`], description: "模块" }, "owner");
    const q = execution({ module_ids: ["alpha"] }); let prepared = 0;
    const sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir), source: async (repository, operator, signal) => {
      assert.equal(operator, "owner"); assert.equal(signal, q.input.signal); prepared++;
      assert.ok(repository.repository.includes("base") || repository.repository.includes("alpha")); return { root, revision }; } });
    assert.equal(prepared, 0);
    const catalog = await run(sources, "knowledge_sources", {});
    assert.equal(catalog.data.repositories.length, 2);
    assert.ok(catalog.data.repositories.some((r: any) => r.id.startsWith("module:alpha:")));
    const denied = await run(sources, "component_source", { action: "read", repository_id: "https://evil.example/anything.git", path: "sample.cpp" });
    assert.equal(denied.result.isError, true); assert.equal(prepared, 0);
    await run(sources, "component_source", { action: "list", repository_id: "base" });
    assert.equal(q.record.evidence.length, 0);
    const read = await run(sources, "component_source", { action: "read", repository_id: "base", path: "sample.cpp", start: 1, end: 1 });
    assert.match(read.data.content, /value = 1/); assert.equal(q.record.evidence[0].revision, revision);
    writeFileSync(join(root, "sample.cpp"), "int value = 999;\n"); git("add", "."); git("commit", "-qm", "new");
    const again = await run(sources, "component_source", { action: "read", repository_id: "base", path: "sample.cpp", start: 1, end: 1 });
    assert.match(again.data.content, /value = 1/); assert.equal(prepared, 1);
    const listing = knowledgeAnswerSourceCatalog(f.dir, new KnowledgeSearch(f.dir));
    assert.ok(listing.repositories.some(r => r.id.startsWith("module:beta:")), "目录可选，实际读取需显式选择");
    assert.ok(!listing.repositories.some(r => r.id === "disabled"));
  } finally { f.cleanup(); }
});

test("Every Code 搜索只是定位，read 长返回分页、未知提交与上游截断明确，外部失败不当无代码", async () => {
  const f = fixture();
  const bin = executable(f.dir, 'const a=process.argv.slice(2); if(a[1]==="fail") process.exit(3); console.log(a[0]==="read" ? "int reference = 1;\\n".repeat(2400) : "repo/ref.cpp:3: example");');
  const restore = withEnv({ MAE_FLOW_EC_BIN: bin });
  try {
    const q = execution(), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    await run(sources, "code_search", { action: "kw", query: "example", purpose: "unit-test" }); assert.equal(q.record.evidence.length, 0);
    const first = await run(sources, "code_search", { action: "read", repository: "repo", path: "ref.cpp", start: 1, end: 160 });
    assert.match(first.data.content, /提交版本未确认/); assert.equal(q.record.evidence[0].revision, undefined);
    assert.equal(q.record.evidence[0].truncated, true); assert.ok(q.record.evidence[0].content.length <= 16000);
    assert.ok(!q.record.evidence[0].content.includes("上游返回已截断"), "未返回的后页没有进入已读证据");
    const next = await run(sources, "knowledge_evidence", { evidence_id: first.data.evidence_id, offset: first.data.next_offset });
    assert.equal(q.record.evidence.length, 2); assert.match(next.data.content, /上游返回已截断/);
    assert.equal(q.record.evidence[1].truncated, true, "读完保存片段不能声称上游已完整");
    const failed = await run(sources, "code_search", { action: "kw", query: "fail" });
    assert.equal(failed.result.isError, true); assert.ok(q.record.warnings.some(w => w.includes("不能据此")));
  } finally { restore(); f.cleanup(); }
});

test("问答取消 Every Code 时终止 CLI 及其子进程，失败和超限不透传原始错误", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), marker = join(f.dir, "processes.json");
  const bin = executable(f.dir, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.on('spawn',()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])));
setInterval(()=>{},1000);`);
  const restore = withEnv({ MAE_FLOW_EC_BIN: bin }), q = execution();
  const sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
  const pending = run(sources, "code_search", { action: "kw", query: "slow" });
  let pids: number[] = [];
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "等待子进程状态超过 3 秒"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    await until(() => existsSync(marker)); pids = JSON.parse(readFileSync(marker, "utf8"));
    assert.ok(pids.every(alive)); q.controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.result.isError, true); assert.match(cancelled.text, /已取消/);
    await until(() => pids.every(pid => !alive(pid)));
    assert.equal(q.record.evidence.length, 0);
    writeFileSync(bin, `#!${process.execPath}\nconsole.error('private-cli-error-value');process.exit(3);`, { mode: 0o755 });
    const errors = execution(), errorSources = createKnowledgeAnswerSources(errors.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const failed = await run(errorSources, "code_search", { action: "kw", query: "failure" });
    assert.equal(failed.result.isError, true); assert.doesNotMatch(failed.text + JSON.stringify(errors.record.warnings), /private-cli-error-value/);
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2*1024*1024));`, { mode: 0o755 });
    const oversized = await run(errorSources, "code_search", { action: "read", repository: "repo", path: "large.cpp" });
    assert.equal(oversized.result.isError, true); assert.match(oversized.text, /内容过大/);
    assert.equal(errors.record.evidence.length, 0);
  } finally {
    q.controller.abort(); await pending;
    if (!pids.length && existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8"));
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    restore(); f.cleanup();
  }
});

test("豆包只保存实际展示的背景页，未核验原文明确，取消后不会新增证据", async () => {
  const f = fixture();
  const bin = executable(f.dir, 'console.log(JSON.stringify({result:{structuredContent:{data:{text:"无线背景内容。".repeat(6000)}}}}));');
  const restore = withEnv({ MAE_FLOW_WXDOUBAO_BIN: bin, WXDOUBAO_USERID: "qa-user", WXDOUBAO_TOKEN: "test-source-credential", MAE_FLOW_WXDOUBAO_TIMEOUT_MS: "1000" });
  try {
    const q = execution(), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const first = await run(sources, "business_knowledge", { question: "无线告警背景" });
    assert.equal(first.result.isError, undefined); assert.match(first.data.content, /不能证明本系统/);
    assert.equal(q.record.evidence.length, 1); assert.ok(q.record.evidence[0].content.length <= 16000);
    assert.match(q.record.evidence[0].scope!, /原始文档未核验/);
    const next = await run(sources, "knowledge_evidence", { evidence_id: first.data.evidence_id, offset: first.data.next_offset });
    assert.equal(next.result.isError, undefined); assert.equal(q.record.evidence.length, 2);
    q.controller.abort();
    const cancelled = await run(sources, "business_knowledge", { question: "其他背景" });
    assert.equal(cancelled.result.isError, true); assert.equal(q.record.evidence.length, 2);
  } finally { restore(); f.cleanup(); }
});

test("原始资料只能读取用户显式编号，按章节位置分段，未知业务版本不使用上传时间替代", async () => {
  const f = fixture();
  try {
    const ids = ["material-11111111-1111-1111-1111-111111111111", "material-22222222-2222-2222-2222-222222222222"];
    for (const [i, id] of ids.entries()) {
      const folder = join(f.dir, "knowledge-materials", id); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "material.json"), JSON.stringify({ id, name: `资料${i}.md`, scope: "告警规则", version: "", bytes: 20000,
        digest: "a".repeat(64), state: "ready", uploaded_at: "2026-10-10", sections: [{ location: "第1章", text: "只在条件成立时执行。".repeat(3000) }],
        warnings: ["第2页表格未能解析", ...Array.from({ length: 5 }, () => "部分内容未解析。".repeat(100))],
        images: [{ id: "b".repeat(64), path: "原件/图1.png", mimeType: "image/png", bytes: 200 }] }));
    }
    const q = execution({ material_ids: [ids[0]] }), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const list = await run(sources, "knowledge_material", {}); assert.equal(list.data.materials.length, 1); assert.equal(q.record.evidence.length, 0);
    const denied = await run(sources, "knowledge_material", { id: ids[1] }); assert.equal(denied.result.isError, true);
    const first = await run(sources, "knowledge_material", { id: ids[0], section: 1 });
    assert.equal(first.data.version, null); assert.equal(q.record.evidence[0].revision, undefined);
    assert.match(q.record.evidence[0].location!, /第1章.*SHA256=/);
    assert.match(q.record.evidence[0].scope!, /第2页表格未能解析/);
    assert.match(q.record.evidence[0].scope!, /1 张图片尚未读取/);
    assert.match(q.record.evidence[0].scope!, /另有 2 条解析警告未展开/);
    assert.ok(q.record.evidence[0].scope!.length < 2000, "限制元数据随证据传递但不能无限占用上下文");
    assert.ok(first.data.next_offset > 0); assert.equal(q.record.evidence.length, 1);
    const unrelated = createKnowledgeAnswerSources(execution().input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    assert.equal((await run(unrelated, "knowledge_material", {})).data.materials.length, 0);
  } finally { f.cleanup(); }
});

test("原始图片实际返回后生成可回查证据，拒绝非视觉模型、越界路径与被改动字节", async () => {
  const f = fixture();
  try {
    const id = "material-33333333-3333-3333-3333-333333333333";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1kAAAAASUVORK5CYII=", "base64");
    const digest = createHash("sha256").update(png).digest("hex"), folder = join(f.dir, "knowledge-materials", id);
    mkdirSync(join(folder, "images"), { recursive: true }); writeFileSync(join(folder, "images", digest), png);
    writeFileSync(join(folder, "material.json"), JSON.stringify({ id, name: "设计.docx", scope: "订单", version: "v1", bytes: png.length,
      digest: "a".repeat(64), state: "ready", sections: [{ location: "转换文本", source_path: "设计.docx", text: "图示规则" }],
      images: [{ id: digest, path: "images/figure.png", mimeType: "image/png", bytes: png.length }] }));
    const q = execution({ material_ids: [id] }), sources = createKnowledgeAnswerSources(q.input, { dataDir: f.dir, search: new KnowledgeSearch(f.dir) });
    const tool = sources.tools.find(tool => tool.name === "knowledge_material")!;
    const call = (path: string, input = ["text", "image"]) => tool.execute("image", { id, image_path: path }, undefined, undefined, { model: { input } } as any) as Promise<any>;
    assert.equal((await call("images/figure.png", ["text"])).isError, true); assert.equal(q.record.evidence.length, 0);
    assert.equal((await call("../source.docx")).isError, true); assert.equal(q.record.evidence.length, 0);
    const result = await call("images/figure.png");
    assert.equal(result.isError, undefined); assert.deepEqual(result.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
    assert.equal(q.record.evidence.length, 1);
    assert.deepEqual(q.record.evidence[0].image, { path: "images/figure.png", digest, mime_type: "image/png" });
    assert.match(q.record.evidence[0].content, /未执行 OCR.*不包含图中文字/);
    assert.match(q.record.evidence[0].location!, /原文件 SHA256=.*图片 SHA256=/);
    const listing = await run(sources, "knowledge_material", {});
    assert.deepEqual(listing.data.materials[0].images_not_read, []);
    writeFileSync(join(folder, "images", digest), Buffer.alloc(png.length));
    assert.equal((await call("images/figure.png")).isError, true); assert.equal(q.record.evidence.length, 1);
  } finally { f.cleanup(); }
});
