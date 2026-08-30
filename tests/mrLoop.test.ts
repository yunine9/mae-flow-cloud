/**
 * MR 闭环(docs/mr-loop-adaptation.md,对照内网既有框架):
 * - 失败先分类再派单:检视 > 冲突 > CI,同时多项只修最高优先级一路;
 * - 重试语义:只有 CI 修复累加 round,检视/冲突触发时清零;
 * - 检视闭环:意见落盘→专职会话逐条回复→宿主发布并标已解决;
 * - 冲突修复:宿主 merge 造真实冲突标记,agent 在真冲突上解;
 * - 等人门禁(审批/投票/WIP):挂起等待,不派 agent 不扣重试,说清卡在哪;
 * - MR 平台终态:merged=完成,closed=失败请人工;
 * - 平台不支持门禁契约(404)= 旧语义一字不变(delivery.test.ts 全兜着)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { workflowChoices, workflowLabel } from "../src/kernelChoices.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  return found;
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-mrl-src-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

/** 首跑 Agent 只改业务文件；测试宿主负责阶段与提交。 */
function walkScript(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "echo change > a.txt" } } },
    { text: "交付完成。" },
  ];
}

/** 模拟 Agent 按新契约逐条留下结构化回执。真实场景由使命提示写文件；
 * 测试从宿主已经落好的 local-annotations.json 取稳定 id/revision。 */
function localReviewReceiptCommand(summary: string): string {
  const safeSummary = JSON.stringify(summary);
  return "node -e 'const fs=require(\"fs\");"
    + "const p=JSON.parse(fs.readFileSync(\"../reviews/local-annotations.json\",\"utf8\"));"
    + `const summary=${safeSummary};`
    + "fs.writeFileSync(\"../reviews/local-receipts.json\",JSON.stringify({receipts:p.annotations.map(a=>({annotation_id:a.id,revision:a.rework||0,outcome:\"fixed\",summary,evidence:[a.file+\":\"+a.line]}))}))'";
}

function buildService(
  platform: FakeGitPlatform,
  dataDir: string,
  modelsJson: Record<string, unknown>,
  deliveryExtra: {
    resolveDiscussions?: boolean;
    pollTimeoutMs?: number;
    repairRounds?: number;
  } = {},
): TaskService {
  return new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 120,
                ...deliveryExtra },
  });
}

function mrModel(script: Scene[], dataDir: string): ScriptedModelServer {
  return new ScriptedModelServer(script, "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir),
  });
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 80));
  }
}

/** 本地人工意见触发的修改统一在 push 前回到意见作者手里。测试辅助只
 * 代演真实交互：逐条作者确认，再由任务责任人确认最终代码。 */
async function closeWorkspaceReview(
  service: TaskService,
  id: string,
  annotations: Array<{ id: string; author: string }>,
): Promise<void> {
  await until(() => service.get(id)?.status === "waiting_for_human"
    && service.get(id)?.waiting?.step === "cloud_push_confirm",
  "人工意见修改后进入复检");
  for (const annotation of annotations) {
    service.verifyAnnotation(id, annotation.id, annotation.author);
  }
  const waiting = service.get(id)!.waiting!;
  const question = (waiting.question as any).questions[0].question;
  await service.decide(id, {
    waiting_id: waiting.waiting_id,
    state_version: waiting.state_version,
    selected_options: { [question]: "确认按清单推送" },
  });
}

test("检视优先于 CI;回复发布并标已解决(显式开代 resolve);CI 接棒;合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "success"); // 首跑红;CI 修后绿
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
    // CI 修复会话:只提交，宿主随后推送
    { tool: { name: "bash", input: { command:
        "echo fixed >> a.txt && git add . && git commit --quiet -m fix" } } },
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
    // 检视清了轮到 CI:round 1,失败材料落盘且使命里给了路径
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "ci", "CI 接棒");
    assert.equal(service.get(id)!.delivery?.loop?.round, 1);
    const workspace = service.get(id)!.workspace;
    await until(() => existsSync(
      join(workspace, "pipeline", "build_log_101.txt")),
      "失败材料镜像到 pipeline/");
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
    assert.match(seen, /逐条处理它们是你此刻唯一的使命/, "检视使命在场");
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
    id: "d-9", file: "a.txt", line: 1, severity: "minor",
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
    // 检视人看过回复,点了已解决 → 门禁清 → 平台合入 → 收口
    platform.discussions[0].resolved = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("MR 回复部分失败:成功项不重发,失败项由 outbox 自动续投", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-ok", file: "a.txt", line: 1, severity: "minor",
    author: "甲", body: "第一条意见",
  });
  platform.seedDiscussion({
    id: "d-retry", file: "a.txt", line: 2, severity: "minor",
    author: "乙", body: "第二条意见",
  });
  platform.failNextDiscussionReplies("d-retry", 1);
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-outbox-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'REPLY'
[d-ok]
第一条已处理。
[d-retry]
第二条已处理。
REPLY` } } },
    { text: "两条均已逐条答复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:回复故障恢复").id;
    const replies = (discussionId: string) =>
      platform.discussions.find((item) => item.id === discussionId)?.replies ?? [];
    await until(() => replies("d-ok").length === 1
      && replies("d-retry").length === 1, "失败回复由 outbox 自动续投");
    assert.equal(replies("d-ok").length, 1,
      "同批成功项不能随失败项一起重发");
    const outbox = readFileSync(join(
      service.get(id)!.workspace, "delivery-outbox.jsonl"), "utf-8");
    assert.match(outbox, /"op":"failed"/);
    assert.equal((outbox.match(/"op":"delivered"/g) ?? []).length, 2);

    for (const discussion of platform.discussions) discussion.resolved = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "故障恢复后合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("答复台账跨批继承:部分解决不复读旧意见,新增只答新意见", async () => {
  // 2026-08-30 探针实锤的修复:检视人解决两条中的一条后,旧逻辑把剩下
  // 那条当"新一批"重新派单——平台上同一讨论被重复回复,还白烧一只
  // 修复会话。现在答复台账跨批继承:集合缩水=继续等人;集合增长=只对
  // 未答复的意见派活。顺带钉住回复文件的同行格式容错([id] 正文)。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-a", file: "a.txt", line: 1, severity: "minor",
    author: "李四", body: "建议改名 templateVars",
  });
  platform.seedDiscussion({
    id: "d-b", file: "a.txt", line: 2, severity: "minor",
    author: "王五", body: "这里补个注释",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-ledger-"));
  const model = mrModel([
    ...walkScript(),
    // 首轮检视会话:d-a 用标准格式,d-b 故意写成同行格式——模型常这么
    // 偏,严格解析会整条丢掉并触发"没答复"停环。
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'REPLY'
[d-a]
命名保持一致,暂不改。
[d-b] 注释已补充说明,不改代码。
REPLY` } } },
    { text: "两条意见都已答复。" },
    // 第二轮只应该为新意见 d-c 而起;若旧意见被复读,回复计数会露馅。
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'REPLY'
[d-c]
边界条件已确认,无需改动。
REPLY` } } },
    { text: "新意见已答复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:台账继承").id;
    const replies = (which: string) =>
      platform.discussions.find((d) => d.id === which)?.replies ?? [];
    await until(() => replies("d-a").length >= 1 && replies("d-b").length >= 1,
      "首轮两条都答复(含同行格式那条)");
    assert.match(replies("d-b")[0] ?? "", /注释已补充/,
      "同行格式的回复正文不能丢");
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "").includes("等检视人确认"),
      "挂到等检视人确认");
    // 检视人只解决 d-a:剩下的 d-b 已答复过,必须继续等人,不许复读。
    platform.discussions.find((d) => d.id === "d-a")!.resolved = true;
    await new Promise((tick) => setTimeout(tick, 2_500));
    assert.equal(replies("d-b").length, 1,
      `d-b 已答复过,不该被重复回复(实际 ${JSON.stringify(replies("d-b"))})`);
    // 检视人新增一条:只答新意见,旧的仍不复读。
    platform.seedDiscussion({
      id: "d-c", file: "a.txt", line: 3, severity: "minor",
      author: "赵六", body: "边界条件确认一下",
    });
    await until(() => replies("d-c").length >= 1, "新意见得到答复");
    assert.equal(replies("d-a").length, 1, "已解决的 d-a 不许再收到回复");
    assert.equal(replies("d-b").length, 1, "已答复的 d-b 不许再收到回复");
    // 第二轮使命只点名新意见,并明说旧的不用再答。
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /1 条检视意见待处理/, "第二轮只派 1 条新意见");
    assert.match(seen, /此前已答复/, "使命明说旧意见不用再答");
    // 全部解决后照常合入收口。
    for (const d of platform.discussions) d.resolved = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("等人门禁:挂起等待不派 agent,说清卡在哪;人批完合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.humanGates.approvers_passed = false; // 等审批
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-wait-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:等审批").id;
    await until(() => service.get(id)!.status === "await_merge", "先到等待合入");
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "").includes("等审批"),
      "挂起等待要说清卡在哪");
    assert.equal(service.get(id)!.delivery?.loop, undefined,
      "等人不是失败,不开修复环不扣重试");
    // 审批人批了 → 平台合入
    platform.humanGates.approvers_passed = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("冲突门禁:宿主 merge 造真实冲突标记,会话在真冲突上解,推送后收口", async () => {
  const platform = new FakeGitPlatform();
  const source = makeSourceRepo();
  platform.initBare(source, mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-cf-"));
  const model = mrModel([
    ...walkScript(),
    // 冲突修复会话:确认标记在,解掉,完成合并提交；宿主随后推送
    { tool: { name: "bash", input: { command:
        "grep -q '<<<<<<<' a.txt && "
        + "printf 'change\\nupstream\\n' > a.txt && git add a.txt "
        + "&& git commit --quiet --no-edit" } } },
    { text: "冲突已解并完成合并提交。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:解冲突").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    const preConflictSha = service.get(id)!.delivery?.sha;
    const taskState = JSON.parse(readFileSync(
      join(service.get(id)!.workspace, "task.json"), "utf-8"));
    const taskCwd = String(taskState.cwd);
    const mergeMarker = join(taskCwd, ".git", "merge-driver-ran");
    const mergeDriver = join(taskCwd, ".git", "malicious-merge.sh");
    writeFileSync(mergeDriver,
      `#!/bin/sh\nprintf compromised > '${mergeMarker}'\nexit 1\n`);
    chmodSync(mergeDriver, 0o700);
    writeFileSync(join(taskCwd, ".git", "info", "attributes"),
      "a.txt merge=owned\n");
    git(taskCwd, "config", "merge.owned.driver",
      `${mergeDriver} %O %A %B`);
    // 目标分支动了且与工作分支冲突(a.txt 两边都改)
    const other = mkdtempSync(join(tmpdir(), "mfc-mrl-other-"));
    execFileSync("git",
      ["clone", "--quiet", platform.barePath, join(other, "clone")]);
    const clone = join(other, "clone");
    git(clone, "checkout", "--quiet", "master");
    git(clone, "config", "user.email", "peer@test");
    git(clone, "config", "user.name", "peer");
    writeFileSync(join(clone, "a.txt"), "upstream\n");
    git(clone, "add", ".");
    git(clone, "commit", "--quiet", "-m", "master 侧改动");
    git(clone, "push", "--quiet", "origin", "master");
    platform.conflictGate = true;
    // 监控发现冲突 → 派冲突修复(不扣 CI 重试)
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "conflict",
      "冲突修复派单");
    assert.equal(service.get(id)!.delivery?.loop?.round, 0);
    // 会话解完推送(剧本里 grep 证明标记真实在场)→ 新流水线绿
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery?.sha !== preConflictSha,
    "解完推送新合并提交并回到 monitoring", 90_000);
    assert.equal(existsSync(mergeMarker), false,
      "宿主准备冲突不能执行 Agent 配置的自定义 merge driver");
    // 故意让平台冲突门禁多红几拍，模拟真实平台异步刷新。宿主已确认
    // HEAD 包含目标分支时必须继续监控，不能把陈旧门禁误判成“同 SHA
    // 修复无提交”而停环；旧实现稳定在这里进入 halted。
    await new Promise((tick) => setTimeout(tick, 600));
    assert.notEqual(service.get(id)!.delivery?.loop?.state, "halted",
      "平台冲突门禁刷新滞后不应触发同 SHA 刹车");
    platform.conflictGate = false;
    await until(() => service.get(id)!.status === "await_merge", "回到等待合入");
    // 合并提交信息的形状是**平台硬约束**(2026-08-18 拿到 pre-receive
    // 完整正则):放行 "Merge remote-tracking branch '…' into x" 与
    // git pull 那两种,**不放行本地 merge 的 "Merge branch 'master'
    // into x"**。所以宿主必须 merge origin/<target> 而不是 <target>
    // ——改错一个词,冲突修复的推送会在钩子那里被拒。
    const mergeSubject = git(platform.barePath, "log", "-1", "--format=%s",
      "master_bot_REQ9");
    assert.match(mergeSubject, /^Merge remote-tracking branch 'origin\//,
      `合并提交信息形状不对(平台钩子会拒收): ${mergeSubject}`);
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("内网真实门禁集(19 项):质量红要派修复,受保护分支挂人话等待", async () => {
  // 2026-08-18 内网 selftest 第一次拿到真门禁集,比契约里的九项多十项。
  // 两件事必须钉死:
  // ①`codequality_passed` 是**改代码能解决的**(CodeCheck/CodeCC 那类),
  //   归到等人就会让 MR 卡着没人动、任务干等到预算耗尽——必须派修复;
  // ②多出来的等人项要说人话:界面上"等 merged_by_user_passed"没人
  //   看得懂,而它的真实含义是"目标分支受保护,得让有权限的人点合入"。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  // 首跑流水线绿(ci_state_passed 过),但质量门禁红——这正是内网
  // 那条 MR 的形状:流水线与质量是两个门禁,别互相冒充。
  Object.assign(platform.humanGates, {
    codequality_passed: false,
    merged_by_user_passed: false,
    approval_reviewers_required_passed: true,
    committer_must_cast_two_votes_passed: true,
    non_ff_passed: true,
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-19-"));
  const model = mrModel([
    ...walkScript(),
    // 质量修复会话:改代码并提交，宿主随后推送
    { tool: { name: "bash", input: { command:
        "echo quality-fixed >> a.txt && git add . "
        + "&& git commit --quiet -m fix-quality" } } },
    { text: "质量问题已修并提交。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:真实门禁集").id;
    // 质量门禁红 → 派 CI 那一路修复(不是干等)
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "ci",
      "质量门禁要派修复而不是挂起");
    // 修完推新提交 → 质量门禁转绿 → 只剩"等人点合入"
    platform.humanGates.codequality_passed = true;
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "").includes("等有权限的人点合入"),
      "受保护分支要说人话");
    assert.ok(
      !(service.get(id)!.delivery?.waiting_on ?? "")
        .includes("merged_by_user_passed"),
      "别把平台字段名甩给人看");
    // 有权限的人点了合入 → 收口
    platform.humanGates.merged_by_user_passed = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("日志只详细到一维时:失败维度逐项点名,不许修完细的那维就交差", async () => {
  // 2026-08-21 内网真实数据:log 里 CODECHECK 给到了文件+行号+规则
  // (1181 字),COMPILE 只有一句"构建失败=1"(build log 拿不到)。
  // 只喂 log,模型会照着详细那一维修完就提交,编译照旧红,又白烧一轮。
  // checks 是结构化的平台事实,失败维度必须点名进使命。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  platform.nextPipelineChecks = [
    { dimension: "COMPILE", status: "failed", job: "CloudBuild2.0" },
    { dimension: "UT", status: "success", job: "unit-test" },
    { dimension: "CODECHECK", status: "failed", job: "CodeCCP2.0" },
  ];
  platform.nextPipelineLog = [
    "FAILED stage=CodeCCP2.0",
    "【CODECHECK 告警明细】",
    "  NRANROpMgr.cpp:115 | function 'processAdviceStatus' exceeds size",
    "    规则: G.FUN.01-CPP 函数功能要单一",
  ].join("\n");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-dims-"));
  const model = mrModel([
    ...walkScript(),
    { text: "CodeCheck 已修;COMPILE 这一维日志与 ../pipeline/ 均无失败原文,"
        + "不猜改——请补 build log 通道。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:逐项维度").id;
    await until(() =>
      (service.get(id)!.delivery?.loop?.state ?? "") === "halted",
      "无新提交应如实停下");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /本轮失败的维度/, "失败维度要单独点名");
    assert.match(seen, /COMPILE\(CloudBuild2\.0\)/, "点名要带 job 便于定位");
    assert.match(seen, /CODECHECK\(CodeCCP2\.0\)/);
    assert.ok(!seen.includes("UT(unit-test)"), "过了的维度不许混进来");
    assert.match(seen, /每一维都要收拾/, "得堵死'修细的那维就交差'");
    // 日志本身有真内容,不该被"无证据"判据误伤
    assert.match(seen, /失败详情\(平台原文\)/);
    // 使命不许指挥内核没有的动作(2026-08-21 内网实锤,2026-08-25 瘦身
    // 后语义更新):交付主流程已不再签发 COMPILE/UT/CODECHECK 任务卡,
    // 原文让它"派专职子 agent",模型照做就在"要卡拿不到→生成被拒→
    // current 说在等流水线"之间空转。
    assert.match(seen, /不要找内核要 COMPILE\/UT\/CODECHECK 任务卡或派专职质量子 agent/,
      "得明说本轮没有质量任务卡可拿、不许派专职质量 agent");
    assert.ok(!/能派专职子 agent 的派专职去修/.test(seen),
      "旧话术会把模型支去撞内核的拦截");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("失败详情只是个链接:不派 Agent、不扣修复轮次并明确等人", async () => {
  // 内网实锤:适配层把 log 填成流水线页面链接(会话没有登录态打不开),
  // 使命却包装成"失败详情(平台原文)"——会话以为自己有输入,硬着头皮
  // 定位→修改→提交,看着专业实为猜改。证据缺席必须明说,会话的正确
  // 行为才成立:能自证的修,不能自证的写诊断停下喊人。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  // 内网真实形态:标签 + 链接。第一版判据只认裸链接,正好漏掉它
  // (2026-08-21 读进场报告逮住)——用真实形态当裁判,别用理想形态。
  platform.nextPipelineLog =
    "FAILED stage=CodeCCP2.0 job=CodeCCP2.0  detail: "
    + "https://codeccp.tool.corp/tasks/44944736";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-blind-"));
  const model = mrModel([
    ...walkScript(),
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { pollTimeoutMs: 0 });
  try {
    const id = service.create("交付 REQ9:无证据修复").id;
    // 取证预算立即收口：没有可靠输入时连修复会话都不开。
    await until(() =>
      service.get(id)!.delivery?.evidence_gap?.state === "waiting_human",
      "无据时应如实等人工回灌");
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop, undefined,
      "没有派修就不能凭空产生或扣掉修复轮次");
    assert.match(task.delivery?.waiting_on ?? "", /批注.*平台报错原文/);
    assert.deepEqual(task.delivery?.evidence_gap?.missing_dimensions,
      ["COMPILE"]);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("检视意见开的是真 review 单:下单事实换交付方式,修完这轮就换回来", async () => {
  // 2026-08-20 查实的洞:内核的 end = "推送 + 流水线绿",云端的交付完成
  // = 合入。中间等合入这段冒出来的检视意见,原来是往**终态**工作区塞个
  // mission 重新入队——current 还停在 end,Hook 门禁整体旁路,这一轮改动
  // 没人裁决、没人记账,改完也不会被流水线复验。
  //
  // 内核对这段本来就有路,而且是机读契约:workflow_select 的 choices 里
  // 有 review,但 new_order_choices 没有它(「review 仅限已交付单」)。
  // 宿主该做的只有一件事:这一轮把下单事实的交付方式写成内核的
  // 「处理评审意见」,并在使命里让会话先 init --new 把单开出来。
  //
  // 本用例钉的是**宿主交出去的东西**(下单事实 + 使命),不是模型听不听话
  // ——剧本里的会话故意没有 init,那条路由内核门禁和催办各自兜着。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "success"); // 首跑红;修后绿
  platform.seedDiscussion({
    id: "d-1", file: "a.txt", line: 1, severity: "major",
    author: "李四", body: "这里的空指针要判一下",
  });
  platform.artifacts.push({
    name: "build_log_202.txt",
    text: "BUILD FAILURE: src/a.cpp:12: error: null guard missing",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-revorder-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'EOF'
[d-1]
意见成立,已补判空。
EOF` } } },
    { text: "检视意见处理完毕。" },
    { tool: { name: "bash", input: { command:
        "echo fixed >> a.txt && git add . && git commit --quiet -m fix" } } },
    { text: "流水线问题已修并提交。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { resolveDiscussions: true });
  try {
    const id = service.create("交付 REQ9:检视轮换单", { lane: "完整开发" }).id;
    const workspace = service.get(id)!.workspace;
    const readOrder = (): Record<string, unknown> | undefined => {
      for (const name of readdirSync(workspace)) {
        const path = join(workspace, name, ".mae-flow-order.json");
        if (existsSync(path)) {
          try {
            return JSON.parse(readFileSync(path, "utf-8"));
          } catch { return undefined; }   // 半行=还在写,下一轮再看
        }
      }
      return undefined;
    };
    // 派检视修复这一轮:下单事实的交付方式换成内核的 review 原文。
    // 等的是文件内容不是 loop.kind——kind 先落、会话起来才重写事实。
    await until(() => readOrder()?.["交付方式"] === "处理评审意见",
      "检视轮的下单事实要换成「处理评审意见」");
    assert.equal(service.get(id)!.delivery?.loop?.kind, "review");
    // 单号/基线分支/工号必须原样沿用:内核按这三项派生分支名,沿用才
    // 派生出同一个 MR 分支,review 的 branch_create 于是原地冻结 HEAD
    // 当增量基点,不会另建分支。
    assert.equal(readOrder()?.["基线分支"], "master", "基线分支不许换");
    // 这一轮结束(CI 接棒)后必须换回本单原交付方式,否则下次重建会话
    // 会莫名其妙又开一张 review 单。
    await until(() => readOrder()?.["交付方式"] === "完整开发",
      "检视轮结束就换回本单原交付方式");
    assert.equal(service.get(id)!.delivery?.loop?.kind, "ci");
    await until(() => service.get(id)!.status === "await_merge", "绿灯");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /不要再次 init/, "宿主已机械开 review 新轮,不得让 Agent 重复 init");
    assert.match(seen, /受内核门禁和证据台账/, "得讲清新轮的作用,不然模型会另起裸流程");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("MR 未合入前本地批注可反复开启 review 轮，始终更新同一 MR", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-local-review-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `echo review-one >> a.txt; ${localReviewReceiptCommand("第一轮边界处理已完成")}` } } },
    { text: "第一轮本地检视意见已修改。" },
    { tool: { name: "bash", input: { command:
        `echo review-two >> a.txt; ${localReviewReceiptCommand("第二轮错误兜底已完成")}` } } },
    { text: "第二轮本地检视意见已修改。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:本地反复检视", { lane: "完整开发" }).id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const first = service.get(id)!;
    const mrUrl = first.delivery!.mr_url;
    const firstSha = first.delivery!.sha;

    const note1 = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "这里补上第一轮边界处理", kind: "code",
    });
    await service.sendAnnotations(id, [note1.id]);
    assert.equal(service.listAnnotations(id).items[0].sent_via, "review_repair");
    await closeWorkspaceReview(service, id, [note1]);
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery!.sha !== firstSha, "第一轮检视重新交付");
    const secondSha = service.get(id)!.delivery!.sha;

    const note2 = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 2,
      anchor: "review-one", note: "再补第二轮错误兜底", kind: "code",
    });
    await service.sendAnnotations(id, [note2.id]);
    await closeWorkspaceReview(service, id, [note2]);
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery!.sha !== secondSha, "第二轮检视重新交付");

    const final = service.get(id)!;
    assert.equal(final.delivery!.mr_url, mrUrl, "每轮都必须复用原 MR");
    assert.equal(platform.mergeRequests.length, 1, "不能重复创建 MR");
    assert.equal(platform.pipelines.length, 3, "每个新 SHA 都重新跑一次流水线");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /第一轮边界处理/);
    assert.match(seen, /第二轮错误兜底/);
    assert.match(seen, /不要再次 init/,
      "宿主已开 review 新轮，Agent 不得再撞一次 init");
    assert.match(seen, /交付方式用户已在下单时选定:处理评审意见/,
      "review 轮 prompt 与下单事实必须一致，不能再说原单完整开发");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("本地检视撞上 CI 修复时并入当前 Agent，不启动第二只抢工作区", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "success");
  platform.artifacts.push({
    name: "build_log.txt",
    text: "BUILD FAILURE: src/a.cpp:12: error: expected null guard",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-local-ci-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        "sleep 1; echo ci-and-review >> a.txt && git add a.txt && git commit --quiet -m fix; "
        + localReviewReceiptCommand("流水线与人工意见已合并处理") } } },
    { text: "流水线问题与人的检视意见已合并处理。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:CI 与本地检视并发").id;
    await until(() => service.get(id)!.status === "running"
      && service.get(id)!.delivery?.loop?.kind === "ci", "CI Agent 已开跑");
    const note = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "同时把空值返回改成明确错误", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);
    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.status === "await_merge", "合并修改后绿灯");

    assert.equal(service.listAnnotations(id).items[0].sent_via, "review_repair");
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(platform.pipelines.length, 2,
      "人的意见并入当前 CI 提交，只应为新 SHA 再跑一条流水线");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /空值返回改成明确错误/);
    assert.match(seen, /优先级高于正在进行的流水线修复/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("流水线绿后仍持续监听：同一 MR 后续转红会自动修复并重验", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("success", "failed", "success");
  platform.nextPipelineLog = "BUILD FAILURE: late gate regression";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-green-watch-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        "sleep 0.5; echo late-fix >> a.txt && git add a.txt && git commit --quiet -m fix" } } },
    { text: "后续流水线回红已修复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:绿灯后继续监听").id;
    await until(() => service.get(id)!.status === "await_merge", "第一条流水线绿灯");
    const firstSha = service.get(id)!.delivery!.sha!;

    const late = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST",
      body: JSON.stringify({ sha: firstSha }),
    });
    assert.equal(late.status, 201);

    await until(() => service.get(id)!.delivery?.loop?.kind === "ci"
      && service.get(id)!.status === "running", "绿后回红自动派修");
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery?.sha !== firstSha, "修复后重新绿灯");
    assert.equal(platform.pipelines.length, 3,
      "首绿、后续回红、新提交复验三条流水线都要被看见");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("下单表单不列 review,但修复环问得到它的选项原文", () => {
  // 两个调用方对同一份内核目录的取法必须分开:表单只能列新单可选的
  // (选 review 会跳过设计与定稿还不碰规格,必错),而修复环要的恰恰
  // 是被滤掉的那个。谁也不许在 TS 侧写死"处理评审意见"。
  const labels = workflowChoices(KERNEL_ROOT).map((item) => item.label);
  assert.ok(labels.includes("完整开发"), "表单要列新单可选的");
  assert.ok(!labels.includes("处理评审意见"), "表单不许列 review");
  assert.equal(workflowLabel(KERNEL_ROOT, "review"), "处理评审意见");
  assert.equal(workflowLabel(undefined, "review"), "",
    "问不到内核就回空串,调用方 fail-open 回本单原交付方式");
});

test("MR 被关闭不算任务结束：持续监听，重开后恢复，用户可主动停止", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-closed-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:被关单").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    platform.settleMr("master_bot_REQ9", "closed");
    await until(() => service.get(id)!.delivery?.mr_state === "已关闭", "识别关闭");
    assert.equal(service.get(id)!.status, "await_merge", "关闭不是任务终态");
    assert.match(service.get(id)!.detail ?? "", /继续监听/);

    platform.mergeRequests[0].merge_state = "opened";
    await until(() => service.get(id)!.delivery?.mr_state === "等待合入", "重开后恢复");
    assert.match(service.get(id)!.detail ?? "", /重新打开/);

    const stopped = await service.cancel(id, "tester");
    assert.equal(stopped.status, "canceled", "MR 合入前用户始终可以主动停止");
    assert.throws(() => service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "停止后不应再新增", kind: "code",
    }), /用户停止/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("自动修复关闭只停修复不停监控：人工处理后仍能识别合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-watch-only-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(), {
    repairRounds: 0,
  });
  try {
    const id = service.create("交付 REQ9:只监控不自动修").id;
    await until(() => service.get(id)!.status === "await_merge", "先到等待合入");
    platform.conflictGate = true;
    await until(() => (service.get(id)!.delivery?.waiting_on ?? "")
      .includes("自动修复已关闭"), "明确提示人工处理红门禁");
    assert.equal(service.get(id)!.status, "await_merge");

    platform.conflictGate = false;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed",
      "人工处理后监控仍在并识别合入");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
