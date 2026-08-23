import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDeveloperAssistantHandoff,
  captureDeveloperAssistantWorktree,
  finishDeveloperAssistantHandoff,
  handoffCoreStillMatches,
  inspectDeveloperAssistantAvailability,
} from "../src/developerAssistantHandoff.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function fixture(): { root: string; repo: string; kernel: string } {
  const root = mkdtempSync(join(tmpdir(), "mfc-assistant-handoff-"));
  const repo = join(root, "repo");
  const kernel = join(root, "kernel");
  mkdirSync(repo);
  mkdirSync(join(kernel, "flow"), { recursive: true });
  writeFileSync(join(kernel, "flow", "flow.json"), JSON.stringify({
    steps: {
      build: { title: "编码实现", allow_source_edit: true },
      build_review: {
        title: "用户检视代码",
        user_ack: true,
        approval_subject: { kind: "worktree" },
      },
      verify_ut: {
        title: "补充单元测试",
        allow_source_edit: true,
        tests_only: true,
      },
      external_verify: { title: "等待流水线", host_wait: true },
      build_commit: { title: "精确提交" },
    },
  }));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  git(repo, "add", "source.ts");
  git(repo, "commit", "-qm", "fixture");
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 7,
  }));
  return { root, repo, kernel };
}

test("开发助手只在内核明确允许通用源码修改的窗口开放", () => {
  const { repo, kernel } = fixture();
  const inspect = () => inspectDeveloperAssistantAvailability(repo, kernel);

  assert.deepEqual(
    { available: inspect().available, code: inspect().code },
    { available: true, code: "edit_window" },
  );

  for (const [current, code] of [
    ["build_review", "approval_pending"],
    ["verify_ut", "tests_only"],
    ["external_verify", "host_wait"],
    ["build_commit", "not_editable"],
  ] as const) {
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current, revision: 8,
    }));
    const availability = inspect();
    assert.equal(availability.available, false, current);
    assert.equal(availability.code, code, current);
  }
});

test("交还快照识别同一脏文件的内容变化，并跨多轮保留最初起点", () => {
  const { repo, kernel } = fixture();
  writeFileSync(join(repo, "source.ts"), "export const value = 2;\n");
  const availability = inspectDeveloperAssistantAvailability(repo, kernel);
  const initial = captureDeveloperAssistantWorktree(repo);
  const first = beginDeveloperAssistantHandoff(
    undefined, availability, initial, "2026-08-23T00:00:00.000Z");

  writeFileSync(join(repo, "source.ts"), "export const value = 3;\n");
  writeFileSync(join(repo, "new-test.ts"), "export const covered = true;\n");
  const finished = finishDeveloperAssistantHandoff(
    first, captureDeveloperAssistantWorktree(repo), "2026-08-23T00:01:00.000Z");

  assert.equal(finished.state, "changed");
  assert.deepEqual(finished.changed_paths, ["new-test.ts", "source.ts"]);

  const second = beginDeveloperAssistantHandoff(
    finished,
    availability,
    captureDeveloperAssistantWorktree(repo),
    "2026-08-23T00:02:00.000Z",
  );
  assert.equal(second.initial.fingerprint, initial.fingerprint,
    "同一次暂停期间的第二轮助手不能把第一轮修改当成新基线");
});

test("内核 revision 变化时旧助手现场不能直接交还", () => {
  const { repo, kernel } = fixture();
  const before = inspectDeveloperAssistantAvailability(repo, kernel);
  const handoff = beginDeveloperAssistantHandoff(
    undefined, before, captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 8,
  }));
  const after = inspectDeveloperAssistantAvailability(repo, kernel);
  assert.equal(handoffCoreStillMatches(handoff, after), false);
  assert.equal(JSON.parse(readFileSync(join(repo, ".mae-flow.json"), "utf-8")).current,
    "build");
});

test("助手若间接改变 Git HEAD，交还协议 fail-closed", () => {
  const { repo, kernel } = fixture();
  const availability = inspectDeveloperAssistantAvailability(repo, kernel);
  const handoff = beginDeveloperAssistantHandoff(
    undefined, availability, captureDeveloperAssistantWorktree(repo));
  writeFileSync(join(repo, "source.ts"), "export const value = 99;\n");
  git(repo, "add", "source.ts");
  git(repo, "commit", "-qm", "unexpected assistant commit");

  const finished = finishDeveloperAssistantHandoff(
    handoff, captureDeveloperAssistantWorktree(repo));
  assert.equal(finished.state, "blocked");
  assert.match(finished.message, /Git HEAD 发生变化/);
});
