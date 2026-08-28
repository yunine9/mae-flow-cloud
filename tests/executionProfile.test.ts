import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTION_PROFILE_PATH,
  buildTaskExecutionProfile,
  executionProfilePrompt,
  materializeExecutionProfile,
  normalizeTaskExecutionInstructions,
  resolveRepositoryExecutionProfile,
} from "../src/executionProfile.ts";

test("任务执行补充会规范化、固定版本并原子投影给内核", () => {
  const profile = buildTaskExecutionProfile(
    "task-12", "  先核对旧数据  \r\n不确定时明确说明  ");
  assert.ok(profile);
  assert.equal(profile.layers[0].instructions,
    "先核对旧数据\n不确定时明确说明");
  assert.match(profile.revision, /^[a-f0-9]{16}$/);

  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-profile-"));
  const path = materializeExecutionProfile(workspace, profile);
  assert.equal(path, join(workspace, EXECUTION_PROFILE_PATH));
  assert.ok(existsSync(path!));
  assert.deepEqual(JSON.parse(readFileSync(path!, "utf-8")), profile);
});

test("执行补充有清晰容量边界，且提示明确低于平台兜底", () => {
  assert.equal(normalizeTaskExecutionInstructions(" \n "), undefined);
  assert.throws(() => normalizeTaskExecutionInstructions("x".repeat(2001)),
    /不能超过 2000/);
  const prompt = executionProfilePrompt(
    buildTaskExecutionProfile("task-1", "优先检查兼容性"));
  assert.match(prompt, /优先检查兼容性/);
  assert.match(prompt, /冲突部分无效/);
  assert.match(prompt, /真实证据/);
});

test("团队默认在前、任务补充在后，形成稳定覆盖顺序", () => {
  const profile = buildTaskExecutionProfile(
    "task-2", "本单先查旧格式", "公共接口变更必须点名影响方");
  assert.deepEqual(profile?.layers.map((layer) => layer.scope),
    ["team", "task"]);
  assert.deepEqual(profile?.layers.map((layer) => layer.title),
    ["团队执行约定", "本任务补充"]);
});

test("代码仓执行约定首次 clone 后插入中间层并固定，不随文件改写漂移", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-repo-"));
  writeFileSync(join(workspace, ".mae-flow-defaults.json"), JSON.stringify({
    执行补充: "修改公共接口前先扫描调用方",
  }));
  const base = buildTaskExecutionProfile(
    "task-3", "本单关注旧客户端", "团队要求明确影响方");
  const resolved = resolveRepositoryExecutionProfile({
    workspace, repositoryId: "https://code.example/orders.git", profile: base,
  });
  assert.deepEqual(resolved.profile?.layers.map((layer) => layer.scope),
    ["team", "repository", "task"]);
  assert.equal(resolved.profile?.layers[1].instructions,
    "修改公共接口前先扫描调用方");

  writeFileSync(join(workspace, ".mae-flow-defaults.json"), JSON.stringify({
    执行补充: "后来改掉的约定",
  }));
  const pinned = resolveRepositoryExecutionProfile({
    workspace, repositoryId: "https://code.example/orders.git",
    profile: resolved.profile,
  });
  assert.equal(pinned.profile?.layers[1].instructions,
    "修改公共接口前先扫描调用方");
});

test("损坏的代码仓约定明确降级，不阻塞其他执行层", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-repo-bad-"));
  writeFileSync(join(workspace, ".mae-flow-defaults.json"), "{ bad");
  const base = buildTaskExecutionProfile("task-4", undefined, "团队约定");
  const resolved = resolveRepositoryExecutionProfile({
    workspace, repositoryId: "repo", profile: base,
  });
  assert.equal(resolved.profile, base);
  assert.match(resolved.warning ?? "", /未采用.*继续使用其余执行方案/);
});
