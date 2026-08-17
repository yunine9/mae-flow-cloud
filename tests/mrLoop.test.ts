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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

/** 首跑剧本:预焙提交+推送+伪造内核终态(交付判定只看远端与状态文件)。 */
function walkScript(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "git config user.email bot@test && git config user.name bot && " +
        "git checkout --quiet -b master_bot_REQ9 && " +
        "echo change > a.txt && git add . && " +
        'git commit --quiet -m "feat: REQ9" && ' +
        "git push --quiet origin master_bot_REQ9 && " +
        `cat > .mae-flow.json <<'EOF'
{"schema_version": 2, "current": "end", "revision": 1,
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
): TaskService {
  return new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 120 },
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

test("检视优先于 CI;回复发布并标已解决;CI 接棒;合入收口", async () => {
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
    // CI 修复会话:推新提交
    { tool: { name: "bash", input: { command:
        "echo fixed >> a.txt && git add . && git commit --quiet -m fix "
        + "&& git push --quiet origin master_bot_REQ9" } } },
    { text: "流水线问题已修,已推送。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-"));
  const service = buildService(platform, dataDir, model.modelsJson());
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
    // 冲突修复会话:确认标记在,解掉,完成合并提交并推送
    { tool: { name: "bash", input: { command:
        "grep -q '<<<<<<<' a.txt && "
        + "printf 'change\\nupstream\\n' > a.txt && git add a.txt "
        + "&& git commit --quiet --no-edit && "
        + "git push --quiet origin master_bot_REQ9" } } },
    { text: "冲突已解,合并提交已推送。" },
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
