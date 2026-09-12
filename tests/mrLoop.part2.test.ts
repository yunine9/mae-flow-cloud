/**
 * MR 闭环 part 2/6:回复入队与回执:部分失败续投、Build-Fix 后入队绑 SHA、台账跨批继承、漏回执补交与只催一次。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import type { PrePushRunner } from "../src/prepushAgent.ts";
import {
  git,
  makeSourceRepo,
  walkScript,
  localReviewReceiptCommand,
  buildService,
  mrModel,
  until,
  closeWorkspaceReview,
} from "./mrLoop.helpers.ts";


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

test("MR 回复在 Build-Fix 后才入队，并绑定实际推送的最终 SHA", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-final-sha", file: "a.txt", line: 1, severity: "major",
    author: "甲", body: "请补上最终修复",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-final-sha-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
      `cat > ../review_replies.md <<'REPLY'
[d-final-sha]
已按意见修复，并由 Build-Fix 完成最终校验。
REPLY` } } },
    // 给测试宿主一个窗口模拟“普通检视 Agent 已提交 B”。真实 Agent
    // 会自己改码提交；这里用宿主写是为了不把用例耦合到 review 内核
    // 的命令门禁细节，本测试只钉 outbox 与 prepush 的时序。
    { tool: { name: "bash", input: { command:
      `node -e "setTimeout(()=>{},1500)"` } } },
    { text: "检视意见已处理。" },
  ], dataDir);
  await model.start();
  let shaBeforeBuildFix = "";
  let shaAfterBuildFix = "";
  let changedReviewRevision = false;
  const runner: PrePushRunner = async (request) => {
    // 首次交付时 MR 尚不存在；检视修复后的第二次 Build-Fix 再模拟
    // 专项 Agent 补一笔提交，证明回复不能提前绑定普通 Agent 的 HEAD。
    if (platform.mergeRequests.length > 0 && !changedReviewRevision) {
      changedReviewRevision = true;
      shaBeforeBuildFix = request.sha;
      writeFileSync(join(request.workspace, "prepush-final.txt"),
        "final build fix\n");
      git(request.workspace, "add", "prepush-final.txt");
      git(request.workspace, "commit", "--quiet", "-m", "prepush final fix");
      shaAfterBuildFix = git(request.workspace, "rev-parse", "HEAD");
      return {
        status: "passed", sha: shaAfterBuildFix,
        message: "Build-Fix 最终提交已通过",
      };
    }
    return { status: "passed", sha: request.sha, message: "Build-Fix 通过" };
  };
  const service = buildService(platform, dataDir, model.modelsJson(),
    { resolveDiscussions: true }, runner);
  try {
    const id = service.create("交付 REQ9:回复绑定最终 SHA").id;
    await until(() => existsSync(join(
      service.get(id)!.workspace, "review_replies.md")), "检视回复草稿落盘");
    const cwd = (service as any).tasks.get(id).cwd as string;
    writeFileSync(join(cwd, "review-fix.txt"), "ordinary review fix\n");
    git(cwd, "add", "review-fix.txt");
    git(cwd, "commit", "--quiet", "-m", "ordinary review fix");
    await until(() => platform.discussions[0].replies.length === 1
      || service.get(id)?.status === "failed"
      || service.get(id)?.delivery?.loop?.state === "halted",
    "最终 SHA push 后投递回复");
    assert.equal(platform.discussions[0].replies.length, 1,
      `回复未投递：${JSON.stringify({
        status: service.get(id)?.status,
        detail: service.get(id)?.detail,
        delivery: service.get(id)?.delivery,
      })}`);
    assert.ok(shaBeforeBuildFix && shaAfterBuildFix);
    assert.notEqual(shaBeforeBuildFix, shaAfterBuildFix,
      "测试前提：Build-Fix 必须在回复草稿之后产生新提交");
    const summary = service.get(id)!;
    const pushedSha = summary.delivery?.git_push?.sha;
    assert.ok(pushedSha);
    assert.notEqual(pushedSha, shaAfterBuildFix,
      "Build-Fix 的坏标题应在 push 前被安全 amend 成平台规范");
    assert.equal(git(cwd, "rev-parse", `${pushedSha}^{tree}`),
      git(cwd, "rev-parse", `${shaAfterBuildFix}^{tree}`),
      "自动修标题不能改变 Build-Fix 已验证的代码内容");
    const operations = readFileSync(join(
      summary.workspace, "delivery-outbox.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const enqueued = operations.filter((operation) =>
      operation.op === "enqueue"
      && operation.item?.payload?.discussion_id === "d-final-sha");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].item.payload.expected_sha, pushedSha,
      "outbox 必须绑定修正标题后实际推送的最终 SHA");
    assert.notEqual(enqueued[0].item.payload.expected_sha, shaBeforeBuildFix,
      "普通 Agent 收口时的中间 SHA 不得提前入队");
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

test("本地检视首次漏回执时原会话自动补交，不直接停机", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-receipt-repair-"));
  const model = mrModel([
    ...walkScript(),
    // 第一回合模拟真实事故：代码已经按意见改好，但没有留下机器回执。
    { tool: { name: "bash", input: { command:
        "echo reviewed >> a.txt" } } },
    { text: "检视意见已修改完成。" },
    // 宿主必须续用同一会话窄催办；第二回合只补回执，不重烧代码修改。
    { tool: { name: "bash", input: { command:
        localReviewReceiptCommand("已复核当前代码，意见已经落实") } } },
    { text: "逐条回执已补齐。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:缺回执自动恢复", { lane: "完整开发" }).id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const note = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "补上边界处理", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);

    await until(() => Boolean(service.listAnnotations(id).items[0]?.response),
      "原会话补齐逐条回执");
    const duringReview = service.get(id)!;
    assert.notEqual(duringReview.delivery?.loop?.state, "halted",
      "第一次漏回执是可恢复的协议疏漏，不得直接停机");
    assert.match(
      service.listAnnotations(id).items[0]?.response?.summary ?? "",
      /意见已经落实/);

    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.status === "await_merge", "补回执后正常交付");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /现在只补回执，不要重新修改代码/,
      "自动恢复必须是窄使命，不能让 Agent 重做检视修改");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("自动补回执仍失败时只催一次并保留现场", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-receipt-bounded-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command: "echo reviewed >> a.txt" } } },
    { text: "检视意见已修改，但忘了回执。" },
    // 第二回合仍不写，验证宿主不会无限 continueWith。
    { text: "本轮仍未写入回执。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:补回执有界", { lane: "完整开发" }).id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const note = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "补上边界处理", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);

    await until(() => service.get(id)!.delivery?.loop?.state === "halted",
      "自动补交一次后明确停下");
    const summary = service.get(id)!;
    assert.match(summary.detail ?? "", /自动补交逐条检视回执后仍未完成/);
    assert.match(summary.detail ?? "", new RegExp(note.id));
    const receiptNudges = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .filter((message: any) => JSON.stringify(message.content ?? "")
        .includes("现在只补回执，不要重新修改代码"));
    assert.equal(receiptNudges.length, 1, "同一批意见最多自动催补一次");
    assert.equal(existsSync(join(summary.workspace, "reviews",
      "local-annotations.json")), true, "停机后仍保留检视现场");
  } finally {
    await model.stop();
    await platform.stop();
  }
});