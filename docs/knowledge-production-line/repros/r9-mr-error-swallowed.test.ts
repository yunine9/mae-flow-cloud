// 复现：MR 平台的确定性错误（401 令牌过期 / 400 配置缺失）被吞成"尚未确认，重试复用同一分支"，人只能无效重试；
// MR 状态查询鉴权失败被说成"暂时无法确认，请稍后重试"。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeMrPublisher } from "../../../src/knowledgeMrPublisher.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../../../src/domainKnowledgeTypes.ts";

test("MR 创建 400/401 的平台原因不出现在错误里，三次重试都给同一句'尚未确认'", async () => {
  const root = mkdtempSync(join(tmpdir(), "r9-")), remote = join(root, "remote.git"), source = join(root, "source");
  mkdirSync(source); const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "F"); git(source, "config", "user.email", "f@example.test");
  writeFileSync(join(source, "code.ts"), "x\n"); git(source, "add", "."); git(source, "commit", "-m", "fixture");
  execFileSync("git", ["clone", "--bare", source, remote], { stdio: "ignore" });
  const base = git(source, "rev-parse", "HEAD");
  let gatesStatus = 200;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/mr/discover") response.end(JSON.stringify({ mrs: [] }));
    else if (url.pathname === "/mr/gates") { response.writeHead(gatesStatus); response.end(JSON.stringify({ error: "token expired" })); }
    else if (url.pathname === "/mr") { for await (const _ of request) { /* drain */ } response.writeHead(400); response.end(JSON.stringify({ error: "知识归档命令未配置单号关联，请在 mr_create_knowledge 中配置 {dts_no}" })); }
    else { response.writeHead(404); response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${port}`, credential: () => ({ username: "F", password: "p", email: "f@example.test" }), onIndexed: () => {} });
  const target = { id: "domain", name: "领域仓", repository: remote, branch: "main", path: "", docs_path: "docs/domain" };
  const doc = { id: "states", title: "状态", target_id: "domain", path: "docs/domain/states.md", layer: "domain" as const, content: "# 状态", sources: "s", revision: 1, selected: true, base_content: null, base_revision: base, history: [] };
  const job: DomainKnowledgeJob = { id: "dkx-r9", issue_no: "REQ-1", issue_description: "知识", title: "订单", scope: "s", operator: "e", created_at: new Date().toISOString(), repositories: [], knowledge_target: target, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "", revisions: {}, documents: [doc], turns: [], evidence: [], publications: [] };
  let saved: DomainPublication | undefined; const save = (v: DomainPublication) => { saved = structuredClone(v); };
  try {
    const messages: string[] = [];
    for (let i = 0; i < 3; i++) { try { await publisher.publish(job, target, saved, "e", save); } catch (e) { messages.push((e as Error).message); } }
    console.log("[r9] 三次发布错误:", messages);
    assert.ok(messages.every(m => m === "文档已推送，MR 创建尚未确认；重试将复用同一分支"));
    assert.ok(!messages.some(m => m.includes("单号关联")), "平台给出的确定性原因被吞掉");
    // MR 状态查询 401
    gatesStatus = 401;
    const opened: DomainPublication = { ...saved!, url: "https://x/repo/merge_requests/1", mr_id: 1, state: "opened" };
    let refreshError = ""; try { await publisher.publish(job, target, opened, "e", save); } catch (e) { refreshError = (e as Error).message; }
    console.log("[r9] gates 401 时:", refreshError);
    assert.match(refreshError, /暂时无法确认 MR 状态，请稍后重试/);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});
