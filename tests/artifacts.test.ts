/**
 * 检视产物语义(只读旁路):工作区文件 → 可在决策处直接看的材料。
 *
 * 钉五件事:
 * - 列表按最近修改倒序(客观信号排序,不猜"哪步该看哪份");
 * - 未提交改动是虚拟产物:已暂存/未暂存/未跟踪都要在快照里;
 * - 白名单是唯一边界:集合外的 name 与 `../` 穿越一律不认;
 * - 超过 512 KB 只回传前 512 KB 并如实标注截断;
 * - fail-open:坏目录、空现场、非 git 仓都只让那一项缺席,不抛错。
 *
 * 不依赖 docker / PostgreSQL / 真模型——纯文件与本地 git。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DIFF_NAME,
  listArtifacts,
  readArtifact,
  resolveArtifactRoot,
  type ArtifactMeta,
} from "../src/artifacts.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

/** 造一个假工作区:<cwd>/.mae-flow-work/<单号>/*.md,可选 git 仓。 */
function makeSite(options: {
  docs?: Record<string, string>;
  /** 干扰目录(role-tasks 这类基础设施,不该被当成检视材料)。 */
  noise?: Record<string, string>;
  git?: boolean;
} = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-artifacts-"));
  const ticket = join(cwd, ".mae-flow-work", "REQ2026081405");
  mkdirSync(ticket, { recursive: true });
  writeFileSync(join(ticket, ".ticket-id"), "REQ2026081405");
  let stamp = new Date("2026-08-15T10:00:00Z").getTime() / 1000;
  for (const [name, body] of Object.entries(options.docs ?? {})) {
    const path = join(ticket, name);
    writeFileSync(path, body);
    // 逐个拉开修改时间,好断言排序:后写的更新。
    stamp += 60;
    utimesSync(path, stamp, stamp);
  }
  for (const [name, body] of Object.entries(options.noise ?? {})) {
    const dir = join(cwd, ".mae-flow-work", "role-tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (options.git) {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    run("init", "--quiet", "-b", "master");
    run("config", "user.email", "bot@test");
    run("config", "user.name", "bot");
    writeFileSync(join(cwd, "tracked.txt"), "第一版\n");
    run("add", ".");
    run("commit", "--quiet", "-m", "init");
  }
  return cwd;
}

const names = (items: ArtifactMeta[]) => items.map((item) => item.name);

test("列表按最近修改倒序;单号目录之外的噪声不混进来", () => {
  const cwd = makeSite({
    docs: {
      "survey.md": "# 现场勘察\n",
      "grill.md": "# 质询\n",
      "spec.md": "# 规格\n\n最后写的,应该排最前。\n",
    },
    noise: { "grill-critic-prep.md": "# 子 Agent 任务卡,不是检视材料\n" },
  });
  const items = listArtifacts(cwd);
  assert.deepEqual(names(items), [
    "REQ2026081405/spec.md",
    "REQ2026081405/grill.md",
    "REQ2026081405/survey.md",
  ]);
  assert.equal(items[0].label, "spec.md");
  assert.equal(items[0].kind, "doc");
  assert.ok(items[0].bytes > 0);
  assert.match(items[0].modified_at, /^\d{4}-\d{2}-\d{2}T/);

  const spec = readArtifact(cwd, "REQ2026081405/spec.md");
  assert.match(String(spec?.content), /最后写的/);
  assert.equal(spec?.truncated, false);
});

test("未提交改动:已暂存/未暂存/未跟踪都在快照里", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" }, git: true });
  writeFileSync(join(cwd, "tracked.txt"), "第二版:未暂存改动\n");
  writeFileSync(join(cwd, "staged.txt"), "暂存的新文件\n");
  execFileSync("git", ["-C", cwd, "add", "staged.txt"]);
  writeFileSync(join(cwd, "untracked.txt"), "没跟踪的新文件\n");

  const items = listArtifacts(cwd);
  const diff = items.find((item) => item.name === DIFF_NAME);
  assert.ok(diff, `未提交改动没出现: ${names(items).join(" | ")}`);
  assert.equal(diff!.kind, "diff");
  assert.equal(diff!.label, "工作区变更");
  assert.ok(diff!.bytes > 0);

  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /已暂存/);
  assert.match(String(snapshot?.content), /staged\.txt/);
  assert.match(String(snapshot?.content), /未暂存/);
  assert.match(String(snapshot?.content), /第二版/);
  assert.match(String(snapshot?.content), /未跟踪/);
  assert.match(String(snapshot?.content), /untracked\.txt/);
  assert.match(String(snapshot?.content), /没跟踪的新文件/);
});

test("变更快照包含完整文件上下文,前端才能默认折叠后按需展开", () => {
  const cwd = makeSite({ git: true });
  const original = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`);
  writeFileSync(join(cwd, "full.txt"), `${original.join("\n")}\n`);
  execFileSync("git", ["-C", cwd, "add", "full.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "add full"]);
  original[14] = "第 15 行（已修改）";
  writeFileSync(join(cwd, "full.txt"), `${original.join("\n")}\n`);

  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /第 1 行/);
  assert.match(String(snapshot?.content), /第 15 行（已修改）/);
  assert.match(String(snapshot?.content), /第 30 行/);
});

test("工作区干净时如实说干净,而不是假装没这项", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" }, git: true });
  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /工作区干净/);
});

test("白名单是唯一边界:集合外的 name 与穿越一律不认", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" } });
  writeFileSync(join(cwd, "秘密.md"), "不该被读到\n");
  for (const bad of [
    "../秘密.md",
    "REQ2026081405/../../秘密.md",
    "/etc/passwd",
    "REQ2026081405/.ticket-id",
    "",
    "不存在.md",
  ]) {
    assert.equal(readArtifact(cwd, bad), undefined, `${bad} 竟然读到了`);
  }
});

test("超过 512 KB 只回传前 512 KB 并标注截断", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" } });
  const huge = join(cwd, ".mae-flow-work", "REQ2026081405", "huge.md");
  // 单字符 3 字节的中文:顺带验证按字节切不会留下半个字。
  writeFileSync(huge, "巨".repeat(300_000));
  const artifact = readArtifact(cwd, "REQ2026081405/huge.md");
  assert.equal(artifact?.truncated, true);
  assert.match(String(artifact?.content), /只回传前 512 KB/);
  assert.ok(!String(artifact?.content).includes("�"), "留下了半个字");
  assert.ok(
    Buffer.byteLength(String(artifact?.content), "utf-8")
      <= 512 * 1024 + 200,
    "截断后仍然超限",
  );
});

test("fail-open:空现场、非 git 仓、坏目录都不抛错", () => {
  const empty = mkdtempSync(join(tmpdir(), "mfc-artifacts-empty-"));
  assert.deepEqual(listArtifacts(empty), []);
  assert.equal(readArtifact(empty, "spec.md"), undefined);
  assert.deepEqual(listArtifacts("/不存在的目录/也不该炸"), []);
  assert.equal(readArtifact("/不存在的目录", DIFF_NAME), undefined);

  // 非 git 仓:文档照列,未提交改动这项缺席。
  const noGit = makeSite({ docs: { "spec.md": "# 规格\n" } });
  const items = listArtifacts(noGit);
  assert.deepEqual(names(items), ["REQ2026081405/spec.md"]);

  // 没有 .ticket-id 时退化为扫所有子目录,宁可多列也不空着。
  const loose = mkdtempSync(join(tmpdir(), "mfc-artifacts-loose-"));
  const dir = join(loose, ".mae-flow-work", "REQ9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# 无标记也要看得到\n");
  assert.deepEqual(names(listArtifacts(loose)), ["REQ9/spec.md"]);
});

test("现场定位:cwd 给了就用,没给就在工作区下找克隆目录", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-artifacts-ws-"));
  const clone = join(workspace, "origin");
  mkdirSync(join(clone, ".mae-flow-work", "REQ1"), { recursive: true });
  writeFileSync(join(clone, ".mae-flow-work", "REQ1", ".ticket-id"), "REQ1");
  writeFileSync(join(clone, ".mae-flow-work", "REQ1", "spec.md"), "# 规格\n");
  assert.equal(resolveArtifactRoot(workspace), clone);
  assert.equal(resolveArtifactRoot(workspace, clone), clone);
  assert.equal(
    resolveArtifactRoot(mkdtempSync(join(tmpdir(), "mfc-artifacts-none-"))),
    undefined,
  );
});

test("路由 GET /tasks/:id/artifacts[/:name]:能看任务就能看材料", async () => {
  const script: Scene[] = [{ text: "一步收工。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-artifacts-api-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({ requirement: "演练:检视产物路由" }),
    }).then((response) => response.json());
    const deadline = Date.now() + 30_000;
    while (service.get(created.id)!.status !== "completed") {
      if (Date.now() > deadline) throw new Error("任务未收口");
      await new Promise((tick) => setTimeout(tick, 50));
    }

    // 演练模式没有内核现场:空列表而不是 500——流程没到 init 不是错误。
    const list = await fetch(`${base}/tasks/${created.id}/artifacts`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), []);

    // 现场铺上材料后,同一路由就能列出来、读出来。
    const workspace = service.get(created.id)!.workspace;
    const ticket = join(workspace, "origin", ".mae-flow-work", "REQ7");
    mkdirSync(ticket, { recursive: true });
    writeFileSync(join(ticket, ".ticket-id"), "REQ7");
    writeFileSync(join(ticket, "spec.md"), "# 规格\n\n决策与证据同屏。\n");
    const listed = await fetch(`${base}/tasks/${created.id}/artifacts`)
      .then((response) => response.json()) as ArtifactMeta[];
    assert.deepEqual(names(listed), ["REQ7/spec.md"]);

    const encoded = encodeURIComponent("REQ7/spec.md");
    const read = await fetch(`${base}/tasks/${created.id}/artifacts/${encoded}`);
    assert.equal(read.status, 200);
    assert.match(String((await read.json()).content), /决策与证据同屏/);

    const missing = await fetch(
      `${base}/tasks/${created.id}/artifacts/${encodeURIComponent("没有这份.md")}`);
    assert.equal(missing.status, 404);
    const noTask = await fetch(`${base}/tasks/task-99/artifacts`);
    assert.equal(noTask.status, 404);
  } finally {
    server.close();
    await model.stop();
  }
});
