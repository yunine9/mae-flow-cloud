import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeConsolidation,
  type ConsolidationInput,
} from "../src/knowledgeConsolidation.ts";
import {
  readConsolidationAudit,
  readConsolidationSource,
} from "../src/knowledgeConsolidationAudit.ts";
import { knowledgeMaterialTool } from "../src/knowledgeConsolidationAgent.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { knowledgeDocumentRoute } from "../src/knowledgeDocumentRoutes.ts";
import { consolidationRoot } from "../src/knowledgeConsolidationStore.ts";
const wait = async (m: KnowledgeConsolidation) => {
  for (let i = 0; i < 300; i++) {
    if (!m.view().jobs.some((j) => j.state === "running")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("未完成");
};
const result = (i: ConsolidationInput) =>
  JSON.stringify({
    topics: [
      {
        key: "资源",
        title: "资源管理专题",
        summary: "管理资源时",
        rationale:
          "合并重复的句柄释放规则，保留借用句柄的例外；日志规则未纳入。",
        content: "# 资源管理\n创建方释放；借用方不关闭。",
        sources: i.sources.map((s) => ({
          id: s.id,
          full: false,
          sections: ["句柄"],
        })),
        conflicts: [],
      },
    ],
  });
test("允许最终 JSON 前的说明，但仍拒绝未知来源", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-fenced-"));
  const source = saveKnowledgeDocument(
    dir,
    { title: "规则", content: "创建方释放资源" },
    "dev",
  );
  let invalid = false;
  const manager = new KnowledgeConsolidation(dir, async (input) => {
    const output = JSON.parse(result(input));
    if (invalid) output.topics[0].sources[0].id = "unknown-source";
    return `已核对原文，以下是整理结果。\n\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;
  });
  try {
    manager.start("dev");
    await wait(manager);
    assert.equal(manager.view().jobs.at(-1)?.state, "done");
    invalid = true;
    saveKnowledgeDocument(
      dir,
      {
        id: source.id,
        title: source.title,
        content: "创建方释放资源，失败也要清理",
      },
      "dev",
    );
    manager.start("dev");
    await wait(manager);
    assert.equal(manager.view().jobs.at(-1)?.state, "failed");
    assert.match(manager.view().jobs.at(-1)?.error ?? "", /未知/);
  } finally {
    await manager.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("整理记录保留当时原文、生成稿、依据及工具操作，不跟随人工编辑漂移", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-audit-"));
  const source = saveKnowledgeDocument(
    dir,
    { title: "文件指南", content: "# 句柄\n创建方释放；借用句柄不关闭。" },
    "member",
  );
  const m = new KnowledgeConsolidation(dir, async (i) => {
    const tool = knowledgeMaterialTool(i);
    await tool.execute("a", { action: "list" });
    await tool.execute("b", { action: "search", query: "句柄" });
    await tool.execute("c", { action: "read", id: source.id });
    return result(i);
  });
  try {
    const job = m.start("member");
    await wait(m);
    let audit = readConsolidationAudit(dir, job.id);
    assert.equal(audit.job.trigger, "manual");
    assert.ok(audit.job.ended_at);
    assert.equal(audit.groups.length, 1);
    const group = audit.groups[0];
    assert.equal(group.results![0].disposition, "draft");
    assert.match(group.results![0].version.rationale!, /日志规则未纳入/);
    assert.equal(
      group.actions.filter((a) => a.action.endsWith(":finished")).length,
      3,
    );
    assert.equal(group.actions.at(-1)?.characters, source.content.length);
    assert.ok(
      !JSON.stringify(group.sources).includes(source.content),
      "列表不带整份原文",
    );
    const t = m.view().topics[0];
    m.act(
      t.id,
      "edit",
      {
        revision: t.revision,
        title: t.pending!.title,
        content: "# 人工调整版",
        covered: [],
      },
      "reviewer",
    );
    saveKnowledgeDocument(
      dir,
      { content: "# 后来替换的文档" },
      "member",
      source.id,
    );
    audit = readConsolidationAudit(dir, job.id);
    assert.match(audit.groups[0].results![0].version.content, /创建方释放/);
    assert.equal(
      readConsolidationSource(dir, job.id, group.key, source.id).content,
      source.content,
    );
    assert.throws(() => readConsolidationAudit(dir, "../../auth"), /不存在/);
    assert.throws(
      () => readConsolidationSource(dir, job.id, "../../auth", source.id),
      /不存在/,
    );
    assert.throws(
      () => readConsolidationSource(dir, job.id, group.key, "不存在"),
      /不存在/,
    );
  } finally {
    await m.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("更新保留上轮采纳内容；有待审草稿时归档被暂缓的建议，不覆盖人工内容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-before-"));
  const source = saveKnowledgeDocument(
    dir,
    { title: "指南", content: "初版" },
    "member",
  );
  const m = new KnowledgeConsolidation(dir, async (i) => result(i));
  try {
    m.start("member");
    await wait(m);
    let t = m.view().topics[0];
    m.act(
      t.id,
      "adopt",
      {
        revision: t.revision,
        title: t.pending!.title,
        content: "# 人工采纳的旧版",
        covered: [],
      },
      "reviewer",
    );
    saveKnowledgeDocument(dir, { content: "新来源" }, "member", source.id);
    const job = m.start("member");
    await wait(m);
    const audit = readConsolidationAudit(dir, job.id);
    assert.equal(
      audit.groups[0].before[0].published!.content,
      "# 人工采纳的旧版",
    );
    saveKnowledgeDocument(dir, { content: "再次变化" }, "member", source.id);
    const deferred = m.start("member");
    await wait(m);
    assert.equal(
      readConsolidationAudit(dir, deferred.id).groups[0].results![0]
        .disposition,
      "deferred",
    );
  } finally {
    await m.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("旧记录不补造快照；详情与原文接口可访问，不暴露配置或思考记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-route-"));
  const source = saveKnowledgeDocument(
    dir,
    { title: "指南", content: "输入" },
    "member",
  );
  const m = new KnowledgeConsolidation(dir, async (i) => result(i));
  try {
    const job = m.start("member");
    await wait(m);
    let audit = readConsolidationAudit(dir, job.id);
    const root = join(
      consolidationRoot(dir),
      "runs",
      job.id,
      audit.groups[0].key,
    );
    writeFileSync(join(root, "transcript.jsonl"), "secret-thinking");
    writeFileSync(join(root, "models.json"), "secret-key");
    let code = 0,
      data: any;
    const call = (parts: string[]) =>
      knowledgeDocumentRoute(
        { method: "GET" } as any,
        {} as any,
        ["knowledge-documents", "consolidation", ...parts],
        {
          options: { dataDir: dir },
          getKnowledgeConsolidation: () => m,
        } as any,
        "member",
        async () => ({}),
        (_r, s, v) => {
          code = s;
          data = v;
        },
      );
    await call(["jobs", job.id]);
    assert.equal(code, 200);
    assert.ok(!JSON.stringify(data).includes("secret"));
    await call([
      "jobs",
      job.id,
      "source",
      audit.groups[0].key,
      encodeURIComponent(source.id),
    ]);
    assert.equal(code, 200);
    assert.equal(data.content, "输入");
    rmSync(join(root, "results.json"));
    rmSync(join(root, "before.json"));
    audit = readConsolidationAudit(dir, job.id);
    assert.equal(audit.groups[0].results, undefined);
    assert.deepEqual(audit.groups[0].before, []);
    assert.equal(audit.groups[0].sources.length, 1);
    await call(["jobs", "../../auth"]);
    assert.equal(code, 400);
  } finally {
    await m.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
