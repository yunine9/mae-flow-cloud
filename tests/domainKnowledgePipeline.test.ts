import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DomainKnowledgePipeline, type KnowledgeWork, type KnowledgeWorkResult } from "../src/domainKnowledgePipeline.ts";
import { scanKnowledgeCode, knowledgeStructure, validateKnowledgeReferences } from "../src/domainKnowledgeCode.ts";
import { IncompleteDomainResearch } from "../src/domainResearchProgress.ts";

const result = (task: KnowledgeWork): KnowledgeWorkResult => ({ findings: "已查边界；历史原因未确认", document_ids: [task.id], open_questions: ["原因待业务负责人确认"],
  ...(task.phase === "inventory" ? { modules: [{ id: "orders", title: "订单", kind: "business" as const, depends_on: [], scope: "repo-1:src/orders" }] } : {}),
  ...(task.phase === "plan" ? { subfeatures: [{ id: "cancel", title: "取消", hops: [{ id: "api", title: "请求到后台", questions: "重复取消怎样处理？为什么？" }] }] } : {}),
  ...(task.phase === "cross-plan" ? { cross_items: [] } : {}),
});
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "domain-pipeline-")); return { root, file: join(root, "state.json"), signal: new AbortController().signal }; };

test("小任务按依赖执行，独立评审退回后重做，接续不重复通过项", async () => {
  const f = fixture(), seen: string[] = [], reviewed: string[] = [];
  try {
    const pipeline = new DomainKnowledgePipeline(f.file, "method-v1");
    await pipeline.run({ signal: f.signal, stage: () => {}, execute: async task => { seen.push(task.id); if (task.id === "hop-orders-cancel-api" && task.attempts === 2) assert.match(task.feedback!, /补充失败路径/); return result(task); },
      review: async task => { reviewed.push(task.id); return task.phase === "hop" && task.attempts === 1 ? "补充失败路径" : undefined; } });
    assert.equal(seen.filter(id => id === "hop-orders-cancel-api").length, 2);
    assert.deepEqual(seen, reviewed);
    assert.ok(seen.indexOf("common-orders") > seen.lastIndexOf("hop-orders-cancel-api"));
    assert.ok(seen.indexOf("cross-plan") > seen.indexOf("wrap-orders"));
    const resumed = new DomainKnowledgePipeline(f.file, "method-v1");
    await resumed.run({ signal: f.signal, stage: () => {}, execute: async () => { throw new Error("不应重复已完成任务"); }, review: async () => undefined });
    assert.equal(resumed.state.tasks.every(t => t.status === "done"), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("三次失败有上限，独立模块继续，原任务接续保留通过结果", async () => {
  const f = fixture();
  try {
    const pipeline = new DomainKnowledgePipeline(f.file, "v1");
    const execute = async (task: KnowledgeWork) => {
      if (task.id === "plan-orders") throw new Error("读取失败");
      const r = result(task);
      if (r.modules) r.modules.push({ id: "shared", title: "公共机制", kind: "public", depends_on: [], scope: "src/common" });
      return r;
    };
    await assert.rejects(pipeline.run({ signal: f.signal, stage: () => {}, execute, review: async () => undefined }), IncompleteDomainResearch);
    assert.equal(pipeline.state.tasks.find(t => t.id === "plan-orders")?.attempts, 3);
    assert.equal(pipeline.state.tasks.find(t => t.id === "wrap-shared")?.status, "done");
    const resumed = new DomainKnowledgePipeline(f.file, "v1");
    await resumed.run({ signal: f.signal, stage: () => {}, execute: async task => result(task), review: async () => undefined });
    assert.equal(resumed.state.tasks.every(t => t.status === "done"), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("校准等待不会因服务重启自动通过，显式接续才继续", async () => {
  const f = fixture();
  try {
    const execute = async (task: KnowledgeWork) => {
      const r = result(task); if (r.modules) r.modules.push({ id: "billing", title: "账务", kind: "business", depends_on: [], scope: "src/billing" }); return r;
    };
    const options = { signal: f.signal, stage: () => {}, execute, review: async () => undefined };
    const p = new DomainKnowledgePipeline(f.file, "v1");
    await assert.rejects(p.run(options), /前两个业务模块/);
    await assert.rejects(new DomainKnowledgePipeline(f.file, "v1").run(options), /等待/);
    const resumed = new DomainKnowledgePipeline(f.file, "v1", 1); await resumed.run(options);
    assert.equal(resumed.state.calibration, "accepted");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("循环依赖被拒绝，取消保留正在执行项以便恢复", async () => {
  const f = fixture();
  try {
    const p = new DomainKnowledgePipeline(f.file, "v1");
    await assert.rejects(p.run({ signal: f.signal, stage: () => {}, execute: async task => ({ ...result(task), modules: [{ id: "a", title: "a", kind: "business", depends_on: ["a"], scope: "src" }] }), review: async () => undefined }), /循环/);
    const controller = new AbortController();
    const restored = new DomainKnowledgePipeline(f.file, "v1");
    await assert.rejects(restored.run({ signal: controller.signal, stage: () => {}, execute: async task => { controller.abort(); return result(task); }, review: async () => undefined }));
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).tasks[0].status, "running");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("引用校验按固定 Git 版本与研究范围检查，拒绝假仓、越界路径、行号和符号", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q", f.root]); mkdirSync(join(f.root, "src")); writeFileSync(join(f.root, "src/order.ts"), "export function cancel() {}\n");
    writeFileSync(join(f.root, "src/CMakeLists.txt"), "add_library(client client.cpp)\ntarget_link_libraries(client PRIVATE engine)\n");
    mkdirSync(join(f.root, "src/java")); writeFileSync(join(f.root, "src/java/pom.xml"), "<project><parent><artifactId>parent</artifactId></parent><artifactId>engine</artifactId><dependencies><dependency><artifactId>external</artifactId></dependency></dependencies></project>");
    execFileSync("git", ["-C", f.root, "add", "."]); execFileSync("git", ["-C", f.root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
    const revision = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const snapshot = await scanKnowledgeCode({ id: "repo-1", name: "订单", repository: "fixture", branch: "main", path: "src", docs_path: "docs" }, { root: f.root, revision }, f.signal);
    assert.equal(snapshot.build_units.length, 2);
    assert.deepEqual(knowledgeStructure([snapshot])[0].dependency_edges, [{ from: "repo-1:src/CMakeLists.txt", to: "repo-1:src/java/pom.xml", dependency: "engine" }]);
    writeFileSync(join(f.root, "src/order.ts"), "changed working tree\n");
    const valid = await validateKnowledgeReferences('---\nrelated_code:\n  - "repo-1:src/**"\n---\n`repo-1:src/order.ts:1` `订单:src/order.ts#cancel`', [snapshot], f.signal);
    assert.deepEqual(valid.errors, []); assert.equal(valid.checked.length, 3);
    const invalid = await validateKnowledgeReferences('`other:src/order.ts` `repo-1:../secret` `repo-1:src/order.ts:999` `repo-1:src/order.ts#absent` `repo-1:other/file.ts`', [snapshot], f.signal);
    assert.equal(invalid.errors.length, 5);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
