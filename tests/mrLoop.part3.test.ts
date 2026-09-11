/**
 * MR 闭环 part 3/6:检视意见接续与本地 review 轮:feedback-open 沿用交付事实、未合入前反复开轮更新同一 MR。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import {
  makeSourceRepo,
  walkScript,
  localReviewReceiptCommand,
  feedbackReceiptCommand,
  buildService,
  mrModel,
  until,
  closeWorkspaceReview,
} from "./mrLoop.helpers.ts";


test("检视意见沿用原交付事实:feedback-open 接续且不换单", async () => {
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
        `echo fixed >> a.txt; ${feedbackReceiptCommand("流水线空指针已修复")}` } } },
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
    await until(() => service.get(id)!.delivery?.loop?.kind === "review",
      "检视反馈进入统一循环");
    assert.equal(service.get(id)!.delivery?.loop?.kind, "review");
    assert.equal(readOrder()?.["基线分支"], "master", "基线分支不许换");
    assert.equal(readOrder()?.["交付方式"], "完整开发",
      "持续反馈不是一张新单，首次交付事实始终不改写");
    await until(() => service.get(id)!.delivery?.loop?.kind === "ci",
      "检视后由流水线反馈接棒");
    assert.equal(service.get(id)!.delivery?.loop?.kind, "ci");
    await until(() => service.get(id)!.status === "await_merge", "绿灯");
    const seen = model.requests.slice(1)
      .map((request) => (request as any).messages?.at(-1))
      .map((message: any) => JSON.stringify(message?.content ?? ""))
      .join("\n");
    assert.match(seen, /feedback_triage|当前反馈步骤/,
      "修复会话必须从正式反馈步骤接续");
    assert.doesNotMatch(seen, /当前步骤:\s*(config_confirm|workflow_select)/,
      "MR 后返工不得回到开场配置");
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
    await until(() => service.get(id)!.feedback?.some((item) =>
      item.source === "workspace"
      && item.source_id === note1.id
      && item.status === "awaiting_verification") ?? false,
    "Agent 回执不能越权关闭作者批注");
    await closeWorkspaceReview(service, id, [note1]);
    assert.equal(service.get(id)!.feedback?.find((item) =>
      item.source_id === note1.id)?.status, "closed",
    "只有批注作者确认后反馈才真正闭环");
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
    const seen = model.requests.slice(1)
      .map((request) => (request as any).messages?.at(-1))
      .map((message: any) => JSON.stringify(message?.content ?? ""))
      .join("\n");
    assert.match(seen, /第一轮边界处理/);
    assert.match(seen, /第二轮错误兜底/);
    assert.match(seen, /feedback_triage|当前反馈步骤/,
      "每轮批注都由正式反馈步骤接住");
    assert.doesNotMatch(seen, /当前步骤:\s*(config_confirm|workflow_select)/,
      "任何一轮返工都不得回到配置或选路");
  } finally {
    await model.stop();
    await platform.stop();
  }
});