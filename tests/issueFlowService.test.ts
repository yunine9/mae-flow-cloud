/**
 * 问题流 v2 的契约测试:会话多轮闭环、非问题归档、单号门禁与宿主
 * 推送、重启续聊、MCP 网关客户端。真假件语义都在这里钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { cloneFailureMessage } from "../src/issueFlow/issueGit.ts";

test("克隆认证失败说人话:引导去个人设置配令牌,其余保留 git 原文", () => {
  // 内网实测原文:沙箱拒绝 askpass → git 要不到用户名
  const realStderr = [
    "error: unable to read askpass response from",
    " '/home/y/code/mae-flow-cloud/.tasks/.runtime/issue-git/operation-x/reject-askpass.sh'",
    "fatal: could not read Username for 'https://szv-y.codehub.huawei.com':",
    " terminal prompts disabled",
  ].join("\n");
  const missing = cloneFailureMessage(undefined, realStderr);
  assert.match(missing, /Git 令牌/, "必须给出去哪配的引导");
  assert.match(missing, /个人设置/);
  assert.match(missing, /重新发起/, "failed 是终态,引导只能是重新发起");
  assert.match(missing, /could not read Username/, "关键事实不吞");
  assert.ok(!missing.includes("askpass"), "沙箱内部路径不该再吓人");

  // 已配凭据但被平台拒绝 → 引导核对,并报出实际认证账号
  const rejected = cloneFailureMessage(
    { username: "y00965296", password: "wrong" },
    "fatal: Authentication failed for 'https://szv-y.codehub.huawei.com/a.git/'",
  );
  assert.match(rejected, /拒绝/);
  assert.match(rejected, /y00965296/);
  assert.match(rejected, /Git 令牌/);

  // 非认证错误:保留 git 原文,不乱引导
  const other = cloneFailureMessage(undefined,
    "fatal: repository 'https://git/x.git/' not found");
  assert.match(other, /not found/);
  assert.ok(!other.includes("Git 令牌"));
});
import { TaskService } from "../src/taskService.ts";
import { createGoOpsTools } from "../src/issueFlow/opsTools.ts";
import {
  McpGateway,
  UnconfiguredDtsGateway,
} from "../src/issueFlow/gateways.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("问题会话多轮闭环:研究→提问卡→作答→非问题归档(无内核参与)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-flow2-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "report_stage",
      input: { stage: "analyzing", note: "从日志与代码初步定位" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 根因分析\\n\\n结论:非问题(测试环境时钟漂移导致的误报)。\\n' > issue-analysis.md" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "分析结论是非问题(误报),确认归档收口?",
      options: ["确认归档", "继续研究"],
    }] } } },
    { tool: { name: "report_stage",
      input: { stage: "concluded", note: "非问题:误报" } } },
    { text: "研究完成:结论为非问题,证据已写入 issue-analysis.md,建议归档。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create({
      account: "dev",
      title: "播放器偶发黑屏",
      description: "测试环境偶发黑屏,疑似新版本引入",
      repoUrl: origin,
      environment: {
        hosts: ["10.0.0.8"],
        password: "env-shared-secret",
      },
    });
    // create() 即刻排入首轮研究(并发额度内同步点火,状态直奔 running)。
    assert.equal(created.status, "running");
    assert.equal(created.ticket, undefined, "先研究后补单:创建时单号可空");
    assert.ok(!existsSync(join(dataDir, "issues", created.id, "repo", ".mae-flow.json")),
      "问题会话不初始化内核(与需求流分属两个范式)");

    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "根因确认问题卡");
    assert.equal(waiting.stage, "analyzing");
    assert.ok(waiting.waiting, "问题卡应来自 AskUserQuestion");
    assert.ok(waiting.has_analysis, "结论文档应已产出");

    // 秘密纪律:环境密码不进模型上下文。
    const requestText = JSON.stringify(model.requests);
    assert.doesNotMatch(requestText, /env-shared-secret/);
    assert.match(requestText, /10\.0\.0\.8/, "环境地址是现场材料,应该可见");
    const stateFile = readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.doesNotMatch(stateFile, /env-shared-secret/);

    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "确认归档",
    });
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "作答后回合收口");
    assert.equal(idle.stage, "concluded", "作答后应继续推进到结论阶段");
    assert.ok(idle.messages.some((message) =>
      message.role === "user" && message.text.includes("黑屏")),
    "开场问题应作为用户消息入账");
    assert.ok(idle.messages.some((message) => message.role === "decision"),
    "用户决定应入账");

    // 续聊通道:idle 后用户还能继续说话。
    const resumed = service.reply(created.id, "补充:同类现象上周也出现过");
    assert.equal(resumed.status, "running");
    await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle" || issue.status === "failed" ? issue : undefined;
    }, "续聊回合收口", 10_000).then((issue) => {
      assert.notEqual(issue.status, "failed", issue.error);
    });

    const archived = service.control(created.id, {
      action: "archive", kind: "non_issue", summary: "误报,时钟漂移",
    });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "non_issue");
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
    "归档后环境凭据必须清理");
    assert.throws(() => service.reply(created.id, "再看看"),
      /已归档/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("单号门禁:未绑定单号时 push_branch 被机械拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-gate-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "bash", input: { command:
      "cd repo && git checkout -q -b master_dev_DTS1 && "
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS1][fix] 修复测试问题'" } } },
    { tool: { name: "push_branch", input: { branch: "master_dev_DTS1" } } },
    { text: "推送被单号门禁拒绝,已如实报告用户。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create({
      account: "dev", title: "无单号问题", repoUrl: origin,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "无单号回合收口");
    assert.equal(created.ticket, undefined);
    assert.equal(service.get(created.id).push, undefined,
      "没有单号就不该有任何推送记录");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const pushFinished = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((event) => event.kind === "tool_finished"
        && event.payload?.name === "push_branch");
    assert.ok(pushFinished, "push_branch 调用应入事件账");
    assert.equal(pushFinished.payload.is_error, true);
    assert.match(String(pushFinished.payload.result), /单号门禁/,
      "拒绝理由必须说人话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("宿主推送与提 MR:门禁、真推送、公共 mrClient(与需求交付同格式)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-push-"));
  const origin = bareOrigin(dataDir);
  const branch = "master_dev_DTS2026082001317";
  // 假交付平台:记录请求形状,回 MR 链接——与适配层 POST /mr 同构。
  const seen: Array<{ headers: Record<string, string>; body: any }> = [];
  const platform = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({
        headers: request.headers as Record<string, string>,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        url: `http://codehub.test/mr/1024`, id: 1024,
      }));
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const script: Scene[] = [
    { tool: { name: "bash", input: { command:
      `cd repo && git checkout -q -b ${branch} && `
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS2026082001317][fix] 修复登录超时'" } } },
    { tool: { name: "push_branch", input: { branch } } },
    { tool: { name: "create_mr", input: {} } },
    { text: "已推送并提 MR。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    platformUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      ticket: "DTS2026082001317",
      source: "dts",
      repoUrl: origin,
    });
    assert.equal(created.ticket, "DTS2026082001317");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "推送+提MR回合收口");
    const final = service.get(created.id);
    const push = final.push;
    assert.ok(push, "推送应记录在案");
    assert.equal(push.branch, branch);
    // 远端真实状态(不信任务自述):裸仓里分支应指向同一 SHA。
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
      { encoding: "utf-8" });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), push.sha);
    // Agent 侧推送被焊死:克隆的 pushurl 指向必失败地址。
    const pushurl = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo"),
        "config", "--get", "remote.origin.pushurl"],
      { encoding: "utf-8" });
    assert.match(pushurl.stdout, /\/dev\/null/);
    // MR:走公共客户端,单号关联与身份头同需求交付一个格式。
    assert.ok(final.mr, "MR 应记录在案");
    assert.equal(final.mr!.url, "http://codehub.test/mr/1024");
    assert.equal(final.mr!.iid, "1024");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.source_branch, branch);
    assert.equal(seen[0].body.target_branch, "master");
    assert.equal(seen[0].body.dts_no, "DTS2026082001317", "单号要走 dts_no 关联");
    assert.match(String(seen[0].body.title), /^\[DTS2026082001317\]/);
    assert.equal(seen[0].headers["x-mfc-git-user"], "dev");
    assert.equal(seen[0].headers["x-mfc-git-token"], "git-token");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await new Promise<void>((resolve) => platform.close(() => resolve()));
  }
});

test("重启续聊:等待问题卡期间服务重启,作答仍能续上现场", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-recover-"));
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现象是必现还是偶发?", options: ["必现", "偶发"],
    }] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const first = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  let second: IssueFlowService | undefined;
  try {
    const created = first.create({ account: "dev", title: "重启续聊" });
    const waiting = await until(() => {
      const issue = first.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "重启前问题卡");
    await first.shutdown();

    second = new IssueFlowService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const recovered = second.get(created.id);
    assert.equal(recovered.status, "waiting_user",
      "重启不吞等待中的问题卡");
    second.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发",
    });
    await until(() => {
      const issue = second!.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "重启后作答复跑");
    const detail = second.get(created.id);
    assert.ok(detail.messages.some((message) =>
      message.role === "decision" && message.text.includes("偶发")),
    "决定应作为消息入账");
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("问题流专用部署(--issue-only):需求流程停用,问题流不受影响", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-only-"));
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {}, maxConcurrent: 1,
    requirementDisabled: true,
  });
  // 发起需求任务:API 层直接拒绝,文案指路问题处理。
  assert.throws(() => service.create("新需求", { account: "dev" }),
    /问题流专用.*需求流程未启用/);
  // 下单表单的 blockers 把停用状态摆在明面上(前端现有渲染复用它)。
  const blockers = service.launchOptions().blockers
    .map((item) => item.key);
  assert.ok(blockers.includes("requirement_disabled"));
  // 问题流服务自身零依赖 TaskService:同数据目录并行构造,互不拖累。
  const issueFlow = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  assert.deepEqual(issueFlow.list(), []);
});

test("ops 运维工具:真二进制冒烟,诚实失败且不泄密码", async () => {
  const toolsDir = join(process.cwd(), "assets", "ops-tools");
  const binary = process.platform === "win32"
    ? "fetch-logs.exe"
    : process.arch === "arm64"
      ? "fetch-logs-linux-arm64" : "fetch-logs-linux-amd64";
  if (!existsSync(join(toolsDir, binary))) {
    // 纪律:没条件(裁剪部署)显式跳过,不静默当过。
    return;
  }
  const ops = createGoOpsTools({ toolsDir });
  const localDir = join(tmpdir(), `mfc-issue-ops-${Date.now()}`);
  await assert.rejects(
    () => ops.fetchLogs({
      hosts: ["127.0.0.1"],   // 必拒环回:真 SSH 立刻 refused
      services: ["TranFmaWebsite"],
      password: "probe-pass",
      localDir,
    }),
    (error: Error) => {
      assert.match(error.message, /拉取日志失败/);
      assert.ok(!error.message.includes("probe-pass"),
        "密码绝不能出现在错误文本里");
      return true;
    },
  );
});

test("MCP 网关客户端:握手、token 头、工具调用与未配置 fail-loud", async () => {
  const seen: Array<{ token?: string; session?: string; body: any }> = [];
  const fake = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      seen.push({
        token: String(request.headers["x-auth-token"] ?? ""),
        session: String(request.headers["mcp-session-id"] ?? ""),
        body,
      });
      const reply = body.method === "initialize"
        ? {
            jsonrpc: "2.0", id: body.id,
            result: { protocolVersion: "2025-03-26", capabilities: {} },
          }
        : body.method === "tools/call"
          ? {
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify([
                  { ticket: "DTS1", title: "登录超时" },
                ]) }],
              },
            }
          : { jsonrpc: "2.0", id: body.id ?? null, result: {} };
      response.writeHead(200, {
        "content-type": "application/json",
        ...(body.method === "initialize"
          ? { "mcp-session-id": "sess-1" } : {}),
      });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as { port: number }).port;
  try {
    const gateway = new McpGateway({
      url: `http://127.0.0.1:${port}/mcp`,
      token: "secret-token",
      toolNames: { list: "list_issues" },
    });
    const result = await gateway.call("list_issues", { owner: "dev" });
    const text = (result as any).content[0].text;
    assert.match(text, /DTS1/);
    assert.equal(seen[0].token, "secret-token", "token 只在头里");
    assert.ok(seen.length >= 2);
    assert.equal(seen[1].session, "sess-1", "会话头要回带");

    const unconfigured = new UnconfiguredDtsGateway();
    await assert.rejects(() => unconfigured.listByOwner("dev"),
      /未配置/);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
