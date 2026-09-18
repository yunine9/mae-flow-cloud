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
import { ComponentResearch } from "../src/componentResearch.ts";
import {
  componentRepositories,
  saveComponentRepository,
} from "../src/componentRepositories.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import {
  componentSourceTool,
  codeSearchTool,
} from "../src/componentResearchTools.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
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
    {
      text: `# 文件关闭\n语言：C++\n## 规则\n调用 Close(handle)。\n## 证据\nsrc/file.cpp:1 @ ${revision}；consumer/src/use.cpp:12，版本未知。\n## 局限\n单一样例，尚未验证为稳定范式。`,
    },
  ]);
  await model.start();
  const row = saveComponentRepository(dir, config, "alice");
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
    const job = research.start(
      { component_id: row.id, language: "cpp", topic: "句柄关闭" },
      "alice",
    );
    await until(() => ["done", "failed"].includes(research.get(job.id).status));
    const done = research.get(job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.revision, revision);
    assert.equal(
      done.evidence.length,
      3,
      JSON.stringify(model.requests.at(-1)),
    );
    assert.match(done.draft!, /版本未知/);
    const toolNames = (model.requests[0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    assert.ok(toolNames.includes("component_source"));
    assert.ok(toolNames.includes("code_search"));
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
  });
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
    async () => "# 测试草稿\n来源：测试夹具，非真实内部范式",
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
  } finally {
    await service.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
