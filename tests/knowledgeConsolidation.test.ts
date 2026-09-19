import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeConsolidation,
  type ConsolidationInput,
} from "../src/knowledgeConsolidation.ts";
import {
  readConsolidation,
  writeConsolidation,
  consolidationRoot,
} from "../src/knowledgeConsolidationStore.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import {
  collectSearchableKnowledge,
  KnowledgeSearch,
} from "../src/knowledgeSearch.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { knowledgeDocumentCatalog } from "../src/knowledgeDocumentCatalog.ts";
import {
  knowledgeMaterialTool,
  KNOWLEDGE_CONSOLIDATION_MISSION,
  runKnowledgeConsolidationAgent,
} from "../src/knowledgeConsolidationAgent.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { MemoryStore } from "../src/taskMemory.ts";
const context = { repo: "r", repositories: [], moduleIds: [] };
const create = () => mkdtempSync(join(tmpdir(), "knowledge-consolidation-"));
const doc = (dir: string, title: string, extra: any = {}) =>
  saveKnowledgeDocument(
    dir,
    {
      title,
      content: `# ${title}\n句柄创建方负责释放；借用句柄不释放。`,
      technologies: ["cpp"],
      ...extra,
    },
    "member",
  );
const output = (input: ConsolidationInput, extra: any = {}) =>
  JSON.stringify({
    topics: [
      {
        key: "句柄生命周期",
        title: "文件句柄与资源释放",
        summary: "操作文件句柄时",
        content:
          "# 文件句柄\n\n## 适用条件\nC++ 文件组件；借用句柄不释放。\n\n## 异常处理\n创建方即使提前返回也负责清理。",
        sources: input.sources.map((s, i) => ({
          id: s.id,
          full: i === 0,
          sections: ["资源释放"],
        })),
        conflicts: [],
        ...extra,
      },
    ],
  });
const finish = async (service: KnowledgeConsolidation) => {
  for (let i = 0; i < 300; i++) {
    if (!service.view().jobs.some((j) => j.state === "running")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("整理未结束");
};
const adopt = (service: KnowledgeConsolidation, covered?: string[]) => {
  const t = service.view().topics.find((t) => t.pending)!;
  return service.act(
    t.id,
    "adopt",
    {
      revision: t.revision,
      title: t.pending!.title,
      content: t.pending!.content,
      covered:
        covered ?? t.pending!.sources.filter((s) => s.full).map((s) => s.id),
    },
    "reviewer",
  );
};

test("真实 MD → 待审 → 编辑采纳 → 去重检索 → 来源变化自动回退，原文可导出", async () => {
  const dir = create();
  let calls = 0;
  const service = new KnowledgeConsolidation(dir, async (input) => {
    calls++;
    return output(input);
  });
  try {
    const a = doc(dir, "创建方释放"),
      b = doc(dir, "异常清理");
    service.start("member");
    await finish(service);
    assert.equal(calls, 1);
    assert.equal(collectSearchableKnowledge(dir, context).assets.length, 2);
    const t = service.view().topics[0];
    service.act(
      t.id,
      "edit",
      {
        revision: t.revision,
        title: t.pending!.title,
        content: t.pending!.content + "\n人工补充：不关闭调用方句柄。",
        covered: [],
      },
      "reviewer",
    );
    const published = adopt(service, [a.id]);
    assert.match(
      readFileSync(
        join(consolidationRoot(dir), "published", `${published.id}.md`),
        "utf8",
      ),
      /人工补充/,
    );
    const catalog = collectSearchableKnowledge(dir, context).assets;
    assert.ok(catalog.some((x) => x.id === published.id));
    assert.ok(!catalog.some((x) => x.id === a.id));
    assert.ok(catalog.some((x) => x.id === b.id));
    assert.ok(
      knowledgeDocumentCatalog(dir).documents.some((x) => x.id === a.id),
      "原文可读可导出",
    );
    service.start("member");
    await finish(service);
    assert.equal(calls, 1, "无变化不调用模型");
    saveKnowledgeDocument(
      dir,
      { content: a.content + "\n新版本提供 RAII 封装。" },
      "member",
      a.id,
    );
    assert.ok(
      !collectSearchableKnowledge(dir, context).assets.some(
        (x) => x.id === published.id,
      ),
    );
    assert.equal(collectSearchableKnowledge(dir, context).assets.length, 2);
    service.start("member");
    await finish(service);
    assert.equal(service.view().topics.length, 1, "更新稳定专题，不重复创建");
    assert.equal(calls, 2);
    saveKnowledgeDocument(dir, { active: false }, "member", b.id);
    assert.throws(() => adopt(service), /来源已变更/);
    assert.deepEqual(
      collectSearchableKnowledge(dir, context).assets.map((x) => x.id),
      [a.id],
    );
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("相似的不同模块、语言、版本分别整理，模型不能跨组引用", async () => {
  const dir = create(),
    groups: string[][] = [];
  const service = new KnowledgeConsolidation(dir, async (input) => {
    groups.push(input.sources.map((s) => s.id));
    return output(input);
  });
  try {
    for (const id of ["a", "b"])
      createBusinessModule(
        dir,
        {
          id,
          name: id,
          description: "模块",
          owner: "owner",
          repositories: [`https://example.com/${id}.git`],
        },
        "owner",
      );
    doc(dir, "超时", { scope: "module", module_ids: ["a"] });
    doc(dir, "超时", { scope: "module", module_ids: ["b"] });
    doc(dir, "超时", { technologies: ["java"] });
    doc(dir, "超时", { product_versions: ["2.7B"] });
    service.start("member");
    await finish(service);
    assert.equal(groups.length, 4);
    assert.ok(groups.every((g) => g.length === 1));
    const state = service.view();
    for (const t of state.topics)
      service.act(
        t.id,
        "adopt",
        {
          revision: t.revision,
          title: t.pending!.title,
          content: t.pending!.content,
          covered: [],
        },
        "member",
      );
    const visible = collectSearchableKnowledge(dir, {
      ...context,
      moduleIds: ["a"],
      productVersion: "2.6B",
    }).assets;
    assert.ok(
      !visible.some(
        (v) => v.scope === "业务模块：b" || v.productVersions.includes("2.7B"),
      ),
    );
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("人工草稿不被每日任务覆盖；来源改动在审查后继续增量整理", async () => {
  const dir = create();
  let calls = 0;
  const service = new KnowledgeConsolidation(dir, async (i) => {
    calls++;
    return output(i);
  });
  try {
    const a = doc(dir, "规则");
    service.start("member");
    await finish(service);
    let t = service.view().topics[0];
    service.act(
      t.id,
      "edit",
      {
        revision: t.revision,
        title: "人工标题",
        content: "# 人工内容",
        covered: [],
      },
      "member",
    );
    saveKnowledgeDocument(
      dir,
      { content: "# 规则\n更新后的规则" },
      "member",
      a.id,
    );
    service.start("member");
    await finish(service);
    assert.equal(calls, 2);
    assert.equal(service.view().topics[0].pending!.title, "人工标题");
    assert.equal(service.view().topics[0].needs_update, true);
    assert.throws(
      () =>
        service.act(
          t.id,
          "edit",
          { revision: t.revision, title: "过期编辑", content: "x" },
          "another",
        ),
      /草稿已被更新/,
    );
    t = service.view().topics[0];
    service.act(t.id, "discard", { revision: t.revision }, "member");
    service.start("member");
    await finish(service);
    assert.equal(calls, 3);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("定时每日一次，停用不运行，重启保留进度；失败可重试", async () => {
  const dir = create();
  let fail = true,
    calls = 0;
  const runner = async (i: ConsolidationInput) => {
    calls++;
    if (fail) throw new Error("模型暂不可用");
    return output(i);
  };
  let service = new KnowledgeConsolidation(dir, runner);
  try {
    doc(dir, "规则");
    service.settings(
      { enabled: true, time: "03:00", timezone: "Asia/Shanghai" },
      "operator",
    );
    service.tick(new Date("2026-09-18T18:59:00Z"));
    assert.equal(service.view().jobs.length, 0);
    service.tick(new Date("2026-09-18T19:00:00Z"));
    await finish(service);
    assert.equal(service.view().jobs[0].state, "failed");
    await service.shutdown();
    service = new KnowledgeConsolidation(dir, runner);
    service.tick(new Date("2026-09-18T20:00:00Z"));
    await finish(service);
    assert.equal(calls, 1);
    fail = false;
    service.start("operator");
    await finish(service);
    assert.equal(calls, 2);
    assert.equal(service.view().topics.length, 1);
    service.settings(
      { enabled: false, time: "03:00", timezone: "Asia/Shanghai" },
      "member",
    );
    service.tick(new Date("2026-09-19T20:00:00Z"));
    assert.equal(calls, 2);
    assert.throws(() =>
      service.settings(
        { enabled: true, time: "99:00", timezone: "Asia/Shanghai" },
        "member",
      ),
    );
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发点击只启动一次；停止后晚返回结果不写入；重启中断可见", async () => {
  const dir = create();
  let resolve!: (s: string) => void;
  let input!: ConsolidationInput;
  const service = new KnowledgeConsolidation(dir, (i) => {
    input = i;
    return new Promise((r) => (resolve = r));
  });
  try {
    doc(dir, "规则");
    const a = service.start("a"),
      b = service.start("b");
    assert.equal(a.id, b.id);
    await new Promise((r) => setImmediate(r));
    service.stop();
    resolve(output(input));
    await finish(service);
    assert.equal(service.view().topics.length, 0);
    assert.equal(service.view().jobs[0].state, "cancelled");
    const state = readConsolidation(dir);
    state.jobs[0].state = "running";
    writeConsolidation(dir, state);
    const restarted = new KnowledgeConsolidation(dir, async (i) => output(i));
    assert.equal(restarted.view().jobs[0].state, "failed");
    await restarted.shutdown();
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("来源读写竞态与虚构引用不发布；冲突和部分覆盖完整保留", async () => {
  const dir = create();
  let mode = "bad";
  const a = doc(dir, "规则");
  const service = new KnowledgeConsolidation(dir, async (i) => {
    if (mode === "bad")
      return output(i, {
        sources: [{ id: "made-up", full: true, sections: [] }],
      });
    if (mode === "race")
      saveKnowledgeDocument(dir, { content: "新来源" }, "member", a.id);
    return output(i, {
      conflicts: ["组件 A 与 B 的所有权约定不同，待确认"],
      sources: i.sources.map((s) => ({
        id: s.id,
        full: false,
        sections: ["所有权"],
      })),
    });
  });
  try {
    service.start("member");
    await finish(service);
    assert.equal(service.view().topics.length, 0);
    assert.match(service.view().jobs[0].error!, /未知/);
    mode = "race";
    service.start("member");
    await finish(service);
    assert.equal(service.view().topics.length, 0);
    mode = "good";
    service.start("member");
    await finish(service);
    const t = adopt(service);
    assert.equal(t.published!.conflicts.length, 1);
    assert.equal(collectSearchableKnowledge(dir, context).assets.length, 2);
    service.act(t.id, "withdraw", { revision: t.revision }, "member");
    assert.deepEqual(
      collectSearchableKnowledge(dir, context).assets.map((v) => v.id),
      [a.id],
    );
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已采纳经验参加整理，待审经验不参加", async () => {
  const dir = create();
  const store = new MemoryStore(dir);
  try {
    const accepted = store.record({
      trigger: "已采纳",
      conclusion: "借用句柄不释放",
      scope: "platform",
      repo: "r",
      source: "agent_note",
      task: "task-1",
      judged_by: "agent",
      paths: [],
      evidence: "验证样例",
    });
    const pending = store.record({
      trigger: "待审",
      conclusion: "未确认",
      scope: "platform",
      repo: "r",
      source: "agent_note",
      task: "task-1",
      judged_by: "agent",
      paths: [],
      evidence: "验证样例",
    });
    store.review(accepted.id, "member", {
      decision: "accepted",
      revision: accepted.revision ?? 1,
    });
    const sources = collectSearchableKnowledge(dir, context, true, true).assets;
    assert.ok(sources.some((s) => s.id === accepted.id));
    assert.ok(!sources.some((s) => s.id === pending.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("材料工具范围隔离、分页、语义失败退回关键词；主模型只读会话", async (t) => {
  const dir = create();
  doc(dir, "句柄规则");
  const sources = collectSearchableKnowledge(dir, context, true, true).assets;
  const input: ConsolidationInput = {
    root: dir,
    sources,
    topics: [],
    signal: new AbortController().signal,
    progress: () => {},
  };
  try {
    const tool = knowledgeMaterialTool(input, async () => {
      throw new Error("sidecar unavailable");
    });
    assert.match(
      (await tool.execute("1", { action: "search", query: "句柄" })).content[0]
        .text,
      /句柄规则/,
    );
    await assert.rejects(
      () => tool.execute("2", { action: "read", id: "outside" }),
      /不在本次/,
    );
    const read = JSON.parse(
      (
        await tool.execute("3", {
          action: "read",
          id: sources[0].id,
          offset: 5,
        })
      ).content[0].text,
    );
    assert.equal(read.content, sources[0].content.slice(5));
    let options: any;
    t.mock.method(CloudSession, "create", async (o) => {
      options = o;
      return {
        start: async () => ({ status: "turn_finished" }),
        finalReply: () => '{"topics":[]}',
        dispose: () => {},
      };
    });
    assert.equal(
      await runKnowledgeConsolidationAgent(input, {
        choice: { provider: "test", model: "main-model" },
        json: {},
      }),
      '{"topics":[]}',
    );
    assert.equal(options.model, "main-model");
    assert.deepEqual(options.allowedTools, ["knowledge_material"]);
    assert.equal(options.allowHumanQuestions, false);
    assert.match(KNOWLEDGE_CONSOLIDATION_MISSION, /没有条数上限/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("新草稿仅通知一次；通知失败不影响审查、下次调度重试", async () => {
  const dir = create();
  let notified = 0,
    fail = true;
  const service = new KnowledgeConsolidation(
    dir,
    async (i) => output(i),
    () => {},
    () => {},
    async (job) => {
      notified++;
      assert.equal(job.operator, "member");
      if (fail) throw new Error("通知通道暂不可用");
    },
  );
  try {
    doc(dir, "规则");
    service.start("member");
    await finish(service);
    assert.equal(service.view().topics.length, 1);
    assert.equal(notified, 1);
    assert.match(service.view().jobs[0].notification_error!, /暂不可用/);
    fail = false;
    service.settings(
      { enabled: false, time: "03:00", timezone: "Asia/Shanghai" },
      "member",
    );
    service.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(notified, 2);
    service.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(notified, 2);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("搜索期间来源停用，不返回已过期专题；不存在侧车也可离线读有效专题", async () => {
  const dir = create();
  const a = doc(dir, "规则");
  const service = new KnowledgeConsolidation(dir, async (i) => output(i));
  try {
    service.start("member");
    await finish(service);
    const t = adopt(service);
    assert.ok(new KnowledgeSearch(dir).read(context, t.id));
    const search = new KnowledgeSearch(dir, {
      ingest: async () => true,
      search: async () => {
        saveKnowledgeDocument(dir, { active: false }, "member", a.id);
        return [{ id: t.id, score: 1, snippet: "过期" }];
      },
    } as any);
    assert.deepEqual((await search.search(context, "句柄")).hits, []);
    assert.equal(search.read(context, t.id), undefined);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同一范围有待审草稿时仍可生成其他新专题，人工内容不丢失", async () => {
  const dir = create();
  let round = 0;
  const service = new KnowledgeConsolidation(dir, async (i) => {
    round++;
    if (round === 1) return output(i);
    const main = JSON.parse(output(i));
    main.topics.push({
      ...main.topics[0],
      key: "日志脱敏",
      title: "日志中的凭据脱敏",
      content: "# 日志\n认证令牌必须脱敏。",
    });
    return JSON.stringify(main);
  });
  try {
    doc(dir, "句柄");
    service.start("member");
    await finish(service);
    const first = service.view().topics[0];
    doc(dir, "日志", { content: "# 日志\n认证令牌必须脱敏。" });
    service.start("member");
    await finish(service);
    assert.equal(service.view().topics.length, 2);
    assert.equal(
      service.view().topics[0].pending!.content,
      first.pending!.content,
    );
    assert.equal(service.view().topics[0].needs_update, true);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
