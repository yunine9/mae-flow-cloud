import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipelineRepairRuntime } from "../src/mrPipelineRepairRuntime.ts";
import type { CloudSession, CloudSessionOptions } from "../src/sessionDriver.ts";
import type { PipelineRepairRecord } from "../src/mrPipelineRepairTypes.ts";

test("独立执行器保留原分支与历史、验证真实命令后由宿主推送，Agent 不持有凭据", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mr-repair-git-")), seed = join(dir, "seed"), bare = join(dir, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(seed); git(seed, "init", "-b", "feature"); git(seed, "config", "user.name", "dev"); git(seed, "config", "user.email", "dev@example.test");
  writeFileSync(join(seed, "main.js"), "throw new Error('failed');\n"); git(seed, "add", "main.js"); git(seed, "commit", "-m", "initial");
  git(dir, "init", "--bare", bare); git(seed, "push", bare, "HEAD:refs/heads/feature");
  const sha = git(seed, "rev-parse", "HEAD"), now = new Date().toISOString();
  const record: PipelineRepairRecord = { id: "repair-test", account: "dev", mr_url: "https://codehub.test/g/r/merge_requests/1", status: "repairing", message: "", round: 1, created_at: now, updated_at: now, logs: [],
    mr: { url: "https://codehub.test/g/r/merge_requests/1", iid: "1", title: "fix", repo: bare, source_branch: "feature", target_branch: "main", sha, state: "opened" } };
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  let stopped = 0, sawPrompt = "", workspace = "";
  const runtime = createPipelineRepairRuntime({ dataDir: dir, platformUrl: "http://adapter", isolation: { image: "fixture", volumes: [] },
    deployment: { provider: "fixture", model: "fixture", modelsJson: {} }, credential: () => ({ username: "dev", email: "dev@example.test", password: "secret-fixture" }),
    createContainer: (_image, work, _name, _log, _volumes, _limits, options) => {
      workspace = work;
      assert.equal(JSON.stringify(options).includes("secret-fixture"), false);
      return { start: async () => {}, exec: async () => ({ exitCode: 0 }), stop: async () => { stopped++; } };
    },
    createSession: (async (options: CloudSessionOptions) => {
      let report = "";
      return { start: async (prompt: string) => {
        sawPrompt = prompt;
        assert.deepEqual(options.allowedTools, ["bash"]); assert.equal(prompt.includes("secret-fixture"), false);
        assert.ok(!options.agentDir.startsWith(workspace + "/"));
        assert.match(git(options.workspace, "config", "--get", "remote.origin.pushurl"), /dev\/null/);
        writeFileSync(join(options.workspace, "main.js"), "console.log('passed');\n");
        const commands = ["node --check main.js", "node main.js"];
        let id = 0;
        for (const command of commands) {
          const call = String(++id), event = { taskId: options.taskId, sessionId: "main", ts: now };
          options.eventLog.append({ ...event, eventId: ++id, kind: "tool_requested", payload: { call_id: call, name: "Bash", input: { command } } });
          const [binary, ...args] = command.split(" "); execFileSync(binary, args, { cwd: options.workspace, stdio: "pipe" });
          options.eventLog.append({ ...event, eventId: ++id, kind: "tool_finished", payload: { call_id: call, name: "Bash", input: { command }, is_error: false, result: "passed" } });
        }
        git(options.workspace, "add", "main.js"); git(options.workspace, "commit", "-m", "fix compile");
        report = `<prepush-result>${JSON.stringify({ status: "passed", summary: "fixed and checked", compile: { command: commands[0], status: "passed" }, unit_test: { command: commands[1], status: "passed" } })}</prepush-result>`;
        return { status: "turn_finished" };
      }, finalReply: () => report, abort: async () => {}, dispose: () => {} } as unknown as CloudSession;
    }) as typeof CloudSession.create,
  });
  let handle: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    handle = await runtime.open(record, join(dir, "record"), new AbortController().signal, () => {});
    const result = await handle.repair({ sha, status: "failed", log: "main.js:1 failed" }, 1);
    assert.notEqual(result.sha, sha); assert.match(sawPrompt, /首次先准备依赖并执行仓库标准的完整构建入口/);
    assert.equal(git(bare, "rev-parse", "refs/heads/feature"), sha, "Agent completion does not push");
    assert.equal(await handle.push(), result.sha); assert.equal(git(bare, "rev-parse", "refs/heads/feature"), result.sha);
    assert.equal(git(bare, "rev-parse", `${result.sha}^`), sha); assert.equal(git(bare, "show", "feature:main.js"), "console.log('passed');");
    assert.equal(readFileSync(join(workspace, "repo", "main.js"), "utf8"), "console.log('passed');\n");
  } finally { await handle?.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.equal(stopped, 1);
});
