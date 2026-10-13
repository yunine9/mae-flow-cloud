import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { createIssueTools } from "../src/issueFlow/tools.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { saveState, type IssueSessionState } from "../src/issueFlow/state.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes, type IssueViewer } from "../src/issueFlow/routes.ts";
import type { MrParticipants } from "../src/mrParticipants.ts";
import { mfcTemp } from "./mfcTmp.ts";

const REPOS = ["https://codehub.example/team/front.git", "https://codehub.example/team/back.git"];
const PEOPLE: MrParticipants = {
  reviewers: ["reviewer1"], approval_approvers: ["approver1"],
};

interface Request {
  path: string;
  body: Record<string, any>;
  headers: IncomingHttpHeaders;
}

async function platform(handler: (request: Request) => { status?: number; body: unknown }) {
  const seen: Request[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const entry = { path: request.url!, headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") };
      seen.push(entry);
      const reply = handler(entry);
      response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    stop: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function fixture(platformUrl: string, repos = REPOS) {
  const dir = mfcTemp("mfc-issue-mr-participants-");
  createBusinessModule(dir, { id: "module-a", name: "模块 A", description: "模块测试", owner: "owner1",
    repositories: REPOS, mr_participants: PEOPLE }, "owner1");
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-mr", account: "owner1", reporter: "reporter1", module_id: "module-a",
    created_at: now, updated_at: now, title: "问题", description: "", source: "dts",
    ticket: "DTS-2026-1001", repo_url: repos[0], repo_urls: repos, baseline: "master",
    scenario: "ticket", round: 1, stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: repos.map(repo => ({ repo, branch: "master_owner1_DTS-2026-1001", sha: "a".repeat(40), at: now })),
  };
  const watches: string[] = [];
  const tools = createIssueTools({
    state, dataRoot: dir, workspace: dir, platformUrl,
    persist: () => saveState(dir, state), dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "owner1", password: "owner-token", email: "owner@example.com" }),
    pullRepo: async () => ({ dir, cloned: false, head: "a".repeat(40) }),
    onMrCreated: repo => watches.push(repo),
  }) as Array<{ name: string; execute(id: string, params: Record<string, string>): Promise<unknown> }>;
  const tool = tools.find(item => item.name === "create_mr")!;
  return {
    dir, state, watches,
    run: (repo = repos[0]) => tool.execute("test", { repo }),
    saved: () => JSON.parse(readFileSync(join(dir, "issue.json"), "utf-8")) as IssueSessionState,
  };
}

test("问题 MR：模块全部关联仓共用名单，追加的其他仓和无模块会话不带名单", async () => {
  const service = await platform(({ body }) => ({ body: {
    url: `${body.repo}/merge_requests/1`, id: 1,
    ...(body.participants ? { participants: { status: "applied" } } : {}),
  } }));
  try {
    const other = "https://codehub.example/other/module.git";
    const testCase = fixture(service.url, [REPOS[0].replace(/\.git$/, ""), REPOS[1], other]);
    for (const repo of testCase.state.repo_urls!) await testCase.run(repo);
    assert.deepEqual(service.seen.map(entry => entry.body.participants), [PEOPLE, PEOPLE, undefined]);
    assert.deepEqual(testCase.saved().mrs?.map(mr => mr.participants?.status), ["applied", "applied", undefined]);
    assert.equal(service.seen[0].headers["x-mfc-git-user"], "owner1");
    assert.equal(service.seen[0].headers["x-mfc-git-token"], "owner-token");
    testCase.state.module_id = undefined;
    await testCase.run(REPOS[1]);
    assert.equal(service.seen.at(-1)?.body.participants, undefined);
  } finally {
    await service.stop();
  }
});

test("问题 MR：人员失败静默保留链接和内部结果，再次创建正常复用且不自动补设", async () => {
  let calls = 0;
  const service = await platform(() => ({ body: {
      url: "https://codehub.example/team/front/merge_requests/9", id: 9,
      participants: calls++ === 0 ? { status: "failed", message: "无人员配置权限" }
        : { status: "skipped", message: "已有 MR 保留原人员设置" },
  } }));
  try {
    const testCase = fixture(service.url);
    const first = await testCase.run();
    const original = testCase.saved().mrs![0];
    assert.equal(original.url, "https://codehub.example/team/front/merge_requests/9");
    assert.equal(original.participants?.status, "failed");
    assert.equal(original.participants?.message, "无人员配置权限");
    assert.match(JSON.stringify(first), /MR 已创建/);
    assert.doesNotMatch(JSON.stringify(first), /无人员配置权限|人员|补设|重试/);
    assert.equal(testCase.state.transitions!.at(-1)!.note, `MR 已创建: ${original.url}`);
    assert.equal(testCase.state.stage, "mr_green");
    assert.equal(testCase.state.gate, undefined);
    assert.deepEqual(testCase.watches, [REPOS[0]]);

    updateBusinessModule(testCase.dir, "module-a", {
      mr_participants: { reviewers: ["new-person"], approval_approvers: [] },
    }, "owner1");
    const reused = await testCase.run();
    assert.deepEqual(testCase.saved().mrs![0].participants, original.participants, "复用未改人员，保留原失败事实和名单");
    assert.equal(testCase.saved().mrs![0].url, original.url);
    assert.doesNotMatch(JSON.stringify(reused), /无人员配置权限|人员|补设|重试/);
    assert.equal(testCase.state.transitions!.at(-1)!.note, `MR 已创建: ${original.url}`);
    assert.deepEqual(service.seen.map(entry => entry.path), ["/mr", "/mr"]);
    assert.deepEqual(service.seen[1].body.participants, { reviewers: ["new-person"], approval_approvers: [] }, "正常创建携带当前配置，是否复用由适配层判断");
  } finally {
    await service.stop();
  }
});

test("问题 MR：复用相同 MR 时保留已完成的人员设置事实", async () => {
  let calls = 0;
  const service = await platform(() => ({ body: {
    url: "https://codehub.example/team/front/merge_requests/9", id: 9,
    participants: calls++ === 0 ? { status: "applied" }
      : { status: "skipped", message: "已有 MR 保留原人员设置" },
  } }));
  try {
    const testCase = fixture(service.url);
    await testCase.run();
    updateBusinessModule(testCase.dir, "module-a", {
      mr_participants: { reviewers: ["new-person"], approval_approvers: [] },
    }, "owner1");
    await testCase.run();
    assert.deepEqual(testCase.saved().mrs![0].participants, { status: "applied", requested: PEOPLE });
    assert.ok(service.seen.every(entry => entry.path === "/mr"), "已设置成功不调用人员补设接口");
  } finally {
    await service.stop();
  }
});

for (const finished of ["closed_at", "merged_at"] as const) {
  test(`问题 MR：${finished} 的失败记录不再补设人员`, async () => {
    let calls = 0;
    const service = await platform(() => ({ body: {
      url: `https://codehub.example/team/front/merge_requests/${++calls}`, id: calls,
      participants: { status: calls === 1 ? "failed" : "applied" },
    } }));
    try {
      const testCase = fixture(service.url);
      await testCase.run();
      testCase.state.mrs![0][finished] = new Date().toISOString();
      await testCase.run();
      assert.deepEqual(service.seen.map(entry => entry.path), ["/mr", "/mr"]);
      assert.equal(testCase.state.mrs![0].iid, "2");
    } finally {
      await service.stop();
    }
  });
}

function retryRoute(service: IssueFlowService, viewer?: IssueViewer, repo = REPOS[0]) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    request.url = "/issues/issue-mr/mr-participants";
    let status = 0;
    void handleIssueRoutes(request, {
      writeHead: (value: number) => { status = value; },
      end: (body: string) => resolve({ status, body: JSON.parse(body) }),
    } as any, ["issues", "issue-mr", "mr-participants"], {
      issueFlow: service, authEnabled: true, viewer,
    }).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify({ repo })));
    request.emit("end");
  });
}

test("问题 MR 补设接口：仅责任人可操作，失败静默保存，归档后仍可独立补设且不唤醒 Agent", async () => {
  let attempts = 0;
  const remote = await platform(() => ({ body: attempts++ === 0 ? { status: "failed", message: "无人员配置权限" } : { status: "applied" } }));
  const testCase = fixture(remote.url);
  const state = testCase.state;
  state.status = "archived";
  state.conclusion = { kind: "delivered", summary: "修复已交付", at: state.updated_at };
  state.mrs = [{ repo: REPOS[0], branch: state.pushes![0].branch, target: "master", title: "修复",
    url: "https://codehub.example/team/front/merge_requests/9", iid: "9", at: state.updated_at,
    participants: { status: "failed", requested: PEOPLE, message: "权限不足" } }];
  const workspace = join(testCase.dir, "issues", state.id);
  saveState(workspace, state);
  let identity: string | undefined;
  const service = new IssueFlowService({
    dataDir: testCase.dir, provider: "test", model: "test", modelsJson: {}, platformUrl: remote.url,
    gitCredential: account => {
      identity = account;
      return { username: account, password: "owner-token", email: "owner@example.com" };
    },
  });
  try {
    assert.equal((await retryRoute(service)).status, 401);
    for (const viewer of [{ username: "reporter1" }, { username: "peer" }, { username: "owner1", role: "admin" }]) {
      assert.equal((await retryRoute(service, viewer)).status, 403);
    }
    assert.equal(remote.seen.length, 0, "未授权请求不能触及 CodeHub");
    const owner = { username: "owner1", role: "developer" };
    assert.equal((await retryRoute(service, owner, REPOS[1])).status, 409);
    assert.equal((await retryRoute(service, owner, "")).status, 409);
    const mr = service.session(state.id).state.mrs![0];
    for (const finished of ["merged_at", "closed_at"] as const) {
      mr[finished] = state.updated_at;
      assert.equal((await retryRoute(service, owner)).status, 409);
      delete mr[finished];
    }
    assert.equal(remote.seen.length, 0);
    updateBusinessModule(testCase.dir, "module-a", {
      mr_participants: { reviewers: ["new-person"], approval_approvers: [] },
    }, "owner1");
    const transitions = structuredClone(service.session(state.id).state.transitions ?? []);
    const failed = await retryRoute(service, owner);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.mrs[0].participants.status, "failed");
    assert.equal(failed.body.mrs[0].participants.message, "无人员配置权限");
    assert.deepEqual(service.session(state.id).state.transitions ?? [], transitions, "失败不新增时间线或给 Agent 的提示");
    const result = await retryRoute(service, owner, REPOS[0].replace(/\.git$/, ""));
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "archived");
    assert.equal(result.body.mrs[0].participants.status, "applied");
    assert.deepEqual(remote.seen.map(entry => entry.path), ["/mr/participants", "/mr/participants"]);
    assert.deepEqual(remote.seen[0].body, { repo: REPOS[0], mr: "9", participants: PEOPLE });
    assert.equal(identity, "owner1");
    const saved = JSON.parse(readFileSync(join(workspace, "issue.json"), "utf-8"));
    assert.equal(saved.mrs[0].participants.status, "applied");
    assert.equal(saved.status, "archived");
    assert.equal(saved.stage, "mr_green");
    assert.equal(saved.parked_notices, undefined);
    assert.equal(saved.pipelines, undefined);
    assert.equal(service.hasRunningContainer(state.id), false);
    assert.equal((await retryRoute(service, owner)).status, 409, "成功后不再次同步人员");
    assert.equal(remote.seen.length, 2);
  } finally {
    await service.shutdown();
    await remote.stop();
  }
});
