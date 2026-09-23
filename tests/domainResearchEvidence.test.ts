import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { businessKnowledgeEvidenceId, knowledgeEvidenceTool } from "../src/domainResearchEvidence.ts";
import { knowledgeMaterialTool } from "../src/knowledgeMaterials.ts";
import { wxdoubaoTool } from "../src/wxdoubao.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";

test("业务资料正文产生可回查引用，目录和空章节不冒充已读取事实", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-evidence-"));
  try {
    const material = await businessMaterial(root), events: Array<Record<string, unknown>> = [];
    const tool = knowledgeMaterialTool([material], join(root, "knowledge-materials"), event => {
      const id = businessKnowledgeEvidenceId(event); events.push({ ...event, evidence_id: id }); return id;
    });
    await tool.execute("list", {}, undefined, undefined, {} as never); assert.equal(events.length, 0);
    await tool.execute("past-end", { id: material.id, start: 9999 }, undefined, undefined, {} as never); assert.equal(events.length, 0);
    const read = await tool.execute("read", { id: material.id }, undefined, undefined, {} as never);
    const data = JSON.parse((read.content[0] as { text: string }).text);
    assert.equal(data.evidence_id, events[0].evidence_id); assert.match(data.sections[0].text, /月底结算/);
    await tool.execute("read-again", { id: material.id }, undefined, undefined, {} as never);
    assert.equal(events[0].evidence_id, events[1].evidence_id, "重复阅读沿用引用，不虚增独立业务证据");
    const restored = JSON.parse(JSON.stringify(events));
    const reference = await knowledgeEvidenceTool(() => restored).execute("lookup", { evidence_id: data.evidence_id }, undefined, undefined, {} as never);
    const location = JSON.parse((reference.content[0] as { text: string }).text);
    assert.equal(location.material_id, material.id); assert.equal(location.version, material.version); assert.ok(location.locations.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("无线豆包实际响应有引用编号，重启后原文可分页回查；失败和空结果没有依据编号", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-query-evidence-")), executable = join(root, "cli");
  const values = { MAE_FLOW_WXDOUBAO_BIN: executable, WXDOUBAO_USERID: "fixture-user", WXDOUBAO_TOKEN: "fixture-credential" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  try {
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:{reason:"历史重复扣款",url:"https://example.test/decision",body:"x".repeat(20000)}}}));`, { mode: 0o700 });
    const records: Array<Record<string, unknown>> = [];
    const tool = wxdoubaoTool(new AbortController().signal, event => {
      const id = businessKnowledgeEvidenceId(event); records.push({ ...event, evidence_id: id }); return id;
    });
    const response = await tool.execute("query", { tool: "knowledge_search", question: "为什么月底不能立即取消" }, undefined, undefined, {} as never);
    const data = JSON.parse((response.content[0] as { text: string }).text); assert.ok(data.evidence_id);
    const restored = JSON.parse(JSON.stringify(records)), read = knowledgeEvidenceTool(() => restored);
    const first = parse(await read.execute("page", { evidence_id: data.evidence_id, count: 100 }, undefined, undefined, {} as never));
    assert.equal(first.next_start, 101); assert.match(first.content, /历史重复扣款/); assert.equal(first.content.length, 100);
    const next = parse(await read.execute("page", { evidence_id: data.evidence_id, start: first.next_start, count: 100 }, undefined, undefined, {} as never));
    assert.equal(next.content.length, 100); assert.equal(next.query.question, "为什么月底不能立即取消");
    writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:[]}}));`, { mode: 0o700 });
    const empty = parse(await tool.execute("empty", { tool: "knowledge_search", question: "暂无资料" }, undefined, undefined, {} as never));
    assert.equal(empty.state, "empty"); assert.equal(empty.evidence_id, undefined);
    assert.equal(businessKnowledgeEvidenceId({ tool: "business_knowledge", status: "failed" }), undefined);
    assert.equal(businessKnowledgeEvidenceId({ tool: "business_knowledge", action: "ar_mr_diff", status: "available", result: "代码补丁" }), undefined, "代码差异不是业务意图的来源");
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});

function parse(result: { content: Array<{ type: string; text?: string }> }) { assert.equal(result.content[0].type, "text"); return JSON.parse(result.content[0].text!); }
