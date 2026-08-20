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

/** 首跑剧本:预焙提交+伪造内核终态；推送统一由宿主在会话释放后做。 */
function walkScript(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "git config user.email bot@test && git config user.name bot && " +
        "git checkout --quiet -b master_bot_REQ9 && " +
        "echo change > a.txt && git add . && " +
        'git commit --quiet -m "feat: REQ9" && ' +
        `cat > .mae-flow.json <<'EOF'
{"schema_version": 2, "current": "end", "revision": 1,
 "execution_contract": {"schema": "mae-flow-execution/1", "host": "cloud",
   "compile": "pipeline", "ut_write": "agent", "ut_run": "pipeline",
   "codecheck": "pipeline", "git_push": "host"},
 "config": {"分支名": "master_bot_REQ9", "基线分支": "master",
            "单号": "REQ9"}, "choices": {}, "history": []}
EOF` } } },
    { text: "交付完成。" },
  ];
}

function buildService(
  platform: FakeGitPlatform,
  dataDir: string,
  modelsJson: Record<string, unknown>,
  deliveryExtra: { resolveDiscussions?: boolean } = {},
): TaskService {
  return new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 120,
                ...deliveryExtra },
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

test("检视优先于 CI;回复发布并标已解决(显式开代 resolve);CI 接棒;合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "success"); // 首跑红;CI 修后绿
  platform.seedDiscussion({
    id: "d-1", file: "a.txt", line: 1, severity: "major",
    author: "张三", body: "这里要判空,别让缺失变量把模板炸了",
  });
  platform.artifacts.push(
    { name: "build_101.log", text: "BUILD FAILURE: 编译失败详情全文" });
  await platform.start();
  const model = new ScriptedModelServer([
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
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-"));
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
    await until(() => existsSync(join(workspace, "pipeline", "build_101.log")),
      "失败材料镜像到 pipeline/");
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
    assert.match(seen, /pipeline\/build_101\.log/, "落盘路径要交给修复会话");
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
  const model = new ScriptedModelServer([
    ...walkScript(),
    // 检视修复会话:解释类回复,不改代码
    { tool: { name: "bash", input: { command:
        `cat > ../review_replies.md <<'EOF'
[d-9]
命名保持与现有模块一致,暂不改;后续统一重命名时一起处理。
EOF` } } },
    { text: "检视意见已答复。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-ro-"));
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

test("等人门禁:挂起等待不派 agent,说清卡在哪;人批完合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.humanGates.approvers_passed = false; // 等审批
  await platform.start();
  const model = new ScriptedModelServer(walkScript());
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-wait-"));
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
  const model = new ScriptedModelServer([
    ...walkScript(),
    // 冲突修复会话:确认标记在,解掉,完成合并提交；宿主随后推送
    { tool: { name: "bash", input: { command:
        "grep -q '<<<<<<<' a.txt && "
        + "printf 'change\\nupstream\\n' > a.txt && git add a.txt "
        + "&& git commit --quiet --no-edit" } } },
    { text: "冲突已解并完成合并提交。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-cf-"));
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:解冲突").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
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
    await until(() => {
      const detail = service.get(id)!.detail ?? "";
      return service.get(id)!.status === "await_merge"
        || detail.includes("等新流水线");
    }, "解完回monitoring", 90_000);
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
  const model = new ScriptedModelServer([
    ...walkScript(),
    // 质量修复会话:改代码并提交，宿主随后推送
    { tool: { name: "bash", input: { command:
        "echo quality-fixed >> a.txt && git add . "
        + "&& git commit --quiet -m fix-quality" } } },
    { text: "质量问题已修并提交。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-19-"));
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

test("MR 被关闭 → 如实 failed 请人工,不硬修", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const model = new ScriptedModelServer(walkScript());
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-closed-"));
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:被关单").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    platform.settleMr("master_bot_REQ9", "closed");
    await until(() => service.get(id)!.status === "failed", "关闭即失败");
    assert.match(service.get(id)!.detail ?? "", /MR 被关闭/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});
