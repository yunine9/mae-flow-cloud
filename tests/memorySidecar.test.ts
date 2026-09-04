/**
 * 任务记忆检索旁路(docs/knowledge-memory-design.md §7/§8)第二期契约。
 *
 * 假件(tests/fixtures/memsearch-sidecar-stub.mjs,同协议、不装模型)承载
 * 全部语义:配对、预算超时返回空、进程死了按需重拉、起不来就 unavailable;
 * 工具 repo 由宿主固定;三个推送时刻的内容与足迹。真件(memsearch venv)
 * 没有就**显式 skip 并明说**,有就跑 health/ingest/search/expand 一遍。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { createMemoryTools, renderMemoryHits } from "../src/memoryTools.ts";
import { TaskService } from "../src/taskService.ts";

const STUB = resolve(process.cwd(), "tests/fixtures/memsearch-sidecar-stub.mjs");
const REAL_PYTHON = process.env.MFC_MEMSEARCH_PYTHON
  ?? resolve(process.cwd(), "..", "..", "..", ".local", "memsearch-venv", "bin", "python");
const REAL_SCRIPT = resolve(process.cwd(), "harness", "memsearch-sidecar.py");

function corpusWith(records: number): { dataDir: string; store: MemoryStore; ids: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-sidecar-"));
  const store = new MemoryStore(dataDir);
  const ids: string[] = [];
  for (let index = 0; index < records; index += 1) {
    ids.push(store.record({
      source: index % 2 ? "prepush_fix" : "annotation",
      judged_by: index % 2 ? "pipeline" : "human", scope: "local",
      repo: "notify-service", paths: [index % 2 ? "pom.xml" : "src/filter/FilterEngine.java"],
      line: index % 2 ? undefined : 88, phase: "写代码", task: `task-old-${index}`,
      evidence: `e${index}`, trigger: index % 2 ? "加新渠道时" : "改过滤顺序时",
      conclusion: index % 2 ? "枚举新增渠道要同步改 registry.xml"
        : "黑名单判断必须在渠道开关之前",
    }).id);
  }
  return { dataDir, store, ids };
}

function stub(dataDir: string, env: Record<string, string> = {}, budgets = {}) {
  return new MemorySidecar({
    python: process.execPath, script: STUB,
    corpusDir: join(dataDir, "corpus"), milvusPath: join(dataDir, "memsearch", "milvus.db"),
    env, budgets, log: () => {},
  });
}

test("假 sidecar:ready 配对、search/expand 语义、repo 由宿主固定", async () => {
  const { dataDir, ids } = corpusWith(2);
  const sidecar = stub(dataDir);
  try {
    assert.equal(await sidecar.start(), true);
    assert.equal(await sidecar.health(), true);
    const hits = await sidecar.search({ query: "黑名单", repo: "notify-service" });
    assert.deepEqual(hits?.map((hit) => hit.id), [ids[0]]);
    assert.deepEqual(await sidecar.search({ query: "黑名单", repo: "other" }), [],
      "repo 是过滤键,别的仓的一条都不给");
    const scoped = await sidecar.search({ query: "渠道", repo: "notify-service", pathPrefix: "pom" });
    assert.deepEqual(scoped?.map((hit) => hit.id), [ids[1]]);
    const content = await sidecar.expand(ids[0]);
    assert.match(content ?? "", /^---\nid: /);
    assert.equal(await sidecar.expand("c-nope-000000"), undefined);
  } finally {
    sidecar.stop();
  }
});

test("预算:search 超预算返回 undefined 而不是挂着;进程死了按需重拉", async () => {
  const { dataDir } = corpusWith(1);
  const slow = stub(dataDir, { STUB_SLOW_SEARCH: "1" }, { searchMs: 200 });
  try {
    const started = Date.now();
    assert.equal(await slow.search({ query: "x", repo: "notify-service" }), undefined);
    assert.ok(Date.now() - started < 1500, "超时必须按预算返回,不能等 3 秒");
  } finally {
    slow.stop();
  }
  const dying = stub(dataDir, { STUB_DIE_AFTER: "1" });
  try {
    assert.equal(await dying.health(), true);
    await new Promise((tick) => setTimeout(tick, 150));
    assert.equal(dying.available, false, "应答一条就自杀的假件此时应已不在");
    assert.equal(await dying.health(), true, "下一次调用自动重拉");
  } finally {
    dying.stop();
  }
  const broken = stub(dataDir, { STUB_BOOT_FAIL: "1" }, { bootMs: 2000 });
  try {
    assert.equal(await broken.start(), false);
    assert.equal(await broken.search({ query: "x", repo: "r" }), undefined);
  } finally {
    broken.stop();
  }
});

test("工具:corpus_search 结果封顶带 id/判定者/位置;expand 形状校验;足迹回调", async () => {
  const { dataDir, ids } = corpusWith(2);
  const sidecar = stub(dataDir);
  const used: Array<{ moment: string; ids: string[] }> = [];
  try {
    const [search, expand] = createMemoryTools({
      repo: "notify-service",
      search: (input) => sidecar.search({ ...input, repo: "notify-service" }),
      expand: (id) => sidecar.expand(id),
      onUse: (event) => used.push({ moment: event.moment, ids: event.ids }),
    }) as any[];
    assert.equal(search.name, "corpus_search");
    assert.ok(search.promptGuidelines[0].includes("之前"), "触发写成动作锚定");
    const result = await search.execute("call-1", { query: "黑名单" });
    assert.match(result.content[0].text, new RegExp(`\\(${ids[0]}\\) \\[人确认 · \\d{4}-\\d{2}-\\d{2} · src/filter/FilterEngine.java:88\\]`));
    const bad = await expand.execute("call-2", { memory_id: "../etc/passwd" });
    assert.match(bad.content[0].text, /形状不对/);
    const full = await expand.execute("call-3", { memory_id: ids[0] });
    assert.match(full.content[0].text, /## 结论/);
    assert.deepEqual(used.map((row) => row.moment), ["search", "expand"]);
  } finally {
    sidecar.stop();
  }
  assert.equal(renderMemoryHits([]), "没有命中的记忆。");
});

test("三个推送时刻:开局并进使命、进入新阶段插话、首次改目录插话;足迹落账", async () => {
  const { dataDir, ids } = corpusWith(2);
  const svc = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    memory: { python: process.execPath, script: STUB,
      milvusPath: join(dataDir, "memsearch", "milvus.db") },
  });
  try {
    const id = svc.create("改一下过滤顺序").id;
    const internal = (svc as any).tasks.get(id);
    internal.summary.repo_url = "git@example.com:demo/notify-service.git";
    // 开局:语义命中的排前面(假件按子串命中"过滤顺序"那条)
    const briefing = String(await (svc as any).memoryBriefing(internal));
    assert.match(briefing, /^本仓的任务记忆/);
    assert.deepEqual(internal.memoryBriefingIds, [ids[0], ids[1]]);

    // 会话假件:只记 steer
    const steered: Array<{ text: string; extra: any }> = [];
    internal.driver = {
      steer: async (text: string, extra: any) => { steered.push({ text, extra }); },
      abort: async () => {}, dispose: () => {}, pendingSteers: () => [],
    };
    internal.summary.status = "running";
    // 失锚过滤靠现场里文件在不在:把记忆指向的两个文件真造出来。
    internal.cwd = mkdtempSync(join(tmpdir(), "mfc-sidecar-cwd-"));
    mkdirSync(join(internal.cwd, "src", "filter"), { recursive: true });
    writeFileSync(join(internal.cwd, "src", "filter", "FilterEngine.java"), "class A {}\n");
    writeFileSync(join(internal.cwd, "pom.xml"), "<project/>\n");

    // 阶段:第一次看到不推(开局覆盖),换阶段才推,同阶段不重复
    (svc as any).maybePushPhaseMemories(internal, "定规格");
    (svc as any).maybePushPhaseMemories(internal, "写代码");
    (svc as any).maybePushPhaseMemories(internal, "写代码");
    await new Promise((tick) => setTimeout(tick, 300));
    assert.equal(steered.length, 1, "换到写代码只推一次");
    assert.match(steered[0].text, /【任务记忆】进入「写代码」/);
    assert.equal(steered[0].extra.via, "memory_push", "推送不算人的插话");

    // 首改目录:同目录只提醒一次;没有记忆的目录不提醒
    (svc as any).onMemoryFileIntent(internal, "src/filter/FilterEngine.java");
    (svc as any).onMemoryFileIntent(internal, "src/filter/Other.java");
    (svc as any).onMemoryFileIntent(internal, "docs/nothing.md");
    await new Promise((tick) => setTimeout(tick, 50));
    assert.equal(steered.length, 2);
    assert.match(steered[1].text, /你正要改 src\/filter 目录,这里有 1 条历史记忆/);
    assert.match(steered[1].text, new RegExp(ids[0]));

    const usage = svc.listTaskMemoryUsage(id);
    assert.deepEqual(usage.map((row) => row.moment), ["launch", "phase", "edit"]);
    assert.ok(existsSync(join(internal.summary.workspace, "memory-usage.jsonl")));
    // 失锚:路径在现场不存在的不推
    const none = (svc as any).memoryCandidates({ ...internal,
      cwd: mkdtempSync(join(tmpdir(), "mfc-sidecar-empty-")),
      summary: { ...internal.summary, id: "other" } });
    assert.equal(none.length, 0, "现场里没有这些文件,失锚的不推");
    internal.driver = undefined;
  } finally {
    await svc.shutdown();
  }
});

test("真 memsearch sidecar:health/ingest/search/expand 一遍(venv 缺席则显式 skip)", async (t) => {
  if (!existsSync(REAL_PYTHON)) {
    t.skip(`找不到 memsearch venv 的 python(${REAL_PYTHON});设 MFC_MEMSEARCH_PYTHON 后重跑`);
    return;
  }
  const { dataDir, store, ids } = corpusWith(2);
  const sidecar = new MemorySidecar({
    python: REAL_PYTHON, script: REAL_SCRIPT,
    corpusDir: store.root, milvusPath: join(dataDir, "memsearch", "milvus.db"),
    budgets: { searchMs: 5_000, ingestMs: 20_000 },
    env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    log: () => {},
  });
  try {
    assert.equal(await sidecar.start(), true, "真 sidecar 起不来");
    assert.equal(await sidecar.health(), true);
    for (const id of ids) {
      const row = store.find(id)!;
      assert.equal(await sidecar.ingest(join(store.root, row.file)), true);
    }
    const hits = await sidecar.search({ query: "被关掉的渠道为什么还跑黑名单", repo: "notify-service" });
    assert.equal(hits?.[0]?.id, ids[0], "换说法也要首位命中");
    assert.match((await sidecar.expand(ids[0])) ?? "", /黑名单判断必须在渠道开关之前/);
    assert.equal(readFileSync(join(store.root, store.find(ids[0])!.file), "utf-8").includes("## 结论"), true);
  } finally {
    sidecar.stop();
  }
});
