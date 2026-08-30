/**
 * push 前人工确认(commit 前人工介入的云端落点):
 * 瘦身后的主链没有中途检视卡,想在交付前亲眼核对清单的人从这里看。
 * 契约:默认关零打扰;开着时宿主在 prepush 收敛后挂云端原生 diff 卡;
 * 确认授权文件集合，同文件修复产生新 HEAD 自动续推，增删/重命名文件
 * 才重新举卡；返工开修复会话并携带清单契约；月光不代答这张卡。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-push-confirm-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "feature.ts"), "export const value = 1;\n");
  git("add", "src/feature.ts");
  git("commit", "--quiet", "-m", "task result");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: baseline },
  }));
  return { cwd, git };
}

async function verifyingTask() {
  const model = new ScriptedModelServer([
    { text: "编码完成。" }, { text: "返工完成。" }, { text: "备用。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-push-confirm-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("push 前确认演练").id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口");
  const repo = repository();
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  internal.summary.status = "verifying";
  return { service, model, id, internal, repo };
}

test("确认绑定文件集合:同文件修复自动续推,新增文件才重新确认", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    const gate = () => (service as any)
      .pushConfirmationSatisfied(internal, "master_bot_REQ1");
    assert.equal(await gate(), true, "开关默认关,闸门必须放行");

    internal.summary.push_confirmation = true;
    assert.equal(await gate(), false, "开着且未确认,必须拦下出卡");
    const waiting = service.get(id)!.waiting!;
    assert.equal(waiting.step, "cloud_push_confirm");
    assert.equal(service.get(id)!.status, "waiting_for_human");
    assert.equal(waiting.recommended_view, "diff",
      "云端原生卡要给 diff 检视面,勾选 UI 才会开放");
    assert.match(String(waiting.context), /src\/feature\.ts/);
    const options = (waiting.question as any).questions[0].options as string[];
    assert.ok(options.some((option) => option.includes("确认按清单推送")));
    assert.ok(options.some((option) => option.includes("按清单返工")));

    assert.equal(await gate(), false);
    assert.equal(service.get(id)!.waiting!.waiting_id, waiting.waiting_id,
      "同 HEAD 不重复出卡(call_id 幂等,重启也只有一张)");

    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: {
        [(waiting.question as any).questions[0].question]: "确认按清单推送",
      },
    });
    const summary = service.get(id)!;
    assert.equal(summary.waiting, undefined);
    assert.equal(summary.delivery_selection?.status, "confirmed");
    assert.deepEqual(summary.delivery_selection?.paths, ["src/feature.ts"],
      "没显式勾选=按当前 commit 全量确认");
    assert.equal(summary.delivery_selection?.head,
      repo.git("rev-parse", "HEAD"));
    assert.equal(await gate(), true, "已确认且 HEAD 未变,放行");

    // 流水线自动修复已确认文件：HEAD 变化但交付边界没变，不应打断人。
    writeFileSync(join(repo.cwd, "src", "feature.ts"),
      "export const value = 2;\n");
    repo.git("add", "src/feature.ts");
    repo.git("commit", "--quiet", "-m", "repair confirmed file");
    internal.summary.status = "verifying";
    assert.equal(await gate(), true, "同一文件集合的新 HEAD 应复用确认");
    assert.equal(service.get(id)!.waiting, undefined);
    assert.notEqual(summary.delivery_selection?.head,
      repo.git("rev-parse", "HEAD"), "确认时 HEAD 只作审计锚，不伪造二次确认");

    // 修复越过已确认边界新增文件：必须按最新范围重新举卡。
    writeFileSync(join(repo.cwd, "src", "fix.ts"), "export const fix = 1;\n");
    repo.git("add", "src/fix.ts");
    repo.git("commit", "--quiet", "-m", "prepush fix");
    internal.summary.status = "verifying";
    assert.equal(await gate(), false, "交付文件集合变化必须重新确认");
    const renewed = service.get(id)!.waiting!;
    assert.notEqual(renewed.waiting_id, waiting.waiting_id);
    assert.match(String(renewed.context), /src\/fix\.ts/);
  } finally {
    await model.stop();
  }
});

test("修复重新带入已拒绝文件时宿主自动收口，不新增循环门禁", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    // 先让构建日志真实出现在可选现场，再由用户明确排除。
    writeFileSync(join(repo.cwd, "build.log"), "local build output\n");
    internal.summary.push_confirmation = true;
    await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1");
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: {
        [(waiting.question as any).questions[0].question]: "确认按清单推送",
      },
      delivery_paths: ["src/feature.ts"],
    });
    const cleanHead = repo.git("rev-parse", "HEAD");
    internal.summary.delivery = {
      git_push: {
        sha: cleanHead,
        ref: "refs/heads/master_bot_REQ1",
        remote: "origin",
        url: "https://git.example.test/repo.git",
      },
      sha: cleanHead,
      pipeline: "failed",
    };

    // 模拟流水线修复：业务修复是对的，但顺手强制提交了用户拒绝的日志
    // 与中心注入 Skill。两者都不能靠再加一张卡/再撞一次 Agent 门禁。
    writeFileSync(join(repo.cwd, "src", "feature.ts"),
      "export const value = 2;\n");
    mkdirSync(join(repo.cwd, ".claude", "skills", "center"), {
      recursive: true,
    });
    writeFileSync(join(repo.cwd, ".claude", "skills", "center", "SKILL.md"),
      "center injected\n");
    repo.git("add", "-f", "src/feature.ts", "build.log",
      ".claude/skills/center/SKILL.md");
    repo.git("commit", "--quiet", "-m", "repair plus rejected files");
    assert.notEqual(repo.git("rev-list", "HEAD", "--", "build.log"), "");
    assert.notEqual(repo.git("rev-list", "HEAD", "--",
      ".claude/skills/center/SKILL.md"), "");

    const result = await (service as any)
      .reconcileConfirmedDeliveryBoundary(internal);
    assert.equal(result, "changed");
    assert.equal(repo.git("rev-parse", "HEAD^"), cleanHead,
      "机械收口以最近一次已推送的干净 SHA 为锚，不重写远端旧历史");
    assert.deepEqual(
      repo.git("diff", "--name-only",
        repo.git("rev-list", "--max-parents=0", "HEAD"), "HEAD")
        .split("\n").filter(Boolean),
      ["src/feature.ts"],
    );
    assert.equal(repo.git("rev-list", "HEAD", "--", "build.log"), "",
      "拒绝文件不能只在最终树删除，污染提交也必须从可达历史消失");
    assert.equal(repo.git("rev-list", "HEAD", "--",
      ".claude/skills/center/SKILL.md"), "");
    assert.equal(repo.git("check-ignore", "build.log"), "build.log",
      "已拒绝的未跟踪过程件登记到 clone 本地 exclude，后续修复不再看见");
    assert.equal(service.get(id)!.waiting, undefined,
      "机械清理既有拒绝项不会再次打扰用户");
  } finally {
    await model.stop();
  }
});

test("交付范围确认只在 prepush 收敛后执行", async () => {
  const { service, model, internal } = await verifyingTask();
  try {
    const order: string[] = [];
    internal.summary.delivery = {
      loop: { round: 2, kind: "ci", state: "repairing" },
    };
    internal.mission = undefined;
    (service as any).options.host = {};
    (service as any).effectivePlatformUrl = () => "https://git.example.test";
    (service as any).preparePush = async () => {
      assert.equal(internal.summary.delivery.loop.state, "verifying",
        "修复会话收口后必须先退出 repairing 再进入 prepush");
      order.push("prepush");
      return true;
    };
    (service as any).pushConfirmationSatisfied = async () => {
      order.push("confirm");
      return false;
    };
    (service as any).deliverySelectionAllowsPush = async () => {
      order.push("selection");
      return true;
    };

    await (service as any).tryDeliver(internal, internal.controlEpoch);
    assert.deepEqual(order, ["prepush", "confirm"],
      "不得在 prepush 之前先举一次确认卡");
    assert.equal(internal.summary.delivery.loop.state, "verifying");
  } finally {
    await model.stop();
  }
});

test("返工开修复会话并携带清单契约;月光不代答确认卡", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    internal.summary.push_confirmation = true;
    writeFileSync(join(repo.cwd, "src", "extra.ts"), "export const x = 1;\n");
    repo.git("add", "src/extra.ts");
    repo.git("commit", "--quiet", "-m", "extra file");
    await (service as any).pushConfirmationSatisfied(internal, "master_bot_REQ1");
    const waiting = service.get(id)!.waiting!;
    const annotation = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "src/feature.ts",
      line: 1, anchor: "export const value = 1;",
      note: "这里必须补上异常分支测试", kind: "code",
    });
    const alreadySent = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "src/feature.ts",
      line: 1, anchor: "export const value = 1;",
      note: "提前提过的重试边界也不能丢", kind: "code",
    });
    (service as any).annotations(internal).markSent(
      [alreadySent.id], "interrupt");

    assert.equal((service as any).autoAnswerFor(internal, true), undefined,
      "月光免审批不得代答用户显式要求的 push 前确认卡");

    await service.decide(id, {
      waiting_id: waiting.waiting_id,
      state_version: waiting.state_version,
      selected_options: {
        [(waiting.question as any).questions[0].question]:
          "需要调整代码（按清单返工）",
      },
      delivery_paths: ["src/feature.ts"],
      notes: "extra.ts 是误提交,移出去",
      // 模拟小鲁班回复：只有选项与说明，不携带网页内部 annotation_ids。
    });
    const summary = service.get(id)!;
    assert.equal(summary.delivery_selection?.status, "requested");
    assert.deepEqual(summary.delivery_selection?.paths, ["src/feature.ts"]);
    assert.equal(summary.status, "queued", "返工走修复会话,不是原地卡死");
    assert.match(String(internal.mission), /mae-flow-delivery-selection\/1/);
    assert.match(String(internal.mission), /只交付以下 1 个文件/);
    assert.match(String(internal.mission), /extra\.ts 是误提交/);
    assert.match(String(internal.mission), /这里必须补上异常分支测试/,
      "push 确认没有挂起模型,批注必须显式进入返工使命");
    assert.match(String(internal.mission), /提前提过的重试边界也不能丢/,
      "返工是新会话，先前主动送达但未闭环的意见必须重新带入");
    const statuses = new Map(service.listAnnotations(id).items
      .map((item) => [item.id, item.status]));
    assert.equal(statuses.get(annotation.id), "sent");
    assert.equal(statuses.get(alreadySent.id), "sent");
  } finally {
    await model.stop();
  }
});

test("同一文件集合连续返工也要逐轮生成新卡,不能复活已决卡", async () => {
  const { service, model, id, internal } = await verifyingTask();
  try {
    internal.summary.push_confirmation = true;
    const gate = () => (service as any)
      .pushConfirmationSatisfied(internal, "master_bot_REQ1");
    await gate();
    const first = service.get(id)!.waiting!;
    // 这里只冻结队列，专门验证人工确认的逐轮身份；Agent 是否真改了
    // 内容不影响契约——用户打回这一事实本身就要求下一张新卡。
    (service as any).enqueueRepair = (task: any, mission: string, detail: string) => {
      task.mission = mission;
      task.summary.status = "queued";
      task.summary.detail = detail;
      (service as any).persist(task);
    };
    const rework = async (waiting: typeof first) => service.decide(id, {
      waiting_id: waiting.waiting_id,
      state_version: waiting.state_version,
      selected_options: {
        [(waiting.question as any).questions[0].question]:
          "需要调整代码（按清单返工）",
      },
    });

    await rework(first);
    internal.summary.status = "verifying";
    assert.equal(await gate(), false);
    const second = service.get(id)!.waiting!;
    assert.equal(second.status, "waiting");
    assert.notEqual(second.waiting_id, first.waiting_id,
      "返工后的同文件复审不能复用 resolved 的上一张卡");
    assert.equal(await gate(), false);
    assert.equal(service.get(id)!.waiting!.waiting_id, second.waiting_id,
      "同一轮等待期间再次过闸也必须保持同一张卡");

    await rework(second);
    internal.summary.status = "verifying";
    await gate();
    const third = service.get(id)!.waiting!;
    assert.equal(third.status, "waiting");
    assert.notEqual(third.waiting_id, second.waiting_id,
      "连续两次返工也不能撞回前一轮的已决卡");
  } finally {
    await model.stop();
  }
});

test("最终确认同一请求并发重放只消费一次,不会给成功者弹先到冲突", async () => {
  const { service, model, id, internal } = await verifyingTask();
  try {
    internal.summary.push_confirmation = true;
    await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1");
    const waiting = service.get(id)!.waiting!;
    const question = (waiting.question as any).questions[0].question;
    let deliveries = 0;
    (service as any).tryDeliver = async () => { deliveries += 1; };
    const input = {
      waiting_id: waiting.waiting_id,
      state_version: waiting.state_version,
      selected_options: { [question]: "确认按清单推送" },
    };

    const [first, replay] = await Promise.all([
      service.decide(id, input), service.decide(id, input),
    ]);
    assert.equal(first.waiting, undefined);
    assert.equal(replay.waiting, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1, "同一确认不能启动两条推送链");
  } finally {
    await model.stop();
  }
});

test("最终确认已落袋但概要未推进时,并发重放也只恢复一次", async () => {
  const { service, model, id, internal } = await verifyingTask();
  try {
    internal.summary.push_confirmation = true;
    await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1");
    const waiting = service.get(id)!.waiting!;
    const question = (waiting.question as any).questions[0].question;
    const answer = "确认按清单推送";
    internal.humanGate.resolve(waiting.waiting_id, {
      stateVersion: waiting.state_version,
      decision: answer,
      answers: { [question]: answer },
    });
    let deliveries = 0;
    (service as any).tryDeliver = async () => { deliveries += 1; };
    const input = {
      waiting_id: waiting.waiting_id,
      state_version: waiting.state_version,
      selected_options: { [question]: answer },
    };

    const [first, replay] = await Promise.all([
      service.decide(id, input), service.decide(id, input),
    ]);
    assert.equal(first.waiting, undefined);
    assert.equal(replay.waiting, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1, "resolved/task.json 分叉也不能启动两条推送链");
  } finally {
    await model.stop();
  }
});

test("最终确认恢复:waiting 已决但任务概要仍在等待时自动返工且批注不丢", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    internal.summary.push_confirmation = true;
    await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1");
    const waiting = service.get(id)!.waiting!;
    const question = (waiting.question as any).questions[0].question;
    const annotation = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "未提交改动", file: "src/feature.ts",
      line: 1, anchor: "export const value = 1;",
      note: "补齐超时异常的回归测试", kind: "code",
    });
    const annotationText = service.previewAnnotations(id, [annotation.id]);
    const selectionText = [
      '<delivery-selection schema="mae-flow-delivery-selection/1" mode="allowlist">',
      "用户通过文件勾选器确认：只交付以下 1 个文件。",
      "- src/feature.ts",
      "当前另有 0 个文件未勾选；它们不得进入提交。",
      "</delivery-selection>",
    ].join("\n");
    // 精确模拟线上旧版本的崩溃窗口：权威待办已经 resolved，但没有新
    // 版本 continuation；task.json 仍是 waiting，批注也没来得及 sent。
    internal.humanGate.resolve(waiting.waiting_id, {
      stateVersion: waiting.state_version,
      decision: "需要调整代码（按清单返工）",
      answers: { [question]: "需要调整代码（按清单返工）" },
      notes: `${selectionText}\n\n${annotationText}`,
    });
    await model.stop();

    const recovered = new TaskService({
      dataDir: service.options.dataDir,
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    });
    const result = recovered.recover();
    assert.equal(result.requeued, 1);
    const resumed = await until(() => {
      const task = recovered.get(id);
      return task?.status === "queued" ? task : undefined;
    }, "已决 push 卡恢复为返工队列");
    assert.equal(resumed.waiting, undefined);
    assert.deepEqual(resumed.delivery_selection?.paths, ["src/feature.ts"]);
    assert.equal(resumed.delivery_selection?.status, "requested");
    assert.match(String((recovered as any).tasks.get(id).mission),
      /补齐超时异常的回归测试/);
    assert.equal(recovered.listAnnotations(id).items[0].status, "sent",
      "旧记录没有 annotation_ids 时也要从已落袋原文精确恢复送达状态");
    void repo;
  } finally {
    await model.stop();
  }
});

test("个人默认(缺省即开)驱动闸门:没有任务级设置也举卡", async () => {
  const { service, model, id, internal } = await verifyingTask();
  try {
    // serve 接的是 LocalAuth.pushConfirmationEnabled;这里直接注入
    // 同签名回调,契约一致:按归属人现读现判。
    (service as any).options.pushConfirmation = () => true;
    const gate = () => (service as any)
      .pushConfirmationSatisfied(internal, "master_bot_REQ1");
    assert.equal(await gate(), false, "个人默认开=真人任务必须举卡");
    assert.equal(service.get(id)!.waiting!.step, "cloud_push_confirm");
  } finally {
    await model.stop();
  }
});

test("LocalAuth 个人默认:真人缺省即开,显式关才关;无账号不举卡", async () => {
  const { LocalAuth } = await import("../src/auth.ts");
  const { mkdtempSync } = await import("node:fs");
  const auth = new LocalAuth(
    join(mkdtempSync(join(tmpdir(), "mfc-push-auth-")), "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("dev", "developer-pass-1", "developer");
  assert.equal(auth.pushConfirmationEnabled("dev"), true,
    "用户拍板:push 前确认默认开启");
  auth.setPushConfirmation("dev", false);
  assert.equal(auth.pushConfirmationEnabled("dev"), false);
  auth.setPushConfirmation("dev", true);
  assert.equal(auth.pushConfirmationEnabled("dev"), true);
  assert.equal(auth.pushConfirmationEnabled(undefined), false,
    "无账号链路(probe/pilot/未接登录)不举卡,自动化不被卡死");
});

test("开关的边界:已推送后不能再开;普通等卡可关闭", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    internal.summary.status = "await_merge";
    assert.throws(() => service.setPushConfirmation(id, true),
      (error) => error instanceof TaskControlError
        && /确认点已经过去/.test(error.message));

    internal.summary.status = "verifying";
    service.setPushConfirmation(id, true);
    await (service as any).pushConfirmationSatisfied(internal, "master_bot_REQ1");
    assert.equal(service.get(id)!.status, "waiting_for_human");
    void repo;
    const off = service.setPushConfirmation(id, false);
    assert.equal(off.push_confirmation, undefined);
    assert.equal(off.waiting, undefined, "人说不看了,卡必须作废");
    assert.equal(off.status, "verifying", "关掉开关要继续推,不许悬在等待");
  } finally {
    await model.stop();
  }
});

test("人工意见修复后同文件也必须复检；逐条闭环后可正常推送", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    const head = repo.git("rev-parse", "HEAD");
    internal.summary.luban_account = "owner";
    internal.summary.delivery_selection = {
      paths: ["src/feature.ts"],
      observed_paths: ["src/feature.ts"],
      excluded_paths: [],
      status: "confirmed",
      waiting_id: "old-confirmation",
      head,
      updated_at: new Date().toISOString(),
    };
    const first = service.addAnnotation(id, {
      author: "reviewer-a", artifact: "本任务变更", file: "src/feature.ts",
      line: 1, anchor: "export const value = 1;",
      note: "补上空值处理", kind: "code",
    });
    const second = service.addAnnotation(id, {
      author: "reviewer-b", artifact: "本任务变更", file: "src/feature.ts",
      line: 1, anchor: "export const value = 1;",
      note: "补上边界测试", kind: "code",
    });
    (service as any).annotations(internal).markSent(
      [first.id, second.id], "review_repair");
    internal.summary.delivery = {
      loop: {
        round: 0,
        state: "verifying",
        kind: "review",
        review_source: "workspace",
        workspace_review_recheck_required: true,
        workspace_review_annotation_ids: [first.id, second.id],
        review_ids: "workspace:cycle-1",
      },
    };

    assert.equal(await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1"), false,
    "修改来源是人工意见时，即使文件集合没变也不能复用旧确认");
    const waiting = service.get(id)!.waiting!;
    assert.notEqual(waiting.waiting_id, "old-confirmation");
    assert.match(String(waiting.context), /人工意见修改后的复检/);
    assert.match(String(waiting.context), /还有 2 条待提出人确认/);
    const question = (waiting.question as any).questions[0].question;
    const accept = {
      waiting_id: waiting.waiting_id,
      state_version: waiting.state_version,
      selected_options: { [question]: "确认按清单推送" },
    };

    await assert.rejects(service.decide(id, accept),
      (error) => error instanceof TaskControlError
        && /责任人的“继续提交”不能代替意见提出人确认/.test(error.message));
    assert.equal(service.get(id)!.waiting!.waiting_id, waiting.waiting_id,
      "越权放行必须零副作用，不能把原卡改旧造成后续假死");
    assert.equal(service.get(id)!.delivery_selection?.waiting_id,
      "old-confirmation", "拒绝前不能先改交付清单收据");
    assert.throws(() => service.verifyAnnotation(id, first.id, "owner"),
      /只能由他裁决/);
    assert.throws(() => service.setPushConfirmation(id, false),
      /不能关闭确认绕过/);

    service.verifyAnnotation(id, first.id, "reviewer-a");
    await assert.rejects(service.decide(id, accept),
      (error) => error instanceof TaskControlError && /仍有 1 条/.test(error.message));
    service.verifyAnnotation(id, second.id, "reviewer-b");
    assert.match(String(service.get(id)!.detail), /已全部闭环/);

    let deliveries = 0;
    (service as any).tryDeliver = async () => { deliveries += 1; };
    await service.decide(id, accept);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries, 1, "意见全部闭环后必须真正续推，不能卡在旧卡/旧 SHA");
    assert.equal(service.get(id)!.waiting, undefined);
    assert.equal(internal.summary.delivery.loop
      .workspace_review_recheck_required, false);
  } finally {
    await model.stop();
  }
});

test("卡键绑文件集合:等卡时 HEAD 演进不换卡;重举卡增量优先;有清单即举卡", async () => {
  const { service, model, id, internal, repo } = await verifyingTask();
  try {
    const gate = () => (service as any)
      .pushConfirmationSatisfied(internal, "master_bot_REQ1");
    internal.summary.push_confirmation = true;
    assert.equal(await gate(), false, "未确认先出卡");
    const first = service.get(id)!.waiting!;

    // 人还在看卡,流水线修复推进了 HEAD 但清单没变:卡不能被作废重发
    // (老实现绑 HEAD,每个中间 commit 都轰一遍人——鸡毛当令箭)。
    writeFileSync(join(repo.cwd, "src", "feature.ts"),
      "export const value = 9;\n");
    repo.git("add", "src/feature.ts");
    repo.git("commit", "--quiet", "-m", "mid-review repair");
    assert.equal(await gate(), false);
    assert.equal(service.get(id)!.waiting!.waiting_id, first.waiting_id,
      "同一文件集合,等待中的卡必须原地保留");

    await service.decide(id, {
      state_version: service.get(id)!.waiting!.state_version,
      selected_options: {
        [(first.question as any).questions[0].question]: "确认按清单推送",
      },
    });
    assert.equal(service.get(id)!.delivery_selection?.status, "confirmed");

    // 修复新增文件 → 重新举卡,正文先说增量,人不用整单重看。
    writeFileSync(join(repo.cwd, "src", "fix.ts"), "export const fix = 1;\n");
    repo.git("add", "src/fix.ts");
    repo.git("commit", "--quiet", "-m", "repair adds file");
    internal.summary.status = "verifying";
    assert.equal(await gate(), false, "集合变化必须重新确认");
    const renewed = service.get(id)!.waiting!;
    assert.match(String(renewed.context), /较上次已确认的清单/);
    assert.match(String(renewed.context), /新增 src\/fix\.ts/);
    assert.match(String(renewed.context), /1 个文件与上次确认一致/);

    // 任务级/个人默认都缺省,但用户已提交过清单:复核不一致时回到卡
    // 上重新确认,而不是把任务判 failed(死胡同改出路)。
    internal.summary.push_confirmation = undefined;
    internal.summary.waiting = undefined;
    assert.equal(await gate(), false, "有清单在管范围,缺省也要举卡");
    assert.equal(service.get(id)!.waiting!.step, "cloud_push_confirm");
  } finally {
    await model.stop();
  }
});
