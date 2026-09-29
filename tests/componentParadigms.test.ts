import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { componentArtifact, readComponentArtifact, exportComponentArtifacts, deriveComponentArtifacts, validateComponentParadigm } from "../src/componentParadigms.ts";
import type { ResearchSection } from "../src/componentResearchDocument.ts";
export const paradigmSection = (id = "paradigm-pool-submit"): ResearchSection => ({
  id, title: "后台执行任务", repository_ids: ["base"], revision: 1, selected: true, related_ids: [],
  content: "任务归池管理；退出前等待所有任务完成。", interfaces: "Pool::Submit", integration: "链接 pool target。",
  example: "未编译验证。\n```cpp\nPool p; p.Submit(work); p.Wait();\n```", sources: "", paradigm: {
    kind: "paradigm", component: "pool", language: "cpp", status: "recommended", need: "后台执行任务", api: ["Pool::Submit"],
    applicability: "依赖 pool v2；组件自身实现除外", replaces: { identifiers: ["std::thread"], imports: [], patterns: [] },
    evidence: [{ repository_id: "base", path: "src/pool.cpp", revision: "a".repeat(40), start: 1, end: 2 }],
    usage_evidence: ["everycode-" + "b".repeat(24)], open_questions: [],
  },
});
test("干净 Markdown 与独立元数据往返一致，兼容旧 frontmatter，派生覆盖无替代关系的能力并排除 legacy", () => {
  const section = paradigmSection(); const plain = paradigmSection("paradigm-pool-wait"); plain.paradigm!.replaces.identifiers = []; plain.paradigm!.need = "等待任务完成";
  const legacy = paradigmSection("paradigm-pool-old"); legacy.paradigm!.status = "legacy";
  assert.deepEqual(readComponentArtifact(componentArtifact(section)).paradigm, section.paradigm);
  const exported = exportComponentArtifacts([section, plain, legacy]);
  assert.equal(exported.catalog.length, 3); assert.equal(exported.rules.length, 1); assert.equal(exported.enabled, false);
  for (const entry of exported.catalog) assert.ok(exported.files[entry.path], "程序索引必须能定位实际范式文件");
  assert.match(exported.mapping, /等待任务完成/); assert.doesNotMatch(exported.mapping, /paradigm-pool-old/);
  const sources = Object.fromEntries(Object.entries(exported.files).filter(([path]) => path.startsWith("components/")));
  const derived = deriveComponentArtifacts(sources); assert.deepEqual(derived.rules, exported.rules); assert.equal(derived.digest, exported.digest);
  assert.deepEqual(deriveComponentArtifacts(Object.fromEntries(Object.entries(sources).reverse())), derived, "输入文件枚举顺序不能改变派生结果");
  const path = Object.keys(sources).find(p => p.endsWith(".metadata.json"))!;
  const metadata = JSON.parse(sources[path]); metadata.need = "按队列执行任务";
  const changed = { ...sources, [path]: JSON.stringify(metadata) };
  assert.match(deriveComponentArtifacts(changed).mapping, /按队列执行任务/); assert.notEqual(deriveComponentArtifacts(changed).digest, exported.digest);
  const markdown = sources[path.replace(/\.metadata\.json$/, ".md")];
  assert.doesNotMatch(markdown, /everycode-|repository_id|a{40}|^---|## 来源/);
  assert.match(markdown, /Pool::Submit/); assert.match(markdown, /p.Wait/);
  assert.deepEqual(JSON.parse(sources[path]).evidence, section.paradigm!.evidence);
  assert.deepEqual(readComponentArtifact(markdown, sources[path]).paradigm, section.paradigm);
  const missing = { ...sources }; delete missing[path]; assert.throws(() => deriveComponentArtifacts(missing), /frontmatter/);
  const orphan = { ...sources }; delete orphan[path.replace(/\.metadata\.json$/, ".md")]; assert.throws(() => deriveComponentArtifacts(orphan), /缺少对应文档/);
  assert.throws(() => deriveComponentArtifacts({ ...sources, [path]: JSON.stringify({ ...metadata, schema: "unknown" }) }), /格式/);

});
test("程序读取严格拒绝坏字段、类型、版本、路径、重复编号，不静默漏掉文档", () => {
  const source = componentArtifact(paradigmSection());
  for (const text of [source.replace('schema: "mfc.component-paradigm/v1"','schema: "v2"'), source.replace('need: "后台执行任务"\n',''),
    source.replace('need: "后台执行任务"','need: null'), source.replace('need: "后台执行任务"','need: "后台执行任务"\nneed: "重复"'),
    source.replace('api: ["Pool::Submit"]', 'api: "Pool::Submit"'), source.replace('status: "recommended"','status: "published"'),
    source.replace('replaces: {','unknown: true\nreplaces: {')]) assert.throws(() => readComponentArtifact(text));
  assert.throws(() => deriveComponentArtifacts({ "components/pool/wrong.md": source }), /路径/);
  const p = paradigmSection().paradigm!; assert.throws(() => validateComponentParadigm({ ...p, extra: true } as any, ["base"]), /未知/);
  assert.throws(() => validateComponentParadigm({ ...p, replaces: { ...p.replaces, hidden: true } } as any, ["base"]));
  for (const path of ["AGENTS.md", "docs/old.cpp", "../pool.cpp"]) assert.throws(() => validateComponentParadigm({ ...p, evidence: [{ ...p.evidence[0], path }] }, ["base"]));
  assert.throws(() => validateComponentParadigm({ ...p, evidence: [null] } as any, ["base"]));
  assert.throws(() => validateComponentParadigm({ ...p, usage_evidence: [] }, ["base"]), /调用证据/);
});
test("导出包可通过独立命令重新提取，错误输入退出非零且不输出半份派生文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "component-artifacts-"));
  try {
    const file = join(dir, "bundle.json"), out = join(dir, "derived"); writeFileSync(file, JSON.stringify(exportComponentArtifacts([paradigmSection()])));
    const run = () => spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/derive-component-knowledge.ts"), file, out], { encoding: "utf8" });
    const success = run(); assert.equal(success.status, 0, success.stderr); assert.equal(JSON.parse(success.stdout).documents, 1);
    assert.match(readFileSync(join(out, "mapping-table.md"), "utf8"), /后台执行任务/);
    const original = exportComponentArtifacts([paradigmSection()]);
    const rulePath = Object.keys(original.files).find(p => p.includes("/rules/"))!.replace(/^derived\//, "");
    assert.ok(existsSync(join(out, rulePath)));
    const changed = paradigmSection(); changed.paradigm!.status = "legacy";
    writeFileSync(file, JSON.stringify(exportComponentArtifacts([changed]))); assert.equal(run().status, 0);
    assert.equal(existsSync(join(out, rulePath)), false, "转为 legacy 后过期规则必须移除");
    const before = readFileSync(join(out, "catalog.json"), "utf8");
    writeFileSync(file, JSON.stringify({ files: { "components/pool/bad.md": "# bad" } }));
    const failed = run(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /frontmatter/);
    assert.equal(readFileSync(join(out, "catalog.json"), "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
