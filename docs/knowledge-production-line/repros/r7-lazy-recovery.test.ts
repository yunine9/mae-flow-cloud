// 复现：领域/组件萃取管理器是懒加载的，服务重启后没人打开知识库页面，就没有任何恢复动作
// （排队研究不接续、running 归档批次不重排、组件 running 记录不改写）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskService } from "../../../src/taskService.ts";

test("重启后不访问知识接口，领域研究与归档批次停在宕机前的 running", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "r7-lazy-"));
  const id = `dkx-${randomUUID()}`, path = join(dataDir, "domain-extraction", id, "job.json");
  mkdirSync(join(dataDir, "domain-extraction", id), { recursive: true });
  const job = { id, title: "订单", scope: "订单", issue_no: "REQ-1", operator: "alice", created_at: new Date().toISOString(), repositories: [], material_ids: [], ar_codes: [], use_wxdoubao: true,
    knowledge_target: { id: "domain", name: "k", repository: "https://example.test/k.git", branch: "main", path: "", docs_path: "domains" },
    status: "running", stage: "研究中", revisions: {}, documents: [], evidence: [], publications: [],
    turns: [{ id: "t1", mode: "extract", document_ids: [], message: "订单", operator: "alice", status: "running", created_at: new Date().toISOString(), proposals: [] }],
    archive_batches: [{ id: "b1", created_at: new Date().toISOString(), operator: "alice", state: "running", documents: [], targets: [], publications: [] }] };
  writeFileSync(path, JSON.stringify(job));
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    await new Promise(r => setTimeout(r, 1500));
    const untouched = JSON.parse(readFileSync(path, "utf8"));
    console.log("[r7] 启动 1.5s 后（无人访问）：", untouched.status, untouched.stage, "batch=", untouched.archive_batches[0].state);
    assert.equal(untouched.status, "running"); assert.equal(untouched.stage, "研究中");
    service.getDomainKnowledgeExtraction();          // 有人打开知识库
    await new Promise(r => setTimeout(r, 300));
    const touched = JSON.parse(readFileSync(path, "utf8"));
    console.log("[r7] 访问后：", touched.status, touched.stage, touched.error ?? "");
    assert.notEqual(touched.stage, "研究中");
  } finally { await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); }
});
