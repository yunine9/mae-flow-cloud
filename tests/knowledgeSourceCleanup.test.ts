import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeSourceCleanup, type SourceCleanupTask } from "../src/knowledgeSourceCleanup.ts";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(root: string) {
  const source = join(root, "source"), remote = join(root, "remote.git"); mkdirSync(source);
  git(source, "init", "-b", "master"); git(source, "config", "user.name", "fixture"); git(source, "config", "user.email", "fixture@example.test");
  mkdirSync(join(source, "docs/old"), { recursive: true });
  writeFileSync(join(source, "docs/old/rules.md"), "POISON_OLD_KNOWLEDGE"); writeFileSync(join(source, "docs/old/image.png"), "obsolete-image");
  writeFileSync(join(source, "AGENTS.md"), "POISON_OLD_RULES"); writeFileSync(join(source, "code.ts"), "export const truth = 'current';");
  git(source, "add", "."); git(source, "commit", "-m", "fixture"); git(root, "clone", "--bare", source, remote);
  return { source, remote };
}
test("领域清理只提交删除 MR，响应丢失复用分支，创建后不查询合入状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-source-cleanup-")), { source, remote } = repository(root);
  const mrs: Array<{ id: number; url: string; source_branch: string; target_branch: string; state: string }> = [];
  let loseResponse = true, gateQueries = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture"); response.setHeader("content-type", "application/json");
    if (url.pathname === "/mr/gates") { gateQueries++; response.end(JSON.stringify({ mr_state: mrs.find(m => String(m.id) === url.searchParams.get("mr"))?.state, gates: [] })); }
    else if (url.pathname === "/mr/discover") response.end(JSON.stringify({ mrs: mrs.filter(m => m.source_branch === url.searchParams.get("source_branch")) }));
    else if (url.pathname === "/mr") {
      let text = ""; for await (const part of request) text += part;
      const body = JSON.parse(text); assert.equal(body.dts_no, "REQ-cleanup"); assert.match(body.title, /知识清理/);
      const mr = { id: mrs.length + 1, url: `https://example.test/mr/${mrs.length + 1}`, source_branch: body.source_branch, target_branch: body.target_branch, state: "opened" }; mrs.push(mr);
      if (loseResponse) { loseResponse = false; response.statusCode = 502; response.end("{}"); } else response.end(JSON.stringify(mr));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`, credential: () => ({ username: "Fixture", password: "fixture-password", email: "fixture@example.test" }), onIndexed: () => {} });
  const prepare = new KnowledgeSourceCleanup(publisher);
  const repo = { id: "repo-1", name: "交易仓", repository: remote, branch: "master", path: "", docs_path: "docs/old" };
  const task: SourceCleanupTask = { id: "dkx-preparation", issue_no: "REQ-cleanup", operator: "dev", created_at: new Date().toISOString(), source_cleanup: prepare.create([repo]) };
  let writes = 0; const save = () => { writes++; };
  try {
    task.source_cleanup!.publications.push({ target_id: repo.id, branch: "codex/knowledge-old-cleanup", state: "failed", revision: "abcdef123456", documents: [] });
    const paths_by_target = { [repo.id]: ["docs/old", "AGENTS.md"] };
    await prepare.action(task, "publish", { paths_by_target }, "dev", save); assert.equal(task.source_cleanup!.publications[0].state, "failed");
    assert.equal(task.source_cleanup!.plans[0].target_entries.length, 3);
    await prepare.action(task, "publish", { paths_by_target }, "dev", save); assert.equal(mrs.length, 1, "lost response recovers the same MR");
    const publication = task.source_cleanup!.publications[0]; assert.equal(publication.state, "opened");
    assert.equal(publication.branch, "master_Fixture_REQ-cleanup", "清理分支采用基线分支_Git工号_单号，工号不使用登录名");
    assert.equal(git(remote, "ls-tree", "-r", "--name-only", publication.branch), "code.ts", "MR contains only deletions, never draft additions");
    assert.match(git(remote, "show", "master:docs/old/rules.md"), /POISON/);
    assert.equal(git(remote, "log", "-1", "--format=%s", publication.branch).trim(), "[REQ_cleanup][feat]清理萃取前旧知识");
    const queriesBefore = gateQueries;
    await prepare.action(task, "publish", { paths_by_target }, "dev", save);
    assert.equal(gateQueries, queriesBefore, "created MR is retained without state checks");
    assert.equal(mrs.length, 1);
    task.source_cleanup!.started = true; await assert.rejects(prepare.action(task, "preview", { target_id: repo.id, paths: ["code.ts"] }, "dev", save), /已经开始/);
    assert.ok(writes > 4);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("新领域任务直接执行 Skill；旧任务清理记录和手动开始仍可接续", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-preparation-"));
  let executes = 0;
  const unused = async () => { throw new Error("手动开始不应调用 MR API"); };
  const sourceCleanup = new KnowledgeSourceCleanup({ previewCleanup: unused, publish: unused });
  const execute = async (input: import("../src/domainKnowledgeExtraction.ts").DomainExecution) => {
    executes++;
    input.save({ id: "guide", title: "规则", target_id: "domain", layer: "domain", path: "domains/rules.md", content: "# 规则", sources: "业务资料" });
    return "done";
  };
  const manager = new DomainKnowledgeExtraction(root, execute, { sourceCleanup });
  const config = { issue_no: "REQ-prepare", title: "订单", scope: "订单规则", repositories: [1, 2].map(id => ({ repository: `https://example.test/repo${id}.git`, branch: "master" })) };
  try {
    const job = manager.create(config, "dev"); assert.equal(job.source_cleanup, undefined);
    for (let i = 0; i < 100 && manager.get(job.id).status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(manager.get(job.id).status, "done"); assert.equal(executes, 1);
    await manager.shutdown();
    // Simulate a pre-upgrade record, including a cleanup MR that is still open.
    const file = join(root, "domain-extraction", job.id, "job.json");
    const stored = manager.get(job.id);
    stored.status = "idle"; stored.turns = []; stored.documents = [];
    stored.source_cleanup = sourceCleanup.create(stored.repositories);
    stored.source_cleanup.publications = [{ target_id: "repo-1", branch: "codex/cleanup", state: "opened", url: "https://example.test/mr/1", documents: [] }];
    writeFileSync(file, JSON.stringify(stored));
    const restart = new DomainKnowledgeExtraction(root, execute, { sourceCleanup });
    assert.equal(restart.get(job.id).status, "idle");
    const started = await restart.sourceCleanupAction(job.id, "start", {}, "dev"); assert.ok(started.source_cleanup?.started);
    for (let i = 0; i < 100 && ["queued", "running"].includes(restart.get(job.id).status); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(executes, 2);
    assert.equal(restart.get(job.id).source_cleanup?.publications[0].url, "https://example.test/mr/1");
    await restart.shutdown();
  } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
