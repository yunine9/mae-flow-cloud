/**
 * 任务记忆第三期契约(docs/knowledge-memory-design.md §5/§6/§8-3/§9):
 * 起草收尾、台账与效果账、目录摘要层、沉底归档、时间线事件、效能页总览。
 *
 * 模型全部用假件(注入 memoryDrafter);sidecar 用假件;真 memsearch 在场时
 * 多跑一遍"起草后改标题能被搜到、归档重建后搜不到",缺席显式 skip。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EMPTY_STATS, MemoryStore, memoryWeight, type MemoryInput,
} from "../src/taskMemory.ts";
import {
  buildMemoryDraftPrompt, parseDirectoryDigest, parseMemoryDraft,
  renderDirectoryDigestFallback,
} from "../src/memoryDraft.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { TaskService } from "../src/taskService.ts";
import { buildTimeline } from "../src/timeline.ts";

const STUB = resolve(process.cwd(), "tests/fixtures/memsearch-sidecar-stub.mjs");
const REAL_PYTHON = process.env.MFC_MEMSEARCH_PYTHON
  ?? resolve(process.cwd(), "..", "..", "..", ".local", "memsearch-venv", "bin", "python");
const REAL_SCRIPT = resolve(process.cwd(), "harness", "memsearch-sidecar.py");
const DAY = 86_400_000;

const base = {
  source: "annotation", judged_by: "human", scope: "local", repo: "notify-service",
  paths: ["src/filter/FilterEngine.java"], line: 88, phase: "写代码", task: "task-old",
  evidence: "annotation:a-1", trigger: "改 src/filter/FilterEngine.java 第 88 行附近时",
  quote: "if (enabled) check();", problem: "黑名单判断放在开关后面了",
  conclusion: "黑名单判断必须在渠道开关之前",
} satisfies MemoryInput;

function fakeService(options: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-"));
  const logs: string[] = [];
  const svc = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    log: (line: string) => logs.push(line), ...options,
  });
  return { dataDir, svc, logs };
}

function liveTask(svc: TaskService, requirement = "改一下过滤顺序") {
  const id = svc.create(requirement).id;
  const internal = (svc as any).tasks.get(id);
  internal.summary.repo_url = "git@example.com:demo/notify-service.git";
  internal.summary.status = "running";
  const steered: Array<{ text: string; extra: any }> = [];
  internal.driver = {
    steer: async (text: string, extra: any) => { steered.push({ text, extra }); },
    abort: async () => {}, dispose: () => {}, pendingSteers: () => [],
  };
  internal.cwd = mkdtempSync(join(tmpdir(), "mfc-memory3-cwd-"));
  mkdirSync(join(internal.cwd, "src", "filter"), { recursive: true });
  writeFileSync(join(internal.cwd, "src", "filter", "FilterEngine.java"), "class A {}\n");
  return { id, internal, steered };
}

test("起草收尾:同一条记录补 trigger/scope,索引追加一版、读侧取最后一版;只收尾一次", () => {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory3-")));
  const first = store.record(base);
  const next = store.finalizeDraft(first.id, {
    trigger: "改过滤器的判断顺序时", scope: "general", state: "model" });
  assert.equal(next.revision, 2);
  assert.equal(next.draft, "model");
  const md = readFileSync(join(store.root, first.file), "utf-8");
  assert.match(md, /\n---\n# 改过滤器的判断顺序时\n/);
  assert.match(md, /\nscope: general\n/);
  assert.match(md, /\ndraft: model\n/);
  assert.match(md, /黑名单判断必须在渠道开关之前/, "人写的正文一个字不动");
  const rows = store.list();
  assert.equal(rows.length, 1, "同 id 两版只算一条");
  assert.equal(rows[0].trigger, "改过滤器的判断顺序时");
  assert.equal(readFileSync(join(store.root, "index.jsonl"), "utf-8").trim().split("\n").length, 2,
    "索引只追加不改写");
  assert.throws(() => store.finalizeDraft(first.id, { state: "model", trigger: "x" }), /已经起草收尾过/);
  // 起草失败:标 failed,模板保留
  const second = store.record({ ...base, evidence: "annotation:a-2" });
  const failed = store.finalizeDraft(second.id, { state: "failed" });
  assert.equal(failed.trigger, base.trigger);
  assert.equal(failed.draft, "failed");
});

test("起草解析:只认形状对的 JSON;摘要必须引用真实 id、不超 12 行", () => {
  assert.deepEqual(parseMemoryDraft('{"trigger":"改过滤顺序时","scope":"local"}'),
    { trigger: "改过滤顺序时", scope: "local" });
  assert.deepEqual(parseMemoryDraft('好的,这是结果:\n```json\n{"trigger": "加新渠道时", "scope": "general"}\n```'),
    { trigger: "加新渠道时", scope: "general" });
  assert.equal(parseMemoryDraft('{"trigger":"x","scope":"forever"}'), undefined, "scope 不在词表");
  assert.equal(parseMemoryDraft('{"trigger":"","scope":"local"}'), undefined);
  assert.equal(parseMemoryDraft("我觉得这条应该是 local"), undefined);
  assert.equal(parseMemoryDraft(`{"trigger":"${"长".repeat(81)}","scope":"local"}`), undefined);
  const prompt = buildMemoryDraftPrompt({ ...base, id: "c-1-a", at: "2026-09-03T00:00:00Z", file: "x" });
  assert.match(prompt.user, /黑名单判断放在开关后面了/);
  assert.match(prompt.system, /one_off/);

  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory3-")));
  const rows = [store.record(base), store.record({ ...base, evidence: "e2" })];
  assert.equal(parseDirectoryDigest("- 有人要求过黑名单在开关前", rows), undefined, "没引用 id");
  assert.match(parseDirectoryDigest(`- 有人要求过黑名单在开关前(${rows[0].id})`, rows) ?? "", /开关前/);
  assert.equal(parseDirectoryDigest(Array(13).fill(`- x (${rows[0].id})`).join("\n"), rows), undefined);
  const fallback = renderDirectoryDigestFallback("src/filter", [...rows, ...rows, ...rows]);
  assert.match(fallback, /另有 1 条,用 corpus_search 带 path_prefix=src\/filter/);
});

test("权重:人判 > 流水线;一年减半;返工减得比命中加得狠;general 略重", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");
  const fresh = { judged_by: "human", scope: "local", at: "2026-09-01T00:00:00Z" } as const;
  const human = memoryWeight(fresh, EMPTY_STATS, now);
  const pipeline = memoryWeight({ ...fresh, judged_by: "pipeline" }, EMPTY_STATS, now);
  const yearOld = memoryWeight({ ...fresh, at: "2025-09-01T00:00:00Z" }, EMPTY_STATS, now);
  const used = memoryWeight(fresh, { ...EMPTY_STATS, hits: 2 }, now);
  const reworked = memoryWeight(fresh, { ...EMPTY_STATS, hits: 2, reworks: 1 }, now);
  const general = memoryWeight({ ...fresh, scope: "general" }, EMPTY_STATS, now);
  assert.ok(human > pipeline);
  assert.ok(Math.abs(yearOld - human / 2) < 0.01);
  assert.ok(used > human && reworked < human);
  assert.ok(general > human);
  assert.ok(memoryWeight(fresh, { ...EMPTY_STATS, reworks: 9 }, now) >= 0.05, "有下限,不归零");
});

test("服务起草:闭环记忆入库后异步补一版;user_note 不过起草;模型出错保留模板", async () => {
  const calls: string[] = [];
  const { svc } = fakeService({
    memoryDrafter: async (prompt: { user: string }) => {
      calls.push(prompt.user);
      if (prompt.user.includes("这次手滑")) throw new Error("模型 500");
      return '{"trigger":"改过滤器判断顺序时","scope":"one_off"}';
    },
  });
  try {
    const { id, internal } = liveTask(svc);
    // user_note:圈选那句话就是 trigger,不起草
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/filter/FilterEngine.java", line: 1,
      anchor: "x", note: "人记的", kind: "code", route: "memory",
    });
    const drafted = (svc as any).recordMemory(internal, { ...base, task: id });
    const broken = (svc as any).recordMemory(internal,
      { ...base, task: id, evidence: "e3", problem: "这次手滑" });
    await svc.flushMemoryDrafts();
    assert.equal(calls.length, 2, "user_note 不进起草");
    const rows = svc.listTaskMemories(id);
    const note = rows.find((row) => row.source === "user_note")!;
    assert.equal(note.draft, undefined);
    assert.equal(note.revision, undefined, "没起草就不追加版本");
    const good = rows.find((row) => row.id === drafted.id)!;
    assert.equal(good.trigger, "改过滤器判断顺序时");
    assert.equal(good.scope, "one_off");
    assert.equal(good.draft, "model");
    const kept = rows.find((row) => row.id === broken.id)!;
    assert.equal(kept.draft, "failed");
    assert.equal(kept.trigger, base.trigger);
    assert.equal(kept.scope, "local");
    // one_off 的不再进推送候选(别的单看过来)
    const other = liveTask(svc, "另一单");
    const ids = (svc as any).memoryCandidates(other.internal).map((row: any) => row.id);
    assert.ok(!ids.includes(drafted.id), "一次性只进全文检索");
    assert.ok(ids.includes(kept.id));
  } finally {
    await svc.shutdown();
  }
});

test("台账与效果账:推送记 push;推过的文件又被提意见记 rework,权重掉到后面;总览能看到", async () => {
  const { svc, dataDir } = fakeService();
  try {
    const store = new MemoryStore(dataDir);
    const a = store.record({ ...base, conclusion: "A:黑名单在开关前" });
    const b = store.record({ ...base, evidence: "e2", conclusion: "B:另一条同文件的" });
    const { id, internal, steered } = liveTask(svc);
    (svc as any).maybePushPhaseMemories(internal, "定规格");
    (svc as any).maybePushPhaseMemories(internal, "写代码");
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(steered.length, 1);
    const stats = store.ledger.stats();
    assert.equal(stats.get(a.id)?.pushes, 1);
    assert.equal(stats.get(b.id)?.pushes, 1);

    // 人对同一文件提了意见(路由给 Agent)→ 两条都记返工;同单不重复记
    const before = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.deepEqual(new Set(before), new Set([a.id, b.id]));
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/filter/FilterEngine.java", line: 90,
      anchor: "y", note: "这里还是不对", kind: "code",
    });
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/filter/FilterEngine.java", line: 91,
      anchor: "z", note: "再提一条", kind: "code",
    });
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/other/X.java", line: 1,
      anchor: "q", note: "别的文件,不算", kind: "code",
    });
    const after = store.ledger.rows().filter((row) => row.kind === "rework");
    assert.equal(after.length, 2, "同单同条只记一次;别的文件不算");
    assert.deepEqual(new Set(after.map((row) => row.id)), new Set([a.id, b.id]));

    // 没推过的第三条现在排最前(返工把前两条压下去了)
    const c = store.record({ ...base, evidence: "e3", conclusion: "C:没推过的" });
    const ranked = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.equal(ranked[0], c.id);

    const insights = svc.memoryInsights();
    assert.equal(insights.sidecar, "absent");
    assert.equal(insights.repos[0].repo, "notify-service");
    assert.equal(insights.repos[0].active, 3);
    assert.equal(insights.repos[0].reworks, 2);
    assert.equal(insights.repos[0].pushes, 2);
    assert.equal(insights.memories[0].id, c.id);
    assert.equal(insights.memories.find((row) => row.id === a.id)?.reworks, 1);
    assert.ok(svc.readMemoryInsight(a.id)?.content.includes("## 结论"));
    assert.equal(svc.readMemoryInsight("c-nope-000000"), undefined);

    // 时间线:推送进了时间轴
    const timeline = buildTimeline(internal.summary.workspace, internal.cwd);
    const memoryEntries = timeline.filter((entry) => entry.kind === "memory");
    assert.equal(memoryEntries.length, 1);
    assert.match(memoryEntries[0].title, /进入「写代码」推送 2 条记忆/);
  } finally {
    await svc.shutdown();
  }
});

test("沉底:一年没人用的、失锚半年的挪进 _archive;不删、还能读、不再推;有 sidecar 就重建索引", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-"));
  const logs: string[] = [];
  const svc = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    log: (line: string) => logs.push(line),
    memory: { python: process.execPath, script: STUB, milvusPath: join(dataDir, "m.db") },
  });
  try {
    const store = new MemoryStore(dataDir);
    const idle = store.record({ ...base, conclusion: "一年没人用" });
    const lost = store.record({ ...base, evidence: "e2", conclusion: "失锚半年" });
    const alive = store.record({ ...base, evidence: "e3", conclusion: "最近推过" });
    const now = Date.now() + 400 * DAY;
    store.ledger.append({ kind: "unanchored", id: lost.id,
      at: new Date(Date.now() - 200 * DAY).toISOString() });
    store.ledger.append({ kind: "push", id: alive.id, task: "t", at: new Date(now - DAY).toISOString() });
    const archived = svc.sweepMemoryArchive({ now });
    assert.deepEqual(new Set(archived.map((row) => row.id)), new Set([idle.id, lost.id]));
    assert.match(archived.find((row) => row.id === idle.id)!.reason, /从未被推送或命中/);
    assert.match(archived.find((row) => row.id === lost.id)!.reason, /失锚超过 180 天/);
    assert.ok(!existsSync(join(store.root, idle.file)));
    assert.ok(existsSync(join(store.root, "_archive", idle.file)), "挪走不是删掉");
    assert.match(store.read(idle.id) ?? "", /一年没人用/, "归档的还能读");
    const rows = store.list();
    assert.equal(rows.find((row) => row.id === idle.id)?.archived, true);
    assert.equal(rows.find((row) => row.id === alive.id)?.archived, undefined);
    assert.deepEqual(svc.sweepMemoryArchive({ now }), [], "第二次扫没有新的");
    const { internal } = liveTask(svc);
    const ids = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.deepEqual(ids, [alive.id], "归档的不推");
    await new Promise((tick) => setTimeout(tick, 300));
    assert.ok(logs.some((line) => line.includes("沉底后索引重建完成")), logs.join("\n"));
    assert.equal(svc.memoryInsights().repos[0].archived, 2);
  } finally {
    await svc.shutdown();
  }
});

test("目录摘要层:同目录超 15 条推摘要不推明细;按成员缓存;模型摘要要引用真实 id", async () => {
  let drafts = 0;
  const { svc, dataDir } = fakeService({
    memoryDrafter: async (prompt: { user: string }) => {
      drafts += 1;
      const id = prompt.user.match(/c-[a-z0-9]+-[a-f0-9]+/)![0];
      return `- 有人多次要求黑名单判断在渠道开关之前(${id})\n- 加渠道要同步 registry.xml(${id})`;
    },
  });
  try {
    const store = new MemoryStore(dataDir);
    for (let index = 0; index < 16; index += 1) {
      store.record({ ...base, evidence: `e${index}`, conclusion: `结论 ${index}` });
    }
    const first = liveTask(svc);
    (svc as any).onMemoryFileIntent(first.internal, "src/filter/FilterEngine.java");
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(first.steered.length, 1);
    assert.match(first.steered[0].text, /攒了 16 条历史记忆,先看摘要/);
    assert.match(first.steered[0].text, /有人多次要求黑名单判断/);
    assert.match(first.steered[0].text, /path_prefix=src\/filter/);
    assert.equal(first.steered[0].extra.memory_ids.length, 16);
    assert.equal(drafts, 1);
    const usage = svc.listTaskMemoryUsage(first.id);
    assert.equal(usage[0].digest, true);
    const cache = join(store.root, "_digests", "notify-service");
    assert.ok(existsSync(cache));

    // 另一单、同目录、成员没变:直接用缓存,不再叫模型
    const second = liveTask(svc, "第二单");
    (svc as any).onMemoryFileIntent(second.internal, "src/filter/Other.java");
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(second.steered.length, 1);
    assert.equal(drafts, 1, "成员集合没变就复用缓存");

    // 成员变了(多一条)→ 重做
    store.record({ ...base, evidence: "e-new", conclusion: "新的一条" });
    const third = liveTask(svc, "第三单");
    (svc as any).onMemoryFileIntent(third.internal, "src/filter/Third.java");
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(drafts, 2);

    // 时间线里是"推送目录摘要"
    const timeline = buildTimeline(first.internal.summary.workspace, first.internal.cwd);
    assert.match(timeline.find((entry) => entry.kind === "memory")!.title, /推送目录摘要\(16 条\)/);
  } finally {
    await svc.shutdown();
  }
});

test("目录摘要:没有模型时用确定性兜底,也缓存", async () => {
  const { svc, dataDir } = fakeService();
  try {
    const store = new MemoryStore(dataDir);
    for (let index = 0; index < 17; index += 1) {
      store.record({ ...base, evidence: `e${index}`, conclusion: `结论 ${index}` });
    }
    const { internal, steered } = liveTask(svc);
    (svc as any).onMemoryFileIntent(internal, "src/filter/FilterEngine.java");
    await new Promise((tick) => setTimeout(tick, 200));
    assert.equal(steered.length, 1);
    assert.match(steered[0].text, /另有 12 条,用 corpus_search/);
  } finally {
    await svc.shutdown();
  }
});

test("可见不可管:效能页记忆页签没有任何改动入口", () => {
  // 只看 JSX,不看文件头注释——注释里正是在说"这里没有编辑没有删除"。
  const board = readFileSync(resolve(process.cwd(), "web/src/MemoryBoard.tsx"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["撤回</button>", "删除", "编辑", "审核", "method: \"POST\""]) {
    assert.ok(!board.includes(word), `记忆总览不该有「${word}」`);
  }
  assert.ok(board.includes("getMemoryInsights") && board.includes("readMemoryInsight"));
  const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf-8");
  assert.ok(app.includes('"memories"') && app.includes("<MemoryBoard"), "团队资产多一个只读页签");
});

test("真 memsearch:起草改标题后再入库能按新说法搜到;归档并重建索引后搜不到(venv 缺席则 skip)", async (t) => {
  if (!existsSync(REAL_PYTHON)) {
    t.skip(`找不到 memsearch venv 的 python(${REAL_PYTHON});设 MFC_MEMSEARCH_PYTHON 后重跑`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-real-"));
  const store = new MemoryStore(dataDir);
  const sidecar = new MemorySidecar({
    python: REAL_PYTHON, script: REAL_SCRIPT,
    corpusDir: store.root, milvusPath: join(dataDir, "memsearch", "milvus.db"),
    budgets: { searchMs: 5_000, ingestMs: 20_000, bootMs: 120_000 },
    env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    log: () => {},
  });
  try {
    assert.equal(await sidecar.start(), true, "真 sidecar 起不来");
    const record = store.record(base);
    const other = store.record({ ...base, evidence: "e2", paths: ["pom.xml"], line: undefined,
      trigger: "加新渠道时", problem: "", quote: "", conclusion: "枚举新增渠道要同步改 registry.xml" });
    assert.equal(await sidecar.ingest(join(store.root, record.file)), true);
    assert.equal(await sidecar.ingest(join(store.root, other.file)), true);
    const next = store.finalizeDraft(record.id, {
      trigger: "调整过滤器里判断先后顺序时", scope: "general", state: "model" });
    assert.equal(await sidecar.ingest(join(store.root, next.file)), true);
    const hits = await sidecar.search({ query: "过滤器判断先后顺序", repo: "notify-service" });
    assert.equal(hits?.[0]?.id, record.id, "按起草后的新说法能搜到");
    store.archive(record.id, "测试归档");
    const chunks = await sidecar.reindex();
    assert.ok(typeof chunks === "number", "重建索引要回块数");
    const after = await sidecar.search({ query: "过滤器判断先后顺序", repo: "notify-service" });
    assert.ok(!(after ?? []).some((hit) => hit.id === record.id),
      `归档并重建后不该再搜到: ${JSON.stringify(after)}`);
    assert.ok((after ?? []).some((hit) => hit.id === other.id) || (after ?? []).length === 0);
  } finally {
    sidecar.stop();
  }
});
