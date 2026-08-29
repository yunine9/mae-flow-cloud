/** 文件级交付清单：界面隐藏只是视图，真正的勾选必须绑定 Git 事实，
 * 返工时进入 Agent 上下文，push 前还要重新核对。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";

async function until<T>(
  probe: () => T | undefined,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository(options: { commitArtifact?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-delivery-selection-"));
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
  mkdirSync(join(cwd, "target", "classes"), { recursive: true });
  writeFileSync(join(cwd, "target", "classes", "Feature.class"), "bytecode");
  git("add", "src/feature.ts");
  if (options.commitArtifact) git("add", "target/classes/Feature.class");
  git("commit", "--quiet", "-m", "task result");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  return { cwd, git };
}

function kernel(): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-delivery-kernel-"));
  mkdirSync(join(root, "flow"));
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        choices: ["continue", "revise"],
        choice_answers: {
          continue: ["代码无需调整，继续提交"],
          revise: ["需要调整代码（按清单返工）"],
        },
        next: { continue: "commit", revise: "rework" },
      },
      commit: {},
      rework: { allow_source_edit: true },
    },
  }));
  return root;
}

async function waitingService(repo: ReturnType<typeof repository>) {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "这轮代码通过吗？",
      options: ["代码无需调整，继续提交", "需要调整代码（按清单返工）"],
    }] } } },
    { text: "收到清单。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-delivery-task-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("按文件确认交付").id;
  await until(() => service.get(id)?.status === "waiting_for_human"
    ? true : undefined, "任务等待代码检视");
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  // 待办与通知保存面向人的本地化标题；宿主必须从 pulse 的稳定步骤 ID
  // 读取内核契约，不能拿中文标题去查 flow.json。
  internal.summary.waiting.step = "最终代码增量检视";
  mkdirSync(join(repo.cwd, ".mae-flow-work"), { recursive: true });
  writeFileSync(join(repo.cwd, ".mae-flow-work", "panel-pulse.js"),
    "window.__panelPulse={\"step\":\"inspect\",\"step_title\":\"最终代码增量检视\",\"phase\":\"交付\",\"revision\":1};\n");
  writeFileSync(join(repo.cwd, ".mae-flow-work", "panel.html"),
    '<span class="phase-node current">交付</span>');
  (service.options as any).host = { kernelRoot: kernel(), repoPath: "/unused" };
  return { service, model, id, internal };
}

test("未跟踪编译产物可不勾选，确认清单只绑定 HEAD 会推送的源码", async () => {
  const repo = repository();
  const { service, model, id, internal } = await waitingService(repo);
  try {
    const waiting = service.get(id)!.waiting!;
    assert.equal(waiting.recommended_view, "diff");
    assert.equal(service.get(id)!.progress?.step_id, "inspect");
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "代码无需调整，继续提交" },
      delivery_paths: ["src/feature.ts"],
    });
    assert.equal(service.get(id)?.delivery_selection?.status, "confirmed");
    assert.deepEqual(service.get(id)?.delivery_selection?.paths,
      ["src/feature.ts"]);
    assert.deepEqual(service.get(id)?.delivery_selection?.excluded_paths,
      ["target/classes/Feature.class"]);

    writeFileSync(join(repo.cwd, "src", "extra.ts"), "export const extra = 1;\n");
    repo.git("add", "src/extra.ts");
    repo.git("commit", "--quiet", "-m", "late unreviewed file");
    assert.equal(await (service as any).deliverySelectionAllowsPush(internal), false);
    assert.equal(service.get(id)?.status, "failed");
    assert.match(service.get(id)?.detail ?? "", /新增了未确认文件 src\/extra\.ts/);
  } finally {
    await model.stop();
  }
});

test("勾选与 commit 不同也能直接通过:宿主机械整理提交并绑用户跳过直推", async () => {
  // 用户拍板(2026-08-28):清单调整是机械活,不打回 Agent 也不重编;
  // 且剔除≠销毁——退出提交,工作区内容原样保留。
  const repo = repository({ commitArtifact: true });
  const { service, model, id, internal } = await waitingService(repo);
  try {
    // 基线里就有的文件被改过并已提交——剔除它时最容易被"直接回退"
    // 误伤,专门验内容保留。
    writeFileSync(join(repo.cwd, "README.md"), "baseline\nagent 补的注记\n");
    repo.git("add", "README.md");
    repo.git("commit", "--quiet", "-m", "agent touches readme");
    const before = repo.git("rev-parse", "HEAD");
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "代码无需调整，继续提交" },
      delivery_paths: ["src/feature.ts"],
    });
    const selection = service.get(id)?.delivery_selection;
    assert.equal(selection?.status, "confirmed");
    assert.deepEqual(selection?.paths, ["src/feature.ts"]);

    // 宿主补了整理提交:未勾选的退出 commit,清单绑定新 HEAD。
    const after = repo.git("rev-parse", "HEAD");
    assert.notEqual(after, before, "整理必须落成新提交,不许改写历史");
    assert.equal(selection?.head, after);
    assert.match(repo.git("log", "-1", "--format=%s"),
      /按最终人工检视整理交付清单/);
    assert.equal(
      repo.git("ls-files", "--", "target/classes/Feature.class"), "",
      "被剔除的新增产物必须退出索引");
    assert.equal(repo.git("show", "HEAD:README.md"), "baseline",
      "交付的 README 必须是基线内容");

    // 剔除≠销毁:两个被剔除文件的内容都还在工作区。
    assert.ok(existsSync(join(repo.cwd, "target/classes/Feature.class")),
      "新增产物退出索引后文件仍在现场");
    assert.equal(
      readFileSync(join(repo.cwd, "README.md"), "utf-8"),
      "baseline\nagent 补的注记\n",
      "被剔除的改动保留为未暂存内容,不许物理回退");

    // 已确认剔除的路径不算脏账,后续 prepush 轮不被它们绊倒。
    const dirty = await (service as any).prePushDirtyPaths(internal);
    assert.ok(!dirty.includes("README.md")
      && !dirty.includes("target/classes/Feature.class"),
      `拍板剔除的路径不应出现在脏区: ${dirty.join(", ")}`);

    // 不重编:新 HEAD 绑用户跳过,编译与 UT 交流水线裁决,账留痕。
    const prepush = service.get(id)?.delivery?.prepush;
    assert.equal(prepush?.state, "user_skipped");
    assert.equal(prepush?.sha, after);
    assert.match(prepush?.message ?? "", /流水线裁决/);
  } finally {
    await model.stop();
  }
});

test("选“需要调整”仍走返工:清单以 requested 进入 Agent 上下文", async () => {
  const repo = repository({ commitArtifact: true });
  const { service, model, id } = await waitingService(repo);
  try {
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "需要调整代码（按清单返工）" },
      delivery_paths: ["src/feature.ts"],
    });
    assert.equal(service.get(id)?.delivery_selection?.status, "requested");
    await until(() => model.requests.length >= 2 ? true : undefined,
      "交付清单进入 Agent 上下文");
    const requests = model.requests.map((request) => JSON.stringify(request)).join("\n");
    assert.match(requests, /mae-flow-delivery-selection\/1/);
    assert.match(requests, /只交付以下 1 个文件/);
    assert.match(requests, /src\/feature\.ts/);
  } finally {
    await model.stop();
  }
});
