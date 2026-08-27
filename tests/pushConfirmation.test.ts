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

    assert.equal((service as any).autoAnswerFor(internal, true), undefined,
      "月光免审批不得代答用户显式要求的 push 前确认卡");

    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: {
        [(waiting.question as any).questions[0].question]:
          "需要调整代码（按清单返工）",
      },
      delivery_paths: ["src/feature.ts"],
      notes: "extra.ts 是误提交,移出去",
    });
    const summary = service.get(id)!;
    assert.equal(summary.delivery_selection?.status, "requested");
    assert.deepEqual(summary.delivery_selection?.paths, ["src/feature.ts"]);
    assert.equal(summary.status, "queued", "返工走修复会话,不是原地卡死");
    assert.match(String(internal.mission), /mae-flow-delivery-selection\/1/);
    assert.match(String(internal.mission), /只交付以下 1 个文件/);
    assert.match(String(internal.mission), /extra\.ts 是误提交/);
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

test("开关的边界:已推送后不能再开;等卡时关掉=作废卡继续推", async () => {
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
