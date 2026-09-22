import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

test("真实 Git 文档归档复用开放 MR、撤回未选项、合入后入库、新一轮保留其他文件及人工修改", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-publish-")), remote = join(root, "remote.git"), source = join(root, "source");
  mkdirSync(source); const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "code.ts"), "original code\n"); git(source, "add", "."); git(source, "commit", "-m", "fixture");
  execFileSync("git", ["clone", "--bare", source, remote], { stdio: "ignore" });
  const base = git(source, "rev-parse", "HEAD");
  const receivedIssues: string[] = [];
  let count = 0, indexed = 0, loseResponse = false;
  const mrs: Array<{ id: number; url: string; source_branch: string; target_branch: string; state: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/mr/gates") { const mr = mrs.find(m => String(m.id) === url.searchParams.get("mr"))!; response.end(JSON.stringify({ mr_state: mr.state, gates: [] })); }
    else if (url.pathname === "/mr/discover") response.end(JSON.stringify({ mrs: mrs.filter(m => m.source_branch === url.searchParams.get("source_branch")) }));
    else if (url.pathname === "/mr") {
      let text = ""; for await (const part of request) text += part;
      const body = JSON.parse(text), mr = { id: ++count, url: `https://example.test/repo/merge_requests/${count}`, source_branch: body.source_branch, target_branch: body.target_branch, state: "opened" };
      receivedIssues.push(body.dts_no);
      mrs.push(mr);
      if (loseResponse) { loseResponse = false; response.writeHead(502); response.end('{}'); } else response.end(JSON.stringify(mr));
    } else { response.writeHead(404); response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${port}`, credential: () => ({ username: "Fixture", password: "fixture-password", email: "fixture@example.test" }), onIndexed: () => indexed++ });
  const target = { id: "domain", name: "领域仓", repository: remote, branch: "main", path: "", docs_path: "docs/domain" };
  const doc: DomainKnowledgeJob["documents"][number] = { id: "states", title: "订单状态", target_id: "domain", path: "docs/domain/states.md", layer: "domain" as const, content: "# 状态\n已创建", sources: "fixture 来源", revision: 1, selected: true, base_content: null, base_revision: base, history: [] };
  const job: DomainKnowledgeJob = { id: "dkx-fixture", issue_no: "REQ-knowledge-123", title: "订单", scope: "状态", operator: "expert", created_at: new Date().toISOString(), repositories: [], knowledge_target: target, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "待审查", revisions: {}, documents: [doc, { ...doc, id: "cancel", title: "取消", path: "docs/domain/cancel.md" }], turns: [], evidence: [], publications: [] };
  let saved: DomainPublication | undefined;
  const save = (value: DomainPublication) => { saved = structuredClone(value); };
  try {
    await assert.rejects(publisher.publish({ ...job, issue_no: undefined }, target, undefined, "expert", save), /关联单号/);
    assert.equal(git(remote, "branch", "--list", "codex/*"), "", "缺少单号时不得推送分支");
    loseResponse = true;
    await assert.rejects(publisher.publish(job, target, undefined, "expert", save), /尚未确认/);
    assert.equal(saved?.mr_attempted, true); assert.equal(count, 1); assert.deepEqual(receivedIssues, [job.issue_no]);
    const first = await publisher.publish(job, target, saved, "expert", save);
    assert.equal(count, 1, "响应丢失后找回同一 MR"); assert.equal(first.url, mrs[0].url);
    assert.equal(git(remote, "show", `${first.branch}:code.ts`), "original code");
    assert.equal(git(remote, "log", "-1", "--format=%s", first.branch), "[REQ_knowledge_123][feat]更新订单知识");
    job.documents[0].content = "# 状态\n已支付"; job.documents[0].revision = 2; job.documents[1].selected = false;
    // Rejected pushes preserve the confirmed version and can safely retry the same MR.
    const hook = join(remote, "hooks", "pre-receive"); writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o700);
    await assert.rejects(publisher.publish(job, target, first, "expert", save), /Git 操作失败/);
    writeFileSync(hook, "#!/bin/sh\necho \"Deny by project hooks setting 'default': message of commit 'abcdef1234567890' does not match the regular-expression\" >&2\necho 'fixture-password' >&2\nexit 1\n");
    await assert.rejects(publisher.publish(job, target, first, "expert", save), (error: Error) => {
      assert.match(error.message, /CodeHub.*提交说明不符合仓库规范.*abcdef123456/);
      assert.doesNotMatch(error.message, /fixture-password/);
      return true;
    });
    assert.match(saved!.documents[0].content, /已创建/); assert.match(saved!.attempted_documents![0].content, /已支付/);
    rmSync(hook);
    const second = await publisher.publish(job, target, saved, "expert", save);
    assert.equal(second.branch, first.branch); assert.equal(count, 1);
    assert.match(git(remote, "show", `${second.branch}:${doc.path}`), /已支付/);
    assert.throws(() => git(remote, "show", `${second.branch}:docs/domain/cancel.md`), /failed/i);
    assert.equal(listKnowledgeDocuments(root).length, 0, "未合入不进入正式知识库");
    git(remote, "update-ref", "refs/heads/main", second.revision!); mrs[0].state = "merged";
    const merged = await publisher.refresh(job, second, "expert");
    assert.equal(merged.state, "merged"); assert.equal(indexed, 1); assert.match(listKnowledgeDocuments(root)[0].content, /已支付/);
    job.documents[0].content = "# 状态\n已完成"; job.documents[0].revision = 3;
    const third = await publisher.publish(job, target, merged, "expert", save);
    assert.notEqual(third.branch, second.branch); assert.equal(count, 2); assert.deepEqual(receivedIssues, [job.issue_no, job.issue_no]);
    // Another contributor edits the open MR branch; a later publication must not overwrite it.
    git(source, "fetch", remote, third.branch); git(source, "checkout", "-B", "human-edit", "FETCH_HEAD");
    writeFileSync(join(source, doc.path), "人工独立修改\n"); git(source, "add", doc.path); git(source, "commit", "-m", "human"); git(source, "push", remote, `HEAD:refs/heads/${third.branch}`);
    job.documents[0].content = "新的 AI 草稿";
    await assert.rejects(publisher.publish(job, target, third, "expert", save), /他人修改/);
    assert.equal(git(remote, "show", `${third.branch}:${doc.path}`), "人工独立修改");
    const snapshot = await publisher.readRemote(job, job.documents[0], "expert");
    // readRemote locates the task's current MR; supply its saved receipt.
    job.publications = [third];
    const branchSnapshot = await publisher.readRemote(job, job.documents[0], "expert");
    assert.equal(branchSnapshot.reviewed, false); assert.match(branchSnapshot.branch_content!, /人工独立修改/);
    job.documents[0].remote_review = { ...branchSnapshot, reviewed: true };
    job.documents[0].content = "人工独立修改\n补充经核对的规则";
    const repaired = await publisher.publish(job, target, saved, "expert", save);
    assert.equal(repaired.branch, third.branch); assert.equal(count, 2);
    assert.match(git(remote, "show", `${repaired.branch}:${doc.path}`), /人工独立修改/);
    // Target-branch edits also need explicit review, and the MR must include that parent.
    git(source, "checkout", "-B", "main", "main");
    git(source, "fetch", remote, "main"); git(source, "reset", "--hard", "FETCH_HEAD");
    writeFileSync(join(source, doc.path), "目标分支的新规则\n"); git(source, "add", doc.path); git(source, "commit", "-m", "target human"); git(source, "push", remote, "HEAD:refs/heads/main");
    job.publications = [repaired];
    await assert.rejects(publisher.publish(job, target, repaired, "expert", save), /目标分支/);
    job.documents[0].remote_review = { ...(await publisher.readRemote(job, job.documents[0], "expert")), reviewed: true };
    job.documents[0].content += "\n目标分支的新规则";
    const reconciled = await publisher.publish(job, target, saved, "expert", save);
    assert.equal(git(remote, "merge-base", reconciled.branch, "main"), git(remote, "rev-parse", "main"));
    assert.match(git(remote, "show", `${reconciled.branch}:${doc.path}`), /目标分支的新规则/);
    assert.equal(snapshot.target_content?.includes("已支付"), true);
    git(remote, "update-ref", "refs/heads/main", reconciled.revision!); mrs[1].state = "merged";
    job.documents[0].base_content = git(remote, "show", `main:${doc.path}`) + "\n";
    const unchanged = await publisher.publish(job, target, undefined, "expert", save);
    assert.equal(unchanged.state, "unchanged"); assert.equal(unchanged.sync_state, "done"); assert.equal(count, 2, "无变化不创建空 MR");
    assert.match(listKnowledgeDocuments(root)[0].content, /目标分支的新规则/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("组件文档更新与可选清理：同名原文先核对，清理和新规范同一 MR，默认保留且不重复删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-cleanup-")), source = join(root, "source"), remote = join(root, "remote.git");
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, "init", "-b", "main"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
  mkdirSync(join(source, "docs/legacy"), { recursive: true });
  writeFileSync(join(source, "docs/legacy/guide.md"), "旧组件指南\n"); writeFileSync(join(source, "docs/legacy/obsolete.md"), "过时知识\n");
  writeFileSync(join(source, "docs/legacy/keep.md"), "需保留的人工说明\n");
  writeFileSync(join(source, "AGENTS.md"), "旧规范\n"); writeFileSync(join(source, "app.ts"), "不属于知识清理的代码\n");
  git(source, "add", "."); git(source, "commit", "-m", "fixture"); execFileSync("git", ["clone", "--bare", source, remote], { stdio: "ignore" });
  let creates = 0, state = "opened";
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/mr/gates")) return res.end(JSON.stringify({ mr_state: state, gates: [{ name: "pipeline", status: "failed" }] }));
    if (req.url === "/mr") { let body = ""; for await (const c of req) body += c; assert.equal(JSON.parse(body).dts_no, "REQ-cleanup"); creates++; return res.end(JSON.stringify({ id: creates, url: `https://example.test/mr/${creates}` })); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir: root, platformUrl: () => `http://127.0.0.1:${(server.address() as any).port}`, credential: () => ({ username: "Fixture", password: "fixture-password", email: "fixture@example.test" }), onIndexed: () => {} });
  const target = { id: "domain", name: "组件知识仓", repository: remote, branch: "main", path: "", docs_path: "docs/legacy" };
  const job: DomainKnowledgeJob = { id: "dkx-cleanup", component_research_id: "cr-components", technologies: ["cpp"], title: "组件指南", issue_no: "REQ-cleanup", scope: "组件归档", operator: "expert", created_at: "now", repositories: [], knowledge_target: target, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "审查", revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "guide", title: "组件指南", path: "docs/legacy/guide.md", target_id: "domain", layer: "domain", content: "新组件指南\n", sources: "已核对源码", revision: 1, selected: true, base_content: null, base_revision: "", history: [] }] };
  let saved: DomainPublication | undefined;
  const save = (p: DomainPublication) => { saved = structuredClone(p); };
  try {
    await assert.rejects(publisher.publish(job, target, undefined, "expert", save), /已有他人修改/);
    assert.equal(creates, 0, "同名文件不直接覆盖");
    let snapshot = await publisher.readRemote(job, job.documents[0], "expert");
    assert.equal(snapshot.target_content, "旧组件指南\n");
    job.documents[0].remote_review = { ...snapshot, reviewed: true };
    job.documents[0].content = snapshot.target_content!;
    const noChange = await publisher.publish(job, target, undefined, "expert", save);
    assert.equal(noChange.state, "unchanged"); assert.equal(creates, 0, "保留原文不创建空 MR");
    job.documents[0].content = "新组件指南\n";
    const first = await publisher.publish(job, target, undefined, "expert", save); job.publications = [first];
    assert.equal(first.state, "opened"); assert.equal(creates, 1);
    assert.equal(git(remote, "show", `${first.branch}:AGENTS.md`), "旧规范");
    assert.equal(git(remote, "show", `${first.branch}:docs/legacy/obsolete.md`), "过时知识", "默认不清理");
    await assert.rejects(publisher.previewCleanup(job, target, { directories: ["."] }, "expert"), /相对路径/);
    await assert.rejects(publisher.previewCleanup(job, target, { directories: [".git"] }, "expert"), /相对路径/);
    const filePreview = await publisher.previewCleanup(job, target, { paths: ["AGENTS.md"] }, "expert");
    assert.deepEqual(filePreview.target_entries.map(e => e.path), ["AGENTS.md"]);
    assert.equal(filePreview.agent, undefined, "删除规范不要求生成新规范");
    const oldKnowledge = saveKnowledgeDocument(root, { title: "旧知识", content: "过时知识", scope: "platform", source: { repository: remote, branch: "main", path: "docs/legacy/obsolete.md", revision: "old" } }, "expert");
    const plan = await publisher.previewCleanup(job, target, { paths: ["docs/legacy", "AGENTS.md"], agent: { path: "AGENTS.md", content: "# 新规范\n参考 docs/legacy/guide.md\n" } }, "expert");
    assert.equal(plan.confirmed, false); assert.equal(plan.agent!.target_content, "旧规范\n");
    job.cleanup_plans = [plan];
    const unconfirmed = await publisher.publish(job, target, first, "expert", save);
    assert.equal(git(remote, "show", `${unconfirmed.branch}:docs/legacy/obsolete.md`), "过时知识", "未确认预览不执行清理");
    plan.confirmed = true;
    job.documents[0].revision++;
    await assert.rejects(publisher.publish(job, target, unconfirmed, "expert", save), /提交文档已变化/);
    job.documents[0].revision--;
    // A target change after preview must invalidate the plan before any push.
    writeFileSync(join(source, "docs/legacy/obsolete.md"), "人工更新的旧知识\n"); git(source, "add", "."); git(source, "commit", "-m", "human update"); git(source, "push", remote, "main");
    await assert.rejects(publisher.publish(job, target, unconfirmed, "expert", save), /目标分支文件已变化/);
    assert.equal(git(remote, "show", `${first.branch}:docs/legacy/obsolete.md`), "过时知识");
    job.publications = [unconfirmed];
    job.documents[0].content = "新组件指南整合版\n"; job.documents[0].revision++;
    const reviewed = await publisher.previewCleanup(job, target, { directories: ["docs/legacy"], agent: plan.agent }, "expert"); reviewed.confirmed = true; reviewed.preserve_paths = ["docs/legacy/keep.md"]; job.cleanup_plans = [reviewed];
    const cleaned = await publisher.publish(job, target, unconfirmed, "expert", save); job.publications = [cleaned];
    assert.equal(listKnowledgeDocuments(root).find(d => d.id === oldKnowledge.id)!.active, true, "MR 未合入前不影响正式知识");
    assert.equal(cleaned.cleanup_id, reviewed.id); assert.equal(creates, 1, "清理复用开放 MR，不等待失败流水线");
    assert.equal(git(remote, "show", `${cleaned.branch}:docs/legacy/guide.md`), "新组件指南整合版");
    assert.throws(() => git(remote, "show", `${cleaned.branch}:docs/legacy/obsolete.md`));
    assert.equal(git(remote, "show", `${cleaned.branch}:docs/legacy/keep.md`), "需保留的人工说明");
    const changes = git(remote, "diff", `${cleaned.revision}^1`, cleaned.revision!, "--name-status");
    assert.match(changes, /D\s+docs\/legacy\/obsolete.md/); assert.match(changes, /M\s+docs\/legacy\/guide.md/); assert.match(changes, /M\s+AGENTS.md/);
    assert.equal(git(remote, "show", `${cleaned.branch}:AGENTS.md`), "# 新规范\n参考 docs/legacy/guide.md");
    assert.equal(git(remote, "show", `${cleaned.branch}:app.ts`), "不属于知识清理的代码");
    assert.equal(git(remote, "show", "main:AGENTS.md"), "旧规范", "目标分支未被直接更改");
    // Later edits do not repeat the old cleanup against newly added files.
    git(source, "fetch", remote, cleaned.branch); git(source, "checkout", "-B", "manual", "FETCH_HEAD");
    writeFileSync(join(source, "docs/legacy/new-human.md"), "后来加入的知识\n"); git(source, "add", "."); git(source, "commit", "-m", "add knowledge"); git(source, "push", remote, `HEAD:${cleaned.branch}`);
    snapshot = await publisher.readRemote(job, job.documents[0], "expert"); job.documents[0].remote_review = { ...snapshot, reviewed: true };
    job.documents[0].content = "新组件指南第二版\n"; job.documents[0].revision++;
    const updated = await publisher.publish(job, target, cleaned, "expert", save);
    assert.equal(git(remote, "show", `${updated.branch}:docs/legacy/new-human.md`), "后来加入的知识");
    git(remote, "update-ref", "refs/heads/main", updated.revision!); state = "merged";
    const merged = await publisher.refresh(job, updated, "expert"); assert.equal(merged.sync_state, "done");
    assert.equal(listKnowledgeDocuments(root).find(d => d.id === oldKnowledge.id)!.active, false, "合入删除后停用旧知识索引来源");
    const doc = listKnowledgeDocuments(root).find(d => d.source?.path === "docs/legacy/guide.md")!;
    assert.equal(doc.research_source!.job_id, "cr-components"); assert.deepEqual(doc.technologies, ["cpp"]); assert.equal(doc.scope, "platform");
    job.publications = [updated];
    const deleteAgent = await publisher.previewCleanup(job, target, { paths: ["AGENTS.md"] }, "expert"); deleteAgent.confirmed = true; job.cleanup_plans = [deleteAgent];
    const onlyDeleted = await publisher.publish(job, target, updated, "expert", save);
    assert.throws(() => git(remote, "show", `${onlyDeleted.branch}:AGENTS.md`));
    assert.equal(git(remote, "show", `${onlyDeleted.branch}:docs/legacy/guide.md`), "新组件指南第二版");
    assert.equal(git(remote, "show", "main:AGENTS.md"), "# 新规范\n参考 docs/legacy/guide.md", "纯删除也只修改 MR 分支");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
