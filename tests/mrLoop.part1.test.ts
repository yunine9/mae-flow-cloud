/**
 * MR 闭环 part 1/6:检视回复闭环:讨论接口重试、显式代 resolve、答复等待检视人、outbox 恢复对 SHA。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { DeliveryOutbox } from "../src/deliveryOutbox.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import {
  KERNEL_ROOT,
  makeSourceRepo,
  walkScript,
  feedbackReceiptCommand,
  buildService,
  mrModel,
  until,
} from "./mrLoop.helpers.ts";


test("MR 讨论接口失败时明确显示自动重试，不能误报门禁全绿", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-unavailable", file: "a.txt", line: 1,
    author: "检视人", body: "这条意见必须处理",
  });
  platform.discussionListFailures = 100;
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-unavailable-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson());
    const id = service.create("交付 REQ9:讨论服务故障").id;
    await until(() => service.get(id)?.delivery?.waiting_on
      ?.includes("检视意见明细暂不可用") ?? false,
    "讨论接口故障进入明确重试态");
    const task = service.get(id)!;
    assert.equal(task.status, "await_merge");
    assert.match(task.detail ?? "", /检视意见明细暂不可用.*自动重试/);
    assert.doesNotMatch(task.detail ?? "", /门禁全绿/);
    assert.equal(platform.discussions[0].replies.length, 0,
      "拉取失败不能拿空列表冒充没有意见并生成回复");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("检视优先于 CI;回复发布并标已解决(显式开代 resolve);CI 接棒;合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  // 解释型检视只发布回复，不改业务代码，因此不应靠流程 sidecar 制造
  // 一个假 SHA。首版红灯由 CI 修复产生新提交后，第二条流水线应转绿。
  platform.statusQueue.push("failed", "success");
  platform.seedDiscussion({
    id: "d-1", file: "a.txt", line: 1, severity: "major",
    author: "张三", body: "这里要判空,别让缺失变量把模板炸了",
  });
  platform.artifacts.push(
    { name: "build_log_101.txt", text: "BUILD FAILURE: 编译失败详情全文" });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-"));
  const model = mrModel([
    ...walkScript(),
    // 检视修复会话:只写回复,不改代码(检视意见是解释类)
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'EOF'
[d-1]
意见成立,已在本轮 CI 修复里一并补判空;模板缺失变量将输出降级文案。
EOF` } } },
    { text: "检视意见处理完毕。" },
    // 测试控制器会在下一幕按真实提交格式收口；Agent 这里只做源码修改。
    { tool: { name: "bash", input: { command:
        `echo fixed >> a.txt; ${feedbackReceiptCommand("编译问题已修复")}` } } },
    { text: "流水线问题已修并提交。" },
  ], dataDir);
  await model.start();
  // 代 resolve 是显式开关(默认关,报告 D3:resolve 归检视人);
  // 这条用例验证开了之后回复+标已解决一气呵成、检视门禁当轮清掉。
  const service = buildService(platform, dataDir, model.modelsJson(),
    { resolveDiscussions: true });
  try {
    const id = service.create("交付 REQ9:检视优先").id;
    // 第一裁:流水线红 + 检视未解决 → 派的是检视修复(不是 CI),round=0
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "review",
      "检视修复先派");
    assert.equal(service.get(id)!.delivery?.loop?.round, 0,
      "检视修复不扣 CI 重试");
    // 检视会话收口后:回复发布到平台并标已解决
    await until(() => platform.discussions[0].resolved, "讨论被标已解决");
    assert.match(platform.discussions[0].replies[0] ?? "", /已在本轮/,
      "回复原文要发到平台");
    await until(() => service.get(id)!.feedback?.some((item) =>
      item.source === "mr_discussion" && item.status === "closed") ?? false,
    "平台检视门禁权威关闭反馈");
    // 批注与检视里的 CodeHub 意见列表靠这几个字段排版:检视人是谁、
    // Agent 回了什么。author 只进 Cloud 索引,不进内核批次。
    const codehub = service.get(id)!.feedback!
      .find((item) => item.source === "mr_discussion")!;
    assert.equal(codehub.author, "张三", "检视人名字要进任务 API 镜像");
    assert.match(codehub.resolution ?? "", /已在本轮/,
      "Agent 的逐条回复要作为处理结果镜像给前端");
    // 检视清了轮到 CI:round 1,失败材料落盘且使命里给了路径
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "ci", "CI 接棒");
    assert.equal(service.get(id)!.delivery?.loop?.round, 1);
    const workspace = service.get(id)!.workspace;
    await until(() => existsSync(join(workspace, "pipeline", "build_log_101.txt"))
      || (existsSync(join(workspace, "pipeline-history")) && readdirSync(join(workspace, "pipeline-history"))
        .some(dir => existsSync(join(workspace, "pipeline-history", dir, "build_log_101.txt")))),
      "失败材料确实镜像，换 SHA 后可已归档");
    const artifactsCall = platform.seenIdentity.find(
      (request) => request.path === "/pipeline/artifacts");
    assert.equal(new URLSearchParams(artifactsCall?.query).get("mr"),
      platform.mergeRequests[0]?.url,
    "artifacts 链必须拿完整 MR URL，不能把仅供 status 的 MR iid 当 URL");
    // CI 修复推新提交 → 新流水线绿 → 等待合入
    await until(() => service.get(id)!.status === "await_merge", "绿灯");
    // 平台合入 → 任务完成
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
    assert.equal(service.get(id)!.delivery?.mr_state, "已合入");
    // 流水线证据口:绿灯终态时内核已绑 HEAD 裁决,现场文件是真相,
    // delivery.attested 只是它的镜像戳。
    const statePath = readdirSync(workspace)
      .map((name) => join(workspace, name, ".mae-flow.json"))
      .find((candidate) => existsSync(candidate))!;
    const kernelState = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(kernelState.quality?.pipeline?.verdict, "PASS",
      "内核裁决要落进现场文件");
    assert.equal(kernelState.quality.pipeline.head,
      service.get(id)!.delivery?.sha, "裁决必须绑最终交付的 SHA");
    assert.match(service.get(id)!.delivery?.attested ?? "", /^PASS@/,
      "任务侧要有裁决镜像戳");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /按当前责任人要求逐条处理/, "检视使命在场");
    assert.match(seen, /review_replies\.md/, "回复文件契约在使命里");
    assert.match(seen, /pipeline\/build_log_101\.txt/,
      "落盘路径要交给修复会话");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("默认只回复不代 resolve:已答复=等检视人确认,检视人点掉后合入", async () => {
  // 能力核对报告 D3 的语义:既有框架刻意只回复、把 resolve 留给
  // 检视人("that is the reviewer's responsibility")。默认配置下:
  // 回复发布后讨论保持未解决 → 不是修不动(不 halted),是等人
  // (waiting_on 说清);检视人手动 resolve 后门禁清,合入收口。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-9", revision: 1, file: "a.txt", line: 1, severity: "minor",
    author: "李四", body: "变量名建议改成 templateVars",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-ro-"));
  const model = mrModel([
    ...walkScript(),
    // 检视修复会话:解释类回复,不改代码
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'EOF'
[d-9]
命名保持与现有模块一致,暂不改;后续统一重命名时一起处理。
EOF` } } },
    { text: "检视意见已答复。" },
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'EOF'
[d-9]
收到编辑后的补充要求，已经按新边界重新核对并答复。
EOF` } } },
    { text: "编辑后的检视意见也已逐条答复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:回复不代点").id;
    // 流水线绿 → 监控发现检视门禁红 → 派检视修复
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "review",
      "检视修复派单");
    // 回复发布到平台,但讨论保持未解决(默认不代 resolve)
    await until(() => (platform.discussions[0].replies[0] ?? "") !== "",
      "回复要发到平台");
    assert.equal(platform.discussions[0].resolved, false,
      "默认不许代检视人点已解决");
    // 已答复未确认 = 等人,不是刹车:waiting_on 说清、不 halted
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "")
        .includes("等检视人确认"), "挂到等检视人确认");
    assert.notEqual(service.get(id)!.delivery?.loop?.state, "halted",
      "等检视人确认不是修不动,不许停环");
    platform.discussions[0].revision = 2;
    platform.discussions[0].updated_at = "2026-09-01T10:00:00Z";
    platform.discussions[0].body = "补充：还要核对空字符串的命名边界";
    await until(() => platform.discussions[0].replies.length === 2,
      "同一个 discussion 编辑后必须形成新反馈并重新逐条答复");
    const revisions = service.get(id)!.feedback
      ?.filter((item) => item.source === "mr_discussion"
        && item.source_id === "d-9")
      .map((item) => item.source_revision).sort();
    assert.deepEqual(revisions, [1, 2],
      "评论编辑不能被旧 discussion id 或旧 batch 覆盖");
    // 检视人看过回复,点了已解决 → 门禁清 → 平台合入 → 收口
    platform.discussions[0].resolved = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("outbox 恢复投递强制匹配 push 收据 SHA，旧版回复不能借新分支发出", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-recovery-sha", file: "a.txt", line: 1, severity: "major",
    author: "乙", body: "恢复场景意见",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-recovery-sha-"));
  const service = new TaskService({
    dataDir, provider: "fixture", model: "fixture", maxConcurrent: 0,
    modelsJson: { providers: { fixture: { models: [{ id: "fixture" }] } } },
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 50 },
  });
  try {
    const id = service.create("outbox SHA 恢复", { ticket: "REQ_OUTBOX_SHA" }).id;
    const internal = (service as any).tasks.get(id);
    const expectedSha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    internal.summary.delivery = { git_push: { sha: otherSha } };
    const outbox = new DeliveryOutbox(join(
      internal.summary.workspace, "delivery-outbox.jsonl"));
    const item = outbox.enqueueReviewReply({
      discussion_id: "d-recovery-sha", body: "已修复", repo: platform.barePath,
      resolve: false, expected_sha: expectedSha,
    });

    await (service as any).flushReviewReplyOutbox(internal);
    assert.equal(platform.discussions[0].replies.length, 0,
      "当前 push 是另一 SHA 时必须零网络副作用");
    const blocked = outbox.list().find((one) => one.id === item.id)!;
    assert.equal(blocked.state, "pending");
    assert.equal(blocked.attempts, 0, "SHA 拒绝不是一次远端 attempt");
    assert.match(blocked.last_error ?? "", /当前远端推送收据/);

    // 模拟重启对账恢复出这条动作真正对应的 push 收据；同一 pending
    // 此时才允许投递，并正常落 delivered。
    internal.summary.delivery.git_push.sha = expectedSha;
    await (service as any).flushReviewReplyOutbox(internal);
    assert.deepEqual(platform.discussions[0].replies, ["已修复"]);
    assert.equal(outbox.list().find((one) => one.id === item.id)?.state,
      "delivered");

    // 启动恢复与合入 watcher 可能同拍请求 flush；单飞必须保证同一动作
    // 只产生一次 attempt / 网络副作用，不能由本地竞态制造假 stalled。
    const concurrent = outbox.enqueueReviewReply({
      discussion_id: "d-recovery-sha", body: "并发恢复", repo: platform.barePath,
      resolve: false, expected_sha: expectedSha,
    });
    await Promise.all([
      (service as any).flushReviewReplyOutbox(internal),
      (service as any).flushReviewReplyOutbox(internal),
    ]);
    const concurrentState = outbox.list().find(
      (one) => one.id === concurrent.id)!;
    assert.equal(concurrentState.state, "delivered");
    assert.equal(concurrentState.attempts, 1);
    assert.deepEqual(platform.discussions[0].replies,
      ["已修复", "并发恢复"]);

    // 合法投递事实后出现完整坏行时必须 fail-closed 且把阻塞投影给人，
    // 不能只在后台 watcher 里反复抛错，让 await_merge 表面继续等合入。
    appendFileSync(outbox.path, "这不是 JSON\n", "utf-8");
    internal.summary.status = "await_merge";
    assert.equal(await (service as any).flushReviewReplyOutbox(internal), false);
    assert.match(internal.summary.detail, /检视回复投递账不可读/);
    assert.match(internal.summary.delivery.stalled, /delivery-outbox\.jsonl/);

    writeFileSync(outbox.path,
      readFileSync(outbox.path, "utf-8").replace("这不是 JSON\n", ""),
      "utf-8");
    let resumed = 0;
    (service as any).tryDeliver = async () => { resumed += 1; };
    internal.summary.status = "verifying";
    (service as any).scheduleDeliveryRecovery(
      internal, internal.controlEpoch);
    await until(() => internal.summary.delivery.stalled === undefined
      && resumed === 1, "修复投递账后在同一进程自动续接交付", 5_000);
    assert.equal(internal.summary.delivery.stalled, undefined);
    assert.match(internal.summary.detail, /投递账已恢复/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await platform.stop();
  }
});
