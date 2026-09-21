import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { openKernelFeedback } from "../src/kernelDelivery.ts";
import { queueTaskHostOperation, finishTaskHostOperation, TaskHostLedger } from "../src/taskHostTools.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import { deliveryChangeSnapshot } from "../src/artifacts.ts";

const kernelRoot = join(process.cwd(), "kernel");
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "push-baseline-"));
  const service: any = new TaskService({ dataDir: join(root, "data"), provider: "test",
    model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("推送前同步基准分支");
  t.after(() => service.shutdown());
  const remote = join(root, "remote.git"), cwd = join(summary.workspace, "repo");
  git(root, "init", "--bare", "-q", remote);
  git(root, "init", "-q", "-b", "main", cwd);
  writeFileSync(join(cwd, "main.ts"), "export const value = 0;\n");
  git(cwd, "add", "main.ts"); git(cwd, "commit", "-qm", "base");
  git(cwd, "push", "-q", remote, "main");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-qb", "feature");
  const task = service.tasks.get(summary.id);
  task.cwd = cwd; task.summary.repo_url = remote; task.summary.baseline = "main";
  task.summary.status = "running"; task.summary.waiting = undefined;
  task.summary.delivery = { source_branch: "feature", target_branch: "main", sha: base };
  task.mission = "继续处理检视意见并保留逐条回复";
  service.removeFromQueue(task.summary.id);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ current: "delivery_watch", revision: 3,
    execution_contract: { schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline",
      ut_write: "agent", ut_run: "pipeline", codecheck: "pipeline", git_push: "host", continuous_review: true, source: "order" },
    choices: { workflow: "完整开发" }, config: { "分支名": "feature", "基线分支": "main" },
    step_heads: { branch_create: base, delivery_watch: base },
    quality: { external_verification: { verdict: "PASS", sha: base } }, history: [], initial_dirty: [],
  }));
  sealPipelineLifecycle({ cwd, workspace: summary.workspace, taskId: summary.id, kernelRoot });
  service.options.host = { kernelRoot, python: "python3", continuousReview: true };
  const peer = join(root, "peer");
  git(root, "clone", "-q", "-b", "main", remote, peer);
  const upstream = (file: string, text: string) => {
    writeFileSync(join(peer, file), text); git(peer, "add", file);
    git(peer, "commit", "-qm", "upstream"); git(peer, "push", "-q", "origin", "main");
    return git(peer, "rev-parse", "HEAD");
  };
  const push = async (id: string) => {
    task.summary.status = "running";
    const host = service.taskHostRuntime(task);
    host.allowPush = async () => true; host.confirmPush = async () => true;
    await queueTaskHostOperation(host, id, { action: "push", reason: "推送当前修改" });
    await finishTaskHostOperation(host);
    return new TaskHostLedger(task.summary).read().operations.find(op => op.id === id)!;
  };
  return { root, cwd, remote, peer, service, task, base, upstream, push };
}

test("首次及再次 push 都包含最新基准分支；新 SHA 可登记到真实内核", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "feature");
  for (const round of [1, 2]) {
    const target = f.upstream(`upstream${round}.ts`, `export const round = ${round};\n`);
    const op = await f.push(`push-${round}`);
    assert.equal(op.state, "succeeded", op.result);
    const remoteHead = git(f.remote, "rev-parse", "feature");
    assert.equal(remoteHead, op.sha);
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, remoteHead), "");
    const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
    assert.equal(state.delivery_loop.published.sha, remoteHead);
  }
});

test("真实冲突先返回原检视会话；内核允许解决、提交和重新推送，不要求旧 SHA 许可", async t => {
  const f = fixture(t);
  openKernelFeedback({ host: { kernelRoot }, cwd: f.cwd, workspace: f.task.summary.workspace,
    batch: { schema: "mae-flow-feedback-batch/1", batch_id: "review", task_id: f.task.summary.id,
      base_sha: f.base, opened_at: new Date().toISOString(), items: [{ id: "review-1", source: "mr_discussion",
        source_id: "r1", source_revision: 0, kind: "code_review", summary: "修改返回值", verification: "reviewer" }] } });
  writeFileSync(join(f.cwd, "main.ts"), "export const value = 1;\n");
  git(f.cwd, "add", "main.ts"); git(f.cwd, "commit", "-qm", "review fix");
  const target = f.upstream("main.ts", "export const value = 2;\n");
  const failed = await f.push("conflicted-push");
  assert.equal(failed.state, "failed");
  assert.match(failed.result!, /真实合并冲突/);
  assert.equal(git(f.remote, "branch", "--list", "feature"), "");
  assert.match(f.task.mission, /继续处理检视意见/);
  assert.match(readFileSync(join(f.cwd, "main.ts"), "utf8"), /<<<<<<</);
  assert.ok(existsSync(join(f.cwd, ".git", "MERGE_HEAD")));
  const kernel = new KernelHost({ kernelRoot, workspace: f.cwd, taskId: f.task.summary.id,
    transcriptPath: join(f.task.summary.workspace, "transcript.jsonl") });
  for (const [name, input] of [["task_control", { action: "sync_branch", reason: "解决冲突" }],
    ["Edit", { file_path: join(f.cwd, "main.ts"), old_string: "", new_string: "" }],
    ["Bash", { command: "git add main.ts && git commit --no-edit" }]] as const) {
    const result = await kernel.preTool({ eventId: 1, taskId: f.task.summary.id, sessionId: "main", ts: "",
      kind: "tool_requested", payload: { call_id: `resolve-${name}`, name, input } });
    assert.notEqual(result?.action, "deny", JSON.stringify(result));
  }
  writeFileSync(join(f.cwd, "main.ts"), "export const value = 3;\n");
  git(f.cwd, "add", "main.ts"); git(f.cwd, "commit", "--no-edit", "-q");
  const pushed = await f.push("resolved-push");
  assert.equal(pushed.state, "succeeded", pushed.result);
  assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, pushed.sha!), "");
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.delivery_loop.active_batch_id, "review", "同步不能丢弃未完成检视批次");
  assert.equal(state.delivery_loop.published.sha, pushed.sha);
});

test("拉取基准分支失败时不推送，原目标保留供恢复", async t => {
  const f = fixture(t);
  f.task.summary.delivery.target_branch = "missing-target";
  const op = await f.push("missing-target");
  assert.equal(op.state, "failed");
  assert.match(op.result!, /fetch missing-target/);
  assert.equal(git(f.remote, "branch", "--list", "feature"), "");
  assert.match(f.task.mission, /继续处理检视意见/);
});

test("同步上游平台目录后仍可带本地编译产物推送，仅 HEAD 进入原 MR 分支", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "task source");
  const initial = git(f.cwd, "rev-parse", "HEAD");
  mkdirSync(join(f.peer, ".claude"));
  f.upstream(".claude/upstream.md", "upstream instructions\n");
  const target = f.upstream("toolType.dat", "baseline binary");
  await f.service.syncTargetBeforePush(f.task, "main", f.task.controlEpoch);
  writeFileSync(join(f.cwd, "toolType.dat"), "local build output");
  mkdirSync(join(f.cwd, "imap")); writeFileSync(join(f.cwd, "imap/output.o"), "object");
  f.task.summary.delivery_selection = { status: "confirmed", head: initial, baseline: f.base,
    paths: ["feature.ts"], observed_paths: ["feature.ts"], excluded_paths: [], waiting_id: "reviewed", updated_at: "now" };
  const head = git(f.cwd, "rev-parse", "HEAD");
  const op = await f.push("push-with-local-output");
  assert.equal(op.state, "succeeded", op.result);
  assert.equal(git(f.remote, "rev-parse", "feature"), head);
  assert.equal(git(f.remote, "show", "feature:toolType.dat"), "baseline binary");
  assert.equal(git(f.remote, "ls-tree", "--name-only", "feature", "imap"), "");
  assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, head), "");
  assert.equal(readFileSync(join(f.cwd, "toolType.dat"), "utf8"), "local build output");
  assert.deepEqual((await deliveryChangeSnapshot(f.cwd))!.committed_paths, ["feature.ts"]);
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.delivery_loop.published.sha, head, "真实内核接受同步后的发布 SHA");
});
