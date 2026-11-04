import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { KernelHost } from "../src/kernelHost.ts";
import { ensureKernelHostCapability } from "../src/kernelDelivery.ts";
import { TaskService } from "../src/taskService.ts";
import { captureOriginalMr, originalMr } from "../src/taskFinalMr.ts";

async function until(check: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) assert.fail(label);
    await delay(15);
  }
}

for (const deletedSource of [false, true])
  test(
    deletedSource
      ? "最终 MR 删除源分支：缺少提交版本时继续查询，随后用真实合入提交签名结束任务"
      : "换分支交付：旧 MR 的迟到合入无效，重启后只读监听最终 MR，并以实际版本和时间完成",
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "mfc-linked-final-")),
        workspace = join(root, "task-1"),
        cwd = join(workspace, "repo");
      mkdirSync(cwd, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.name", "test");
      git("config", "user.email", "test@example.test");
      function commit(contents: string) {
        writeFileSync(join(cwd, "a.ts"), contents);
        git("add", "a.ts");
        git("commit", "-qm", contents);
        return git("rev-parse", "HEAD");
      }
      const stale = commit("old baseline");
      git("update-ref", "refs/remotes/origin/main", stale);
      const base = commit("current baseline");
      git("switch", "-qc", "cloud");
      const initial = commit("first version");
      git("switch", "-qc", "rewritten", base);
      const final = commit("different implementation");
      git("switch", "-q", "main");
      git("merge", "--no-ff", "-qm", "merge final delivery", "rewritten");
      const mergeCommit = git("rev-parse", "HEAD");
      git("switch", "-q", "cloud");
      let mergeCommitAvailable = false,
        sourceRestored = false;
      const methods: string[] = [],
        mergedAt = "2026-09-09T07:15:01.000Z";
      let state = "opened",
        finishOld!: () => void,
        finalReads = 0;
      const releaseOld = new Promise<void>((resolve) => (finishOld = resolve));
      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, origin);
        methods.push(req.method! + " " + url.pathname);
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/mr/detail") {
          const mr = url.searchParams.get("mr_url")!,
            iid = mr.split("/").pop()!;
          if (iid === "2") finalReads++;
          res.end(
            JSON.stringify({
              url: mr,
              iid,
              repo: iid === "4" ? origin + "/wrong.git" : repo,
              state: iid === "3" ? "closed" : state,
              sha: iid === "1" ? initial : deletedSource && !sourceRestored && state === "merged" ? undefined : final,
              base_sha: base,
              source_branch: "rewritten",
              target_branch: "main",
              version:
                url.searchParams.get("version_head") === initial && iid === "1" ? { head: initial, base } : undefined,
              merge_commit_sha: mergeCommitAvailable ? mergeCommit : undefined,
              merged_at: state === "merged" ? mergedAt : undefined,
            }),
          );
        } else if (url.pathname === "/mr/gates") {
          await releaseOld;
          res.end(JSON.stringify({ mr_state: "merged", source_sha: initial, gates: [] }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`,
        repo = origin + "/repo.git",
        mr = (id: number) => origin + "/repo/-/merge_requests/" + id;
      // 模拟已出 MR 的旧任务。首次发布记录来自真实仓库，后续推送不能覆盖它。
      const initialMr = captureOriginalMr({ workspace }, mr(1), initial);
      assert.deepEqual(initialMr, { url: mr(1), head: initial });
      const now = new Date().toISOString();
      const summary = {
        id: "task-1",
        title: "外部交付",
        requirement: "实现需求",
        created_at: now,
        updated_at: now,
        status: "await_merge",
        workspace,
        repo_url: repo,
        luban_account: "owner",
        delivery: {
          mr_url: mr(1),
          mr_id: 1,
          source_branch: "cloud",
          target_branch: "main",
          mr_state: "等待合入",
          initial_mr: initialMr,
        },
      };
      writeFileSync(join(workspace, "task.json"), JSON.stringify({ summary, cwd }));
      const kernelRoot = join(process.cwd(), "kernel");
      const make = (signed = false) =>
        new TaskService({
          dataDir: root,
          provider: "test",
          model: "test",
          modelsJson: {},
          maxConcurrent: 0,
          host: signed ? { kernelRoot, continuousReview: true } : undefined,
          delivery: { platformUrl: origin, pollIntervalMs: 25 },
        });
      let service = make();
      t.after(async () => {
        finishOld();
        await service.shutdown();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(root, { recursive: true, force: true });
      });
      service.recover();
      await until(() => methods.includes("GET /mr/gates"), "未开始监听原 MR");
      await until(
        () => service.get("task-1")?.delivery?.initial_mr?.base === base,
        "应采用平台确认的首发基线，不能采用旧 origin/main",
      );
      await assert.rejects(service.linkFinalMr("task-1", mr(4)), /代码仓/);
      let selected = await service.linkFinalMr("task-1", mr(3));
      assert.equal(selected.delivery?.final_mr?.state, "closed");
      assert.equal(selected.status, "await_merge");
      selected = await service.linkFinalMr("task-1", mr(2));
      finishOld();
      await until(() => finalReads > 1, "未切换到最终 MR 的监听");
      assert.equal(service.get("task-1")?.status, "await_merge");
      assert.equal(selected.delivery?.mr_url, mr(1));
      assert.deepEqual(selected.delivery?.initial_mr, { ...initialMr, base });
      assert.throws(() => service.retry("task-1"), /最终 MR/);
      await service.shutdown();
      const authority = ensureKernelHostCapability({ workspace, taskId: "task-1", cwd });
      writeFileSync(
        join(cwd, ".mae-flow-order.json"),
        JSON.stringify({
          execution_contract: {
            schema: "mae-flow-execution/1",
            host: "cloud",
            compile: "pipeline",
            ut_write: "agent",
            ut_run: "pipeline",
            codecheck: "pipeline",
            git_push: "host",
            continuous_review: true,
            host_authority: authority,
          },
          单号: "REQ-1",
          基线分支: "main",
          工号: "owner",
        }),
      );
      const kernel = new KernelHost({
        kernelRoot,
        workspace: cwd,
        taskId: "task-1",
        transcriptPath: join(workspace, "transcript.jsonl"),
      });
      await kernel.bootstrapManaged("从最终 MR 交付需求");
      service = make(true);
      const recovered = service.recover();
      assert.equal(recovered.requeued, 0);
      state = "merged";
      if (deletedSource) {
        await until(() => !!service.get("task-1")?.delivery?.stalled?.includes("合入提交"), "缺少合入版本应显式等待");
        mergeCommitAvailable = true;
      }
      await until(() => service.get("task-1")?.status === "completed", "重启后未根据最终 MR 合入结束任务");
      const completed = service.get("task-1")!;
      assert.equal(completed.completed_at, mergedAt);
      assert.equal(completed.delivery?.final_mr?.head, deletedSource ? undefined : final);
      assert.equal(completed.delivery?.merged_sha, deletedSource ? mergeCommit : final);
      const kernelState = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
      assert.equal(kernelState.current, "end");
      assert.equal(kernelState.delivery_loop.close_events.at(-1).sha, deletedSource ? mergeCommit : final);
      if (deletedSource) {
        sourceRestored = true;
        service.deliveryAnalysis(true);
        await until(
          () => service.deliveryAnalysis().rows[0]?.mr_comparison?.method === "patch",
          "刷新后应从同一合入提交补回源版本并生成差异",
        );
        const refreshed = service.get("task-1")!;
        assert.equal(refreshed.delivery?.final_mr?.head, final);
        assert.equal(refreshed.completed_at, mergedAt);
        assert.equal(refreshed.delivery?.merged_sha, mergeCommit);
      }
      assert.equal(git("rev-parse", "HEAD"), initial);
      assert.ok(
        methods.every((m) => m.startsWith("GET ")),
        "外部 MR 接管后平台只能读",
      );
      assert.equal(
        JSON.parse(readFileSync(join(workspace, "task.json"), "utf8")).summary.delivery.initial_mr.head,
        initial,
      );
    },
  );

test("旧任务在没有初版证据时保留原 MR 链接，不把最近推送当初版", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-no-first-mr-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const url = "https://code.example/repo/-/merge_requests/1";
  const first = originalMr({
    workspace,
    delivery: { mr_url: url, git_push: { ref: "refs/heads/later", remote: "origin", sha: "f".repeat(40) } },
  });
  assert.equal(first.url, url);
  assert.equal(first.head, undefined);
});
