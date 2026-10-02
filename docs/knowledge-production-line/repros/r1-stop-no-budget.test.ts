// 复现：停止只翻状态、不给执行体收口预算。执行体不响应 abort 时，槽位与"继续/重试"永久被占。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../../../src/domainKnowledgeExtraction.ts";

const config = (n: number) => ({ title: `订单${n}`, scope: "订单规则", issue_no: "REQ-1", repositories: [{ repository: `https://example.test/orders${n}.git`, branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test("领域：执行体不响应中止时，停止后的任务无法继续，且两个这样的任务把全局队列堵死", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r1-stop-"));
  const started: string[] = [];
  // 模拟一个忽略 signal 的执行体（例如卡在不响应 abort 的工具/会话收束里）
  const service = new DomainKnowledgeExtraction(dir, async input => { started.push(input.job.id); return new Promise<string>(() => {}); });
  try {
    const a = service.create(config(1), "alice"), b = service.create(config(2), "bob");
    await sleep(50);
    const c = service.create(config(3), "carol");
    await sleep(50);
    assert.deepEqual(started.sort(), [a.id, b.id].sort());
    service.stop(a.id); service.stop(b.id);
    assert.equal(service.get(a.id).status, "cancelled");
    await sleep(300);
    // 停止后界面显示"已停止"，但：
    assert.throws(() => service.resume(a.id, "alice"), /当前任务不能接续/, "停止后不能接续");
    assert.throws(() => service.run(a.id, { mode: "discuss", document_ids: [], message: "x" }, "alice"), /请等待本轮完成或停止后继续/);
    assert.equal(service.get(c.id).status, "queued", "第三个任务永远排队：并发槽被两个已停止的执行体占着");
    assert.ok(!started.includes(c.id));
    console.log("[r1] stop 后 a=", service.get(a.id).status, "c=", service.get(c.id).status, service.get(c.id).stage);
  } finally { await Promise.race([service.shutdown(), sleep(200)]); rmSync(dir, { recursive: true, force: true }); }
});

test("领域：shutdown 无预算等待不响应中止的执行体", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r1-shutdown-"));
  const service = new DomainKnowledgeExtraction(dir, async () => new Promise<string>(() => {}));
  try {
    service.create(config(1), "alice"); await sleep(30);
    const result = await Promise.race([service.shutdown().then(() => "returned"), sleep(500).then(() => "still-waiting")]);
    assert.equal(result, "still-waiting");
    console.log("[r1] shutdown after 500ms:", result);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
