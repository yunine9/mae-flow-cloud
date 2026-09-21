import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ComponentResearch, type ResearchExecution } from "../src/componentResearch.ts";
import {
  componentRepositories,
  saveComponentRepository,
} from "../src/componentRepositories.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import {
  componentSourceTool,
  languageComponentSourceTool,
  codeSearchTool,
} from "../src/componentResearchTools.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { editResearchDocument, researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
const sectionData = (id: string, repository_ids: string[]) => ({ id, title: `能力 ${id}`, repository_ids,
  content: "适用场景、错误处理与资源生命周期。", interfaces: "include/file.h:1 Close(handle)",
  integration: "CMake target file，对应 libfile.so；Java 对应发布的 JAR/依赖坐标。",
  example: "基于接口整理，未编译验证。\n```cpp\nClose(handle);\n```", sources: "src/file.cpp:1；consumer/src/use.cpp:12，版本未知。", related_ids: [] });
function writeJoint(input: ResearchExecution, count = 2) {
  const ids = input.record.components!.map(c => c.id);
  input.editDocument!({ action: "overview", overview: "文件与日期能力跨仓协作，初始化先于调用；按构建依赖组合。" });
  input.editDocument!({ action: "outline", entries: Array.from({length:count}, (_, i) => ({ id:`cap-${i}`, title:`能力 cap-${i}`, repository_ids:ids })) });
  for (let i = 0; i < count; i++) input.editDocument!({ action: "section", section: sectionData(`cap-${i}`, ids) });
  return "联合草稿已保存";
}
const temporary = () => mkdtempSync(join(tmpdir(), "component-research-"));
const config = {
  name: "文件组件",
  repository: "https://code.example/cbb.git",
  branch: "main",
  path: "src",
  languages: ["cpp", "java"],
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const call = (tool: any, input: object) =>
  tool.execute("test", input, undefined, undefined, {});
test("配置必填语言、拒绝凭据和越界路径，普通操作者可编辑并留痕", () => {
  const dir = temporary();
  try {
    assert.throws(
      () => saveComponentRepository(dir, { ...config, languages: [] }, "alice"),
      /语言/,
    );
    assert.throws(
      () =>
        saveComponentRepository(
          dir,
          { ...config, repository: "https://u:token@host/r" },
          "alice",
        ),
      /凭据/,
    );
    assert.throws(
      () =>
        saveComponentRepository(
          dir,
          { ...config, path: "../outside" },
          "alice",
        ),
      /路径/,
    );
    const row = saveComponentRepository(dir, config, "alice");
    saveComponentRepository(dir, { id: row.id, enabled: false }, "bob");
    assert.equal(componentRepositories(dir)[0].enabled, false);
    assert.match(
      readFileSync(join(dir, "component-repository-audit.jsonl"), "utf8"),
      /bob/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("按组件、主题和语言复用研究；并发有界；草稿不检索，采纳后才入库且可追溯", async () => {
  const dir = temporary();
  const row = saveComponentRepository(dir, config, "alice");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let concurrent = 0,
    max = 0,
    adopts = 0;
  const research = new ComponentResearch(
    dir,
    async (input) => {
      concurrent++;
      max = Math.max(max, concurrent);
      input.evidence({ tool: "component_source", path: "src/file.cpp" });
      await hold;
      concurrent--;
      return "# 文件资源\n用完成后关闭句柄。";
    },
    () => adopts++,
  );
  try {
    const input = { component_id: row.id, language: "cpp", topic: "资源释放" };
    const first = research.start(input, "alice");
    assert.equal(research.start(input, "alice").id, first.id);
    assert.throws(
      () => research.start({ ...input, language: "python" }, "alice"),
      /语言/,
    );
    const java = research.start({ ...input, language: "java" }, "alice");
    assert.notEqual(java.id, first.id);
    const third = research.start({ ...input, topic: "UT" }, "alice");
    assert.equal(third.status, "queued");
    release();
    await until(() => research.list().every((r) => r.status === "done"));
    assert.equal(max, 2);
    assert.equal(
      collectSearchableKnowledge(dir, {
        repo: "",
        repositories: [],
        moduleIds: [],
      }).assets.length,
      0,
    );
    const doc = research.adopt(first.id, { scope: "platform" }, "bob");
    assert.deepEqual(doc.technologies, ["cpp"]);
    assert.equal(doc.research_source?.job_id, first.id);
    assert.equal(research.adopt(first.id, {}, "alice").id, doc.id);
    assert.equal(adopts, 1);
    assert.ok(
      collectSearchableKnowledge(dir, {
        repo: "",
        repositories: [],
        moduleIds: [],
      }).assets.some((a) => a.id === doc.id),
    );
    const fresh = research.start({ ...input, refresh: true }, "alice");
    assert.notEqual(fresh.id, first.id);
    await until(() => research.get(fresh.id).status === "done");
    await research.shutdown();
    const reloaded = new ComponentResearch(dir, async () => "");
    assert.equal(reloaded.get(first.id).document_id, doc.id);
    await reloaded.shutdown();
  } finally {
    release();
    await research.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("重启中断如实失败；任务 knowledge 可发起并读取记录，不依赖搜索索引在线", async () => {
  const dir = temporary();
  const row = saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async () => "# 草稿");
  try {
    const tool = createKnowledgeTool({
      service: () => undefined,
      context: () => ({ repo: "", repositories: [], moduleIds: [] }),
      research: () => research,
      researchOperator: () => "alice",
    });
    const components = await call(tool, { action: "components" });
    assert.match(components.content[0].text, /文件组件/);
    const result = await call(tool, {
      action: "research",
      component_id: row.id,
      language: "cpp",
      query: "文件读取",
    });
    assert.match(result.content[0].text, /componentResearch/);
    await until(() => research.list()[0].status === "done");
    const job = research.list()[0];
    const status = await call(tool, { action: "research_status", id: job.id });
    assert.match(status.content[0].text, /草稿/);
    await research.shutdown();
    const path = join(dir, "component-research", job.id, "record.json");
    const stale = JSON.parse(readFileSync(path, "utf8"));
    stale.status = "running";
    writeFileSync(path, JSON.stringify(stale));
    const reloaded = new ComponentResearch(dir, async () => "");
    assert.equal(reloaded.get(job.id).status, "failed");
    assert.match(reloaded.get(job.id).error!, /重启/);
    await reloaded.shutdown();
  } finally {
    await research.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("真实 Git + Pi 会话 + ec 替身：读取固定版本、查真实调用接口、生成带证据草稿", async () => {
  const dir = temporary(),
    source = join(dir, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(source, "src/file.cpp"), "void Close(Handle h);\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(source, "src/file.cpp"), "WORKTREE MODIFIED\n");
  const fakeEc = join(dir, "ec"),
    oldEc = process.env.MAE_FLOW_EC_BIN;
  writeFileSync(
    fakeEc,
    "#!/bin/sh\ncase \"$1\" in\ntools) echo '[\"search\",\"read\"]';;\nkw) echo 'consumer/src/use.cpp:12 Close(handle);';;\nread) echo 'consumer/src/use.cpp:12 Close(handle); revision unknown';;\n*) exit 2;;\nesac\n",
    { mode: 0o700 },
  );
  process.env.MAE_FLOW_EC_BIN = fakeEc;
  const row = saveComponentRepository(dir, config, "alice");
  const model = new ScriptedModelServer([
    {
      tool: {
        name: "component_source",
        input: { action: "read", path: "src/file.cpp" },
      },
    },
    {
      tool: {
        name: "code_search",
        input: { action: "kw", query: "lang:C++ Close" },
      },
    },
    {
      tool: {
        name: "code_search",
        input: {
          action: "read",
          repository: "consumer",
          path: "src/use.cpp",
          start: 1,
          end: 30,
        },
      },
    },
    { tool: { name: "research_document", input: { action: "outline", entries: [{ id: "close", title: "能力 close", repository_ids: [row.id] }] } } },
    { tool: { name: "research_document", input: { action: "overview", overview: "文件句柄与跨仓调用的资源释放关系" } } },
    { tool: { name: "research_document", input: { action: "section", section: sectionData("close", [row.id]) } } },
    { text: "已完成并保存组件及示例。" },
  ]);
  await model.start();
  const research = new ComponentResearch(dir, (input) =>
    runComponentResearch(input, {
      model: () => ({
        provider: "maeflow",
        model: "scripted-v1",
        json: model.modelsJson(),
      }),
      source: async () => ({ root: source, revision }),
    }),
  );
  try {
    const denied = await call(
      componentSourceTool(source, revision, "src", () => {}),
      { action: "read", path: "other.cpp" },
    );
    assert.match(denied.content[0].text, /范围/);
    const pinned = await call(
      componentSourceTool(source, revision, "src", () => {}),
      { action: "read", path: "src/file.cpp" },
    );
    assert.match(pinned.content[0].text, /void Close/);
    assert.doesNotMatch(pinned.content[0].text, /WORKTREE/);
    const batch = research.start({ mode: "all", language: "cpp" }, "alice");
    const job = research.get(batch.id);
    await until(() => ["done", "failed"].includes(research.get(job.id).status));
    const done = research.get(job.id);
    assert.equal(done.status, "done", done.error);
    assert.match(JSON.stringify(model.requests[0]), /跨仓联合知识研究/);
    assert.match(JSON.stringify(model.requests[0]), /不是 public 的都能用/);
    assert.match(JSON.stringify(model.requests[0]), /interface 是优先线索，不是固定白名单/);
    assert.match(JSON.stringify(model.requests[0]), /重点关注 interface\/、idl\//);
    assert.match(JSON.stringify(model.requests[0]), /#include.*CMakeLists\.txt.*target_link_libraries/);
    assert.match(JSON.stringify(model.requests[0]), /sdk\/pom\.xml；存在时必须实际读取/);
    assert.equal(done.document?.sections.length, 1);
    assert.equal(done.revision, revision);
    assert.ok(done.evidence.some(e => e.tool === "research_note"));
    assert.equal(
      done.evidence.filter(e => e.tool !== "research_note").length,
      3,
      JSON.stringify(model.requests.at(-1)),
    );
    assert.match(done.draft!, /版本未知/);
    const toolNames = (model.requests[0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    assert.ok(toolNames.includes("component_source"));
    assert.ok(toolNames.includes("code_search"));
    assert.ok(toolNames.includes("research_document"));
    assert.ok(
      !toolNames.includes("Bash") &&
        !toolNames.includes("bash") &&
        !toolNames.includes("write") &&
        !toolNames.includes("Task"),
    );
    assert.equal(git("rev-parse", "HEAD"), revision);
    assert.equal(
      readFileSync(join(source, "src/file.cpp"), "utf8"),
      "WORKTREE MODIFIED\n",
    );
    process.env.MAE_FLOW_EC_BIN = join(dir, "missing-ec");
    const failed = research.start(
      { component_id: row.id, language: "cpp", topic: "异常清理" },
      "alice",
    );
    await until(() => research.get(failed.id).status === "failed");
    assert.match(research.get(failed.id).error!, /ec/);
    const events: object[] = [];
    const failTool = await call(
      codeSearchTool((e) => events.push(e)),
      { action: "kw", query: "Close" },
    );
    assert.match(failTool.content[0].text, /失败/);
    assert.equal((events[0] as any).status, "failed");
  } finally {
    await research.shutdown();
    await model.stop();
    if (oldEc === undefined) delete process.env.MAE_FLOW_EC_BIN;
    else process.env.MAE_FLOW_EC_BIN = oldEc;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("源码缓存增量同步、同仓准备串行，旧研究仍能读取固定版本", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const dir = temporary(),
    repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "file.cpp"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "v1");
  const service = new TaskService({
    dataDir: join(dir, "data"),
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
    gitCredential: account => account === "bob" ? {username:"bob",password:"fixture-personal"} : undefined,
    platformGitCredential: () => ({username:"oauth2",password:"fixture-system"}),
  });
  const identities: any[] = [];
  const originalSandbox = (service as any).prepareHostGitSandbox.bind(service);
  (service as any).prepareHostGitSandbox = (identity: any) => { identities.push(identity); return originalSandbox(identity); };
  try {
    const component = {
      ...config,
      id: "fixture",
      repository: repo,
      enabled: true,
      description: "",
      path: "",
    };
    const prepare = () =>
      (service as any).componentResearchSource(component, "alice");
    const [a, b] = await Promise.all([prepare(), prepare()]);
    assert.equal(a.root, b.root);
    assert.equal(a.revision, b.revision);
    writeFileSync(join(repo, "file.cpp"), "v2\n");
    git("add", ".");
    git("commit", "-qm", "v2");
    const c = await prepare();
    assert.equal(c.root, a.root);
    assert.notEqual(c.revision, a.revision);
    assert.equal(
      execFileSync("git", ["-C", a.root, "show", `${a.revision}:file.cpp`], {
        encoding: "utf8",
      }),
      "v1\n",
    );
    const bob = await (service as any).componentResearchSource(
      component,
      "bob",
    );
    assert.notEqual(bob.root, a.root);
    assert.equal(identities[0].username, "oauth2", "无个人凭据时只读同步使用系统账号");
    assert.equal(identities.at(-1).username, "bob", "个人凭据优先");
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP 配置、萃取、查看及采纳走同一记录，非法语言拒绝", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const { createTaskServer } = await import("../src/server.ts");
  const dir = temporary();
  const service = new TaskService({
    dataDir: dir,
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
  });
  const research = new ComponentResearch(
    dir,
    async input => input.review ? "已答复所选组件的问题" : input.record.document ? writeJoint(input) : "# 测试草稿\n来源：测试夹具，非真实内部范式",
  );
  (service as any).componentResearch = research;
  const server = createTaskServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: object) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const configResponse = await post("/component-repositories", config);
    assert.equal(configResponse.status, 200);
    const component: any = await configResponse.json();
    assert.equal(
      (
        await post("/component-research", {
          component_id: component.id,
          language: "python",
          topic: "UT",
        })
      ).status,
      400,
    );
    const launched = await post("/component-research", {
      component_id: component.id,
      language: "cpp",
      topic: "UT",
    });
    assert.equal(launched.status, 202);
    const record: any = await launched.json();
    await until(() => research.get(record.id).status === "done");
    const detail: any = await (
      await fetch(`${url}/component-research/${record.id}`)
    ).json();
    assert.match(detail.draft, /测试草稿/);
    const adopted = await post(`/component-research/${record.id}/adopt`, {
      title: "范式",
      scope: "platform",
    });
    assert.equal(adopted.status, 200);
    const doc: any = await adopted.json();
    assert.deepEqual(doc.technologies, ["cpp"]);
    const docs: any = await (await fetch(`${url}/knowledge-documents`)).json();
    assert.equal(docs.documents[0].id, doc.id);
    const all = await post("/component-research", {mode:"all",language:"cpp"});
    assert.equal(all.status, 202);
    const batch: any = await all.json();
    assert.equal(batch.format, "joint-document");
    assert.equal(batch.children, undefined);
    await until(() => research.get(batch.id).status === "done");
    const progress: any = await (await fetch(`${url}/component-research/${batch.id}`)).json();
    assert.equal(progress.document.sections.length, 2);
    const selected = await post(`/component-research/${batch.id}/selection`, { ids: ["cap-0"], selected: false });
    assert.equal(selected.status, 200);
    const download = await fetch(`${url}/component-research/${batch.id}/document`);
    assert.match(download.headers.get("content-type")!, /text\/markdown/);
    assert.doesNotMatch(await download.text(), /## 能力 cap-0/);
    assert.equal((await post(`/component-research/${batch.id}/review`, {section_id:"unknown",mode:"discuss",message:"问题"})).status, 400);
    assert.equal((await post(`/component-research/${batch.id}/review`, {section_id:"cap-0",mode:"discuss",message:"头文件对应哪个库？"})).status, 202);
    await until(() => research.get(batch.id).status === "done");
    assert.match(research.get(batch.id).review_turns![0].reply!, /所选组件/);
    assert.equal(research.get(batch.id).document!.sections[0].selected, false);
    assert.equal((await post("/component-research", {mode:"unknown",language:"cpp"})).status, 400);
  } finally {
    await service.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按语言快照全部启用组件仓，忽略旧单仓输入；配置变化重新研究", async () => {
  const dir = temporary();
  const first = saveComponentRepository(dir, config, "alice");
  const second = saveComponentRepository(dir, {...config, name:"日期组件", repository:"https://code.example/date.git", languages:["cpp"]}, "alice");
  saveComponentRepository(dir, {...config, name:"Java组件", repository:"https://code.example/java.git", languages:["java"]}, "alice");
  saveComponentRepository(dir, {...config, name:"停用组件", repository:"https://code.example/off.git", enabled:false}, "alice");
  const executions: any[] = [];
  const research = new ComponentResearch(dir, async input => { executions.push(input.record); return "# 范式"; });
  try {
    const job = research.start({language:"cpp", topic:"日期", component_id:first.id}, "alice");
    assert.deepEqual(job.components?.map(c => c.id).sort(), [first.id, second.id].sort());
    assert.equal(research.start({language:"cpp", topic:"日期"}, "alice").id, job.id);
    await until(() => research.get(job.id).status === "done");
    assert.equal(executions[0].components.length, 2);
    saveComponentRepository(dir, {id:second.id, enabled:false}, "alice");
    const next = research.start({language:"cpp", topic:"日期"}, "alice");
    assert.notEqual(next.id, job.id);
    assert.equal(next.components?.length, 1);
    assert.equal(research.get(job.id).components?.length, 2, "历史范围不被当前配置覆盖");
    assert.throws(() => research.start({language:"python",topic:"日期"}, "alice"), /语言/);
  } finally { await research.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test("跨组件读取按 ID 路由、固定版本且延迟准备，证据保留仓库", async () => {
  const dir = temporary();
  try {
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir,"sample.cpp"), "void close_file() {}\n");
    execFileSync("git", ["-C",dir,"add","."]);
    execFileSync("git", ["-C",dir,"-c","user.name=Test","-c","user.email=test@example.com","commit","-qm","fixture"]);
    const revision = execFileSync("git", ["-C",dir,"rev-parse","HEAD"], {encoding:"utf8"}).trim();
    const components = ["one","two"].map(id => ({...config,id,path:"",enabled:true,description:"",repository:`https://code.example/${id}.git`}));
    const prepared: string[] = [], evidence: any[] = [];
    const tool = languageComponentSourceTool(components, async c => { prepared.push(c.id); return {root:dir,revision}; }, e => evidence.push(e));
    await call(tool, {action:"read",path:"sample.cpp"});
    assert.equal(prepared.length, 0, "多仓不能默认读第一项");
    for (const id of ["two","one","two"]) {
      const result = await call(tool, {action:"read",component_id:id,path:"sample.cpp"});
      assert.match(JSON.stringify(result), /close_file/);
    }
    assert.deepEqual(prepared, ["two","one"]);
    assert.deepEqual(evidence.map(e => e.component_id), ["two","one","two"]);
    assert.equal(evidence[0].repository, components[1].repository);
    assert.equal(evidence[0].revision, revision);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("组件源码目录分段列出并明确续读位置，扫描不会静默丢弃后续条目", async t => {
  const dir = temporary();
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  execFileSync("git", ["init", "-q", dir]);
  for (let i=0;i<105;i++) writeFileSync(join(dir,`api-${String(i).padStart(3,"0")}.h`), "void call();\n");
  execFileSync("git", ["-C",dir,"add","."]);
  execFileSync("git", ["-C",dir,"-c","user.name=Test","-c","user.email=test@example.com","commit","-qm","fixture"]);
  const tool = componentSourceTool(dir,"HEAD","",()=>{});
  const first = await call(tool,{action:"list"});
  assert.match(first.content[0].text,/目录共 105 项/);
  assert.match(first.content[0].text,/list start=101/);
  assert.doesNotMatch(first.content[0].text,/api-104/);
  const next = await call(tool,{action:"list",start:101});
  assert.match(next.content[0].text,/api-104/);
  assert.doesNotMatch(next.content[0].text,/后续请/);
});

test("停止和删除不会被迟到结果复活；删除保留已采纳知识，失败可以重试", async () => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  let release!: () => void;
  const hold = new Promise<void>(r => release = r);
  const research = new ComponentResearch(dir, async input => {
    if (input.record.topic === "慢任务") { await hold; input.update({stage:"迟到更新"}); }
    if (input.record.topic === "失败") throw new Error("测试失败");
    return "# 组件范式\n测试内容";
  });
  try {
    const slow = research.start({language:"cpp",topic:"慢任务"}, "alice");
    await until(() => research.get(slow.id).status === "running");
    research.stop(slow.id);
    release();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(research.get(slow.id).status, "cancelled");
    assert.equal(research.get(slow.id).stage, "已停止");
    research.remove(slow.id, "bob");
    assert.ok(!research.list().some(r => r.id === slow.id));
    assert.equal(research.get(slow.id).deleted_by, "bob");
    const fail = research.start({language:"cpp",topic:"失败"}, "alice");
    await until(() => research.get(fail.id).status === "failed");
    assert.notEqual(research.retry(fail.id, "alice").id, fail.id);
    const done = research.start({language:"cpp",topic:"完成"}, "alice");
    await until(() => research.get(done.id).status === "done");
    const doc = research.adopt(done.id, {scope:"platform"}, "alice");
    research.remove(done.id, "bob");
    assert.ok(research.get(done.id).draft, "来源追溯保留");
    const {readKnowledgeDocument} = await import("../src/knowledgeDocuments.ts");
    assert.equal(readKnowledgeDocument(dir, doc.id).id, doc.id);
    assert.throws(() => research.retry(done.id,"alice"), /删除/);
  } finally { release(); await research.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test("全量跨仓只执行一次，细粒度能力默认全选，筛选后采纳为单篇文档", async t => {
  const dir = temporary();
  const one = saveComponentRepository(dir, config, "alice");
  const two = saveComponentRepository(dir, {...config, name:"日期组件", repository:"https://code.example/date.git"}, "alice");
  saveComponentRepository(dir, {...config, name:"Java", languages:["java"]}, "alice");
  saveComponentRepository(dir, {...config, name:"已停用", enabled:false}, "alice");
  const executions: string[] = [];
  const research = new ComponentResearch(dir, async input => {
    executions.push(input.record.id);
    assert.equal(input.record.mode, "all");
    assert.deepEqual(input.record.components?.map(c => c.id).sort(), [one.id, two.id].sort());
    writeJoint(input, 32);
    input.editDocument!({ action: "section", section: { ...sectionData("cap-0", [one.id, two.id]), related_ids: ["cap-1"] } });
    return "完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  const batch = research.start({mode:"all",language:"C++"}, "alice");
  assert.equal(batch.children, undefined);
  assert.equal(research.start({mode:"all",language:"cpp"}, "alice").id, batch.id);
  await until(() => research.get(batch.id).status === "done");
  const complete = research.get(batch.id);
  assert.equal(executions.length, 1);
  assert.equal(complete.document!.sections.length, 32);
  assert.ok(complete.document!.sections.every(section => section.selected));
  assert.equal((complete.draft!.match(/### 最佳示例/g) ?? []).length, 32);
  assert.equal(research.list(true).length, 1);
  assert.equal(research.list(true)[0].document, undefined);
  assert.throws(() => research.selectSections(batch.id, ["unknown"], false), /有效/);
  research.selectSections(batch.id, complete.document!.sections.map(s => s.id), false);
  assert.throws(() => research.adopt(batch.id, {scope:"platform"}, "alice"), /请选择至少一个/);
  research.selectSections(batch.id, ["cap-0"], true);
  const doc = research.adopt(batch.id, {scope:"platform",content:"不可覆盖结构化草稿"}, "alice");
  assert.match(doc.content, /## 能力 cap-0/);
  assert.doesNotMatch(doc.content, /## 能力 cap-1\b|不可覆盖结构化草稿/);
  assert.match(doc.content, /未纳入本次文档/);
  assert.equal(doc.research_source?.components?.length, 2);
  assert.equal(research.adopt(batch.id, {}, "alice").id, doc.id);
  assert.throws(() => research.review(batch.id, { section_id:"cap-0",mode:"rework",message:"修改" }, "alice"), /不可/);
  research.remove(batch.id, "alice");
  assert.equal(research.list().length, 0);
  assert.equal(research.get(batch.id).document_id, doc.id);
  assert.throws(() => research.retry(batch.id, "alice"), /删除/);
});

test("53 个仓在同一研究上下文，停止后迟到章节和结果不能覆盖草稿", async t => {
  const dir = temporary();
  for (let i=0; i<53; i++) saveComponentRepository(dir, {...config, name:`组件 ${i}`, repository:`https://code.example/c${i}.git`}, "alice");
  let count = 0;
  const research = new ComponentResearch(dir, async input => {
    count++;
    assert.equal(input.record.components?.length, 53);
    writeJoint(input);
    await new Promise<void>(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener("abort", () => resolve(), {once:true}));
    assert.throws(() => input.editDocument!({action:"overview",overview:"迟到内容"}), /停止/);
    return "# 迟到草稿";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  const batch = research.start({mode:"all",language:"cpp"}, "alice");
  await until(() => count === 1);
  assert.equal(research.start({mode:"all",language:"cpp",refresh:true}, "alice").id, batch.id);
  research.stop(batch.id);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(count, 1);
  assert.equal(research.get(batch.id).document?.sections.length, 2);
  assert.doesNotMatch(research.get(batch.id).draft!, /迟到/);
  assert.equal(research.get(batch.id).status, "cancelled");
  research.remove(batch.id, "alice");
  assert.equal(research.list().length, 0);
});

test("重启中断保留章节、勾选与对话，继续研究沿用原始跨仓范围", async t => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  saveComponentRepository(dir, {...config,name:"日期",repository:"https://code.example/date.git"}, "alice");
  const initial = new ComponentResearch(dir, async input => writeJoint(input));
  const batch = initial.start({mode:"all",language:"cpp"}, "alice");
  await until(() => initial.get(batch.id).status === "done");
  initial.selectSections(batch.id, ["cap-1"], false);
  await initial.shutdown();
  const original = initial.get(batch.id).document;
  const file = join(dir,"component-research",batch.id,"record.json");
  const state = JSON.parse(readFileSync(file,"utf8"));
  writeFileSync(file,JSON.stringify({...state,status:"running",review_turns:[{id:"turn",section_id:"cap-0",mode:"discuss",message:"补充说明",operator:"alice",status:"running",created_at:new Date().toISOString()}]}));
  let runs = 0;
  const recovered = new ComponentResearch(dir, async ({record,review}) => {
    runs++; assert.equal(record.components?.length, 2);
    assert.equal(review?.section_id,"cap-0");assert.equal(review?.mode,"discuss");
    return "# 重试完成";
  });
  t.after(async () => { await recovered.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  assert.equal(recovered.get(batch.id).status, "failed");
  assert.equal(recovered.get(batch.id).review_turns?.[0].status, "failed");
  assert.deepEqual(recovered.get(batch.id).document, original);
  for (const repo of componentRepositories(dir)) saveComponentRepository(dir,{id:repo.id,enabled:false},"alice");
  const retry = recovered.retry(batch.id,"alice");
  assert.equal(retry.id,batch.id);
  await until(() => recovered.get(batch.id).status === "done");
  assert.equal(runs,1);
  assert.deepEqual(recovered.get(batch.id).document, original);
});

test("对话只读；局部返工只替换指定章节，失败与停止均保留原稿", async t => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    const target = input.readDocument!().sections[0];
    assert.equal(input.review.section_id, target.id);
    assert.throws(() => input.editDocument!({action:"overview",overview:"不能改总览"}), /只能修改/);
    assert.throws(() => input.editDocument!({action:"section",section:sectionData("cap-1",target.repository_ids)}), /只能修改/);
    if (input.review.mode === "discuss") {
      assert.throws(() => input.editDocument!({action:"section",section:target}), /讨论不会修改/);
      return "此接口的资源由调用方释放，可补充失败路径示例。";
    }
    input.editDocument!({action:"section",section:{...target,content:"新增取消与异常路径",example:"```cpp\nClose(handle); // error cleanup\n```"}});
    if (input.review.message === "失败") throw new Error("读取异常");
    if (input.review.message === "停止") await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), {once:true}));
    return "已核对接口，仅修订所选组件的错误处理示例。";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir,{recursive:true,force:true}); });
  const job = research.start({mode:"all",language:"cpp"},"alice");
  await until(() => research.get(job.id).status === "done");
  const original = research.get(job.id).document!;
  research.review(job.id,{section_id:"cap-0",mode:"discuss",message:"为什么需要清理？"},"expert");
  assert.throws(() => research.review(job.id,{section_id:"cap-1",mode:"rework",message:"同时改"},"expert"), /本轮/);
  await until(() => research.get(job.id).status === "done");
  assert.deepEqual(research.get(job.id).document, original);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"按建议修改"},"expert");
  await until(() => research.get(job.id).status === "done");
  const revised = research.get(job.id).document!;
  assert.equal(revised.sections[0].revision, 2);
  assert.deepEqual(revised.sections[1], original.sections[1]);
  assert.equal(revised.overview, original.overview);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"失败"},"expert");
  await until(() => research.get(job.id).status === "failed");
  assert.deepEqual(research.get(job.id).document, revised);
  research.retry(job.id,"expert");
  await until(() => research.get(job.id).status === "failed");
  assert.equal(research.get(job.id).review_turns!.at(-1)!.section_id,"cap-0");
  assert.equal(research.get(job.id).review_turns!.at(-1)!.message,"失败");
  assert.deepEqual(research.get(job.id).document,revised);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"停止"},"expert");
  await until(() => research.get(job.id).status === "running");
  await new Promise(resolve => setTimeout(resolve, 20));
  research.stop(job.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(research.get(job.id).document, revised);
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.status), ["done","done","failed","failed","cancelled"]);
});

test("缺最佳示例不能完成，已保存能力允许继续补齐而不重做", async t => {
  const dir = temporary();
  const repo = saveComponentRepository(dir, config, "alice");
  let runs = 0;
  const research = new ComponentResearch(dir, async input => {
    if (++runs === 1) {
      writeJoint(input, 1);
      input.editDocument!({action:"outline",entries:[{id:"missing",title:"缺示例",repository_ids:[repo.id]}]});
      assert.throws(() => input.editDocument!({action:"section",section:{...sectionData("missing",[repo.id]),example:"只有文字"}}), /最佳示例/);
    } else input.editDocument!({action:"section",section:sectionData("missing",[repo.id])});
    return "已保存";
  });
  t.after(async () => {await research.shutdown();rmSync(dir,{recursive:true,force:true});});
  const job = research.start({mode:"all",language:"cpp"},"alice");
  await until(() => research.get(job.id).status === "failed");
  const preserved = research.get(job.id).document!.sections[0];
  assert.throws(() => research.adopt(job.id,{scope:"platform"},"alice"), /生成后/);
  research.retry(job.id,"alice");
  await until(() => research.get(job.id).status === "done");
  assert.deepEqual(research.get(job.id).document!.sections[0],preserved);
});

test("结构化章节拒绝未知来源、空示例和悬空关联；Markdown 保留真实依赖", () => {
  const doc = editResearchDocument({overview:"联合关系",sections:[]},{action:"outline",entries:[{id:"a",title:"A",repository_ids:["r"]},{id:"b",title:"B",repository_ids:["r"]}]},["r"]);
  const section = sectionData("a",["r"]);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,repository_ids:["other"]}},["r"]), /范围/);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,example:"```cpp\n\n```"}},["r"]), /最佳示例/);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,related_ids:["unknown"]}},["r"]), /关联组件/);
  const filled = editResearchDocument(doc,{action:"section",section:{...section,related_ids:["b"]}},["r"]);
  const md = researchDocumentMarkdown("指南",filled);
  assert.match(md, /公共接口/); assert.match(md, /libfile.so/); assert.match(md, /#component-b/);
});

test("超过普通上传容量的联合长文可完整采纳，后续调整范围不丢正文", async t => {
  const dir = temporary();saveComponentRepository(dir,config,"alice");
  const longContent = "完整使用细节。".repeat(150_000);
  const research = new ComponentResearch(dir,async input => {
    writeJoint(input,1);
    input.editDocument!({action:"section",section:{...sectionData("cap-0",input.record.components!.map(c => c.id)),content:longContent}});
    return "完成";
  });
  t.after(async () => {await research.shutdown();rmSync(dir,{recursive:true,force:true});});
  const job = research.start({mode:"all",language:"cpp"},"alice");
  await until(() => research.get(job.id).status === "done");
  const doc = research.adopt(job.id,{scope:"platform"},"alice");
  assert.ok(Buffer.byteLength(doc.content) > 2 * 1024 * 1024);
  assert.ok(doc.content.includes(longContent));
  const { saveKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  assert.equal(saveKnowledgeDocument(dir,{active:false},"alice",doc.id).content,doc.content);
  assert.throws(() => saveKnowledgeDocument(dir,{title:"普通上传",content:longContent},"alice"),/最大 2 MiB/);
});
