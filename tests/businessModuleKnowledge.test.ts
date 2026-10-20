import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, normalizeModuleKnowledgeLocation, readBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { resolveModuleKnowledgeLocation, saveModuleKnowledgeLocation, suggestModuleKnowledgeLocation } from "../src/businessModuleKnowledge.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-knowledge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: "module-4a96", name: "交易业务", description: "交易全流程", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  return dir;
}
const location = { repository: "https://git.example/knowledge.git", branch: "main", docs_path: "domains/交易业务" };

test("领域目录保存一次后始终解析同一读写位置，改模块名称及全局默认不改变它", t => {
  const dir = setup(t);
  assert.equal(resolveModuleKnowledgeLocation(dir, "module-4a96"), undefined);
  const first = readBusinessModule(dir, "module-4a96");
  saveModuleKnowledgeLocation(dir, first.id, location, "owner", first.revision);
  const snapshot = resolveModuleKnowledgeLocation(dir, first.id)!;
  updateBusinessModule(dir, first.id, { name: "交易中心" }, "owner");
  saveKnowledgeRepoConfig(dir, "https://git.example/new-default.git", { branch: "master", docs_path: "other" });
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, first.id), location);
  saveModuleKnowledgeLocation(dir, first.id, { ...location, docs_path: "domains/交易中心" }, "owner");
  assert.deepEqual(snapshot, location, "任务持有的目录快照不会被后续设置修改");
  assert.throws(() => saveModuleKnowledgeLocation(dir, first.id, location, "owner", first.revision), /配置已变化/);
});

test("模块目录禁止同仓同分支的覆盖和嵌套，失败不覆盖已存设置", t => {
  const dir = setup(t);
  saveModuleKnowledgeLocation(dir, "module-4a96", location, "owner");
  createBusinessModule(dir, { id: "other", name: "另一模块", description: "另一个模块", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  for (const docs_path of [location.docs_path, "domains", `${location.docs_path}/nested`]) {
    assert.throws(() => saveModuleKnowledgeLocation(dir, "other", { ...location, docs_path }, "owner"), /重叠/);
    assert.equal(resolveModuleKnowledgeLocation(dir, "other"), undefined);
  }
  saveModuleKnowledgeLocation(dir, "other", { ...location, docs_path: "domains/另一模块" }, "owner");
  assert.deepEqual(resolveModuleKnowledgeLocation(dir, "module-4a96"), location);
});

test("目录建议使用模块名称且不会成为隐式正式来源", t => {
  const dir = setup(t);
  saveKnowledgeRepoConfig(dir, location.repository, { branch: "main", docs_path: "docs/knowledge" });
  assert.deepEqual(suggestModuleKnowledgeLocation(dir, "module-4a96"), { ...location, docs_path: "docs/knowledge/交易业务" });
  assert.equal(resolveModuleKnowledgeLocation(dir, "module-4a96"), undefined);
});

test("保存目录拒绝越界、无效分支和地址中的凭据", () => {
  for (const docs_path of ["", "/absolute", "../parent", "docs/../parent", "C:/docs", "docs\\module", "docs/.git/config", "docs//module"]) {
    assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, docs_path }), /相对目录/);
  }
  for (const branch of ["", "-main", "../main", "refs//main", ".hidden", "main.lock", "@"]) {
    assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, branch }), /分支格式/);
  }
  assert.throws(() => normalizeModuleKnowledgeLocation({ ...location, repository: "https://user:password@git.example/knowledge.git" }), /凭据/);
  assert.deepEqual(normalizeModuleKnowledgeLocation({ ...location, docs_path: " domains/交易业务/ " }), location);
});
