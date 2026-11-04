import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskServer } from "../src/server.ts";
import type { MrComparisonDetail, DeliveryAnalysisReport } from "../src/deliveryAnalyticsTypes.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

test("在任务 API 关联已合入的另一分支，历史初版补取基线，分析 API 展示实际最终代码", async t => {
  const priorNoProxy = process.env.no_proxy;
  process.env.no_proxy = [priorNoProxy, "127.0.0.1"].filter(Boolean).join(",");
  t.after(() => { if (priorNoProxy === undefined) delete process.env.no_proxy; else process.env.no_proxy = priorNoProxy; });
  const root = mkdtempSync(join(tmpdir(), "mfc-final-e2e-")), dataDir = join(root, "tasks");
  const workspace = join(dataDir, "task-1"), local = join(workspace, "repo"), upstream = join(root, "upstream");
  mkdirSync(upstream); mkdirSync(workspace, { recursive: true });
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.name", "developer"); git(upstream, "config", "user.email", "dev@example.test");
  const commit = (file: string, code: string, message: string) => {
    writeFileSync(join(upstream, file), code + "\n"); git(upstream, "add", file);
    git(upstream, "commit", "-m", message); return git(upstream, "rev-parse", "HEAD");
  };
  const firstBase = commit("service.ts", "export const retries = 0;", "baseline");
  git(upstream, "switch", "-c", "initial");
  const initial = commit("service.ts", "export const retries = 1;", "first draft");
  git(root, "clone", "--no-local", upstream, local);
  git(upstream, "switch", "main");
  const finalBase = commit("unrelated.ts", "export const mainOnly = 1;", "separate requirement");
  git(upstream, "switch", "-c", "local-tuning");
  const final = commit("service.ts", "export const retries = 3;", "final implementation on different history");
  git(upstream, "update-server-info");
  const versionReads: string[] = [], requests: string[] = [], logs: string[] = [];
  let origin = "";
  const platform = createServer((req, res) => {
    const url = new URL(req.url!, origin);
    requests.push(url.pathname);
    if (url.pathname === "/mr/detail") {
      const mr = url.searchParams.get("mr_url")!, iid = mr.split("/").at(-1)!;
      const version = url.searchParams.get("version_head");
      if (version) versionReads.push(version);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({url:mr, iid, repo:origin + "/team/repo.git", source_branch:iid === "1" ? "initial" : "local-tuning",
        target_branch:"main", state:iid === "1" ? "closed" : "merged", sha:iid === "1" ? firstBase : final,
        base_sha:iid === "2" ? finalBase : undefined, merged_at:"2026-10-30T09:00:00Z",
        version: iid === "1" && version === initial ? {head:initial, base:firstBase} : undefined}));
      return;
    }
    if (url.pathname === "/mr/gates") { res.end(JSON.stringify({mr_state:"opened",source_sha:initial,gates:[]})); return; }
    // 通过本地只读 HTTP 提供真正的 Git 对象；最终代码最初不在任务工作区。
    const name = url.pathname.replace(/^\/team\/repo\.git\//, "");
    if (/^(?:HEAD|info\/refs|objects\/(?:info\/packs|[a-f0-9]{2}\/[a-f0-9]{38}|pack\/pack-[a-f0-9]{40}\.(?:pack|idx)))$/.test(name)) {
      const path = join(upstream, ".git", name);
      if (existsSync(path) && statSync(path).isFile()) { res.end(readFileSync(path)); return; }
    }
    res.writeHead(404); res.end();
  });
  origin = await listen(platform);
  const mr = (i: number) => origin + "/team/repo/-/merge_requests/" + i;
  const initialDocs = join(workspace, "delivery-experience");
  mkdirSync(initialDocs); writeFileSync(join(initialDocs, "first.json"), JSON.stringify({mr:mr(1),head:initial}));
  writeFileSync(join(workspace, "task.json"), JSON.stringify({cwd:local, summary:{
    id:"task-1", title:"重试次数", requirement:"修改重试次数", created_at:"2026-10-29T00:00:00Z", updated_at:"2026-10-29T08:00:00Z",
    status:"await_merge", workspace, repo_url:origin + "/team/repo.git", delivery:{mr_url:mr(1),mr_id:1,source_branch:"initial",target_branch:"main"},
  }}));
  const service = new TaskService({dataDir,log:message => logs.push(message),provider:"test",model:"test",modelsJson:{},maxConcurrent:0,delivery:{platformUrl:origin,pollIntervalMs:100}});
  const api = createTaskServer(service);
  const baseUrl = await listen(api);
  t.after(async () => {
    api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
    await service.shutdown();
    platform.closeAllConnections(); await new Promise<void>(r => platform.close(() => r()));
    rmSync(root, {recursive:true,force:true});
  });
  service.recover();
  const taskApi = baseUrl + "/tasks/task-1";
  const link = await fetch(taskApi + "/final-mr", {method:"POST",body:JSON.stringify({url:mr(2)})});
  const result = await link.json() as TaskSummary;
  assert.equal(link.status, 200, JSON.stringify(result)); assert.equal(result.status, "completed");
  assert.equal(result.completed_at, "2026-10-30T09:00:00.000Z"); assert.equal(result.delivery?.initial_mr?.head, initial);
  let comparison: MrComparisonDetail | undefined;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await fetch(taskApi + "/final-mr-comparison?generation=initial");
    if (r.ok) { comparison = await r.json() as MrComparisonDetail; break; }
    await delay(50);
  }
  const report = await (await fetch(baseUrl + "/delivery-analytics")).json() as DeliveryAnalysisReport;
  const row = report.rows.find((r: {id:string}) => r.id === "task-1");
  assert.ok(row); assert.ok(comparison, JSON.stringify({row,requests,logs})); assert.deepEqual(versionReads, [initial]);
  assert.equal(row.merged, true); assert.equal(row.mr_url, mr(2)); assert.equal(row.initial_mr_url, mr(1));
  assert.equal(row.metric, undefined, "重写历史后不沿用原 MR 的行归因");
  assert.equal(row.final_code_lines, 1, "最终 MR 修改一行服务代码，目标分支的其他文件不计");
  assert.equal(row.final_deleted_lines, 1);
  assert.deepEqual(comparison.files.map((f:{path:string}) => f.path), ["service.ts"]);
  assert.match(comparison.files[0]!.change_patch, /retries = 3/);
  assert.match(comparison.files[0]!.change_patch, /retries = 1/);
  assert.equal(git(local, "rev-parse", "HEAD"), initial);
});
