/**
 * 检视批注的语义契约。
 *
 * 三件事必须钉死:
 * 1. **那四条护栏一字不能少**。它们是内核 panel/annotate.py 对着弱模型
 *    踩出来的("已知悉"式敷衍、顺手改别处、行号偏移、默默跳过),看着
 *    像客套话,其实是契约。本仓复制了一份,所以这里得有人看着。
 * 2. **以原文为准定位**。靶子是活的:圈的第 23 行,模型十分钟后重构了。
 *    重锚定必须在送出那一刻做,而且只报告事实、不替人撤条目。
 * 3. **append-only**。多人同圈一份文档,就地覆盖会静默吃掉别人写的字;
 *    半行 JSON(崩在写一半)只能丢它自己,不能炸掉整份。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnnotationError,
  AnnotationPermissionError,
  AnnotationStore,
  orderAnnotations,
  reanchor,
  renderAnnotations,
  type Annotation,
} from "../src/annotations.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";

function store(): AnnotationStore {
  return new AnnotationStore(
    join(mkdtempSync(join(tmpdir(), "mfc-anno-")), "annotations.jsonl"));
}

function seed(
  target: AnnotationStore,
  note: string,
  over: Partial<Annotation> = {},
): Annotation {
  return target.add({
    author: over.author ?? "liaoxiang",
    artifact: over.artifact ?? "REQ-1/spec.md",
    file: over.file ?? "spec.md",
    line: over.line ?? 42,
    anchor: over.anchor ?? "手机号按后四位掩码",
    note,
    kind: over.kind ?? "doc",
  });
}

test("批注清单:那四条护栏一字不能少", () => {
  const target = store();
  seed(target, "掩码要保留后四位");
  const text = renderAnnotations(target.drafts(), "REQ2026081501");

  assert.match(text, /这是我人工检视 REQ2026081501 的结果/);
  assert.match(text, /共 1 条,涉及 1 个文件/);
  // 四条护栏——少一条模型就会退回"已知悉"式敷衍
  assert.match(text, /这是检视结论,不是征求意见/);
  assert.match(text, /只改这些地方/);
  assert.match(text, /以原文为准定位/);
  assert.match(text, /说明理由,别默默跳过/);
  // 三元组:坐标 + 原文 + 要求
  assert.match(text, /【spec\.md】/);
  assert.match(text, /1\. 第 42 行/);
  assert.match(text, /原文:手机号按后四位掩码/);
  assert.match(text, /要求:掩码要保留后四位/);
});

test("清单排序:按文件分组、组内按行号升序——人跳着圈,模型顺着改", () => {
  const target = store();
  seed(target, "第三处", { file: "b.md", line: 9 });
  seed(target, "第一处", { file: "a.md", line: 30 });
  seed(target, "第二处", { file: "a.md", line: 7 });
  const order = orderAnnotations(target.drafts())
    .map((item) => `${item.file}:${item.line}`);
  assert.deepEqual(order, ["a.md:7", "a.md:30", "b.md:9"]);
});

test("代码批注抬的是「当前代码」,文档抬的是「原文」", () => {
  const target = store();
  seed(target, "这个重试只该对网关失败生效",
       { kind: "code", file: "SmsHandler.java", anchor: "retry(3)" });
  assert.match(renderAnnotations(target.drafts(), "T-1"), /当前代码:retry\(3\)/);
});

test("重锚定:命中/偏移/消失/多处都如实报,不替人撤条目", () => {
  const target = store();
  const hit = seed(target, "还在原处", { line: 2, anchor: "第二行原文" });
  const moved = seed(target, "被推下去了", { line: 2, anchor: "会挪走的那行" });
  const gone = seed(target, "已经没了", { line: 3, anchor: "早被删掉的内容" });
  const many = seed(target, "有歧义", { line: 9, anchor: "重复出现" });
  const now = [
    "第一行",
    "第二行原文",
    "插进来的新行",
    "会挪走的那行",
    "重复出现",
    "重复出现",
  ].join("\n");

  const checks = reanchor(target.drafts(), () => now);
  const state = (id: string) => checks.find((item) => item.id === id)!;
  assert.equal(state(hit.id).state, "hit");
  assert.equal(state(moved.id).state, "moved");
  assert.equal(state(moved.id).line, 4, "偏移后要报出新行号");
  assert.equal(state(gone.id).state, "gone");
  assert.equal(state(many.id).state, "ambiguous");
  // 报告归报告:条目一条没少,撤不撤是人的判断
  assert.equal(target.drafts().length, 4);
});

test("重锚定读不到材料时按「还在」放行——旁路绝不挡住人送意见", () => {
  const target = store();
  const only = seed(target, "读不到也得让我送");
  const checks = reanchor(target.drafts(), () => undefined);
  assert.equal(checks[0].state, "hit");
  assert.equal(checks[0].id, only.id);
});

test("append-only:软删留痕、已送出可移出看板、半行 JSON 只丢它自己", () => {
  const target = store();
  const mine = seed(target, "我写的");
  const yours = seed(target, "别人写的", { author: "wangwu" });

  // 只能删自己的:替别人删等于替他改主意
  assert.throws(() => target.drop(yours.id, "liaoxiang"), AnnotationError);
  target.drop(mine.id, "liaoxiang");
  assert.deepEqual(target.drafts().map((item) => item.id), [yours.id]);
  // 软删留痕:记录还在,只是不再是 draft
  assert.equal(target.list().find((item) => item.id === mine.id)?.status,
               "dropped");

  target.markSent([yours.id], "interrupt");
  assert.deepEqual(target.drafts(), []);
  const sent = target.list().find((item) => item.id === yours.id)!;
  assert.equal(sent.status, "sent");
  assert.equal(sent.sent_via, "interrupt");
  // 已送出的可以从看板移除(话收不回,但清单是人自己的):记录留痕
  target.drop(yours.id, "wangwu");
  assert.deepEqual(target.visible(), []);
  assert.equal(target.list().length, 2, "移出看板不等于抹掉记录");

  // 崩在写一半留下的半行,只能丢它自己
  appendFileSync(target.path, '{"op":"add","record":{"id":"an-x"', "utf-8");
  assert.equal(target.list().length, 2, "坏行不许炸掉整份批注");
});

test("批注归作者管理:本人可编辑删除,其他人无权代改", () => {
  const target = store();
  const mine = seed(target, "第一版意见", { author: "committer" });

  assert.throws(
    () => target.edit(mine.id, "越权修改", "developer"),
    AnnotationPermissionError,
  );
  assert.throws(
    () => target.drop(mine.id, "developer"),
    AnnotationPermissionError,
  );

  const edited = target.edit(mine.id, "第二版意见", "committer");
  assert.equal(edited.note, "第二版意见");
  assert.ok(edited.edited_at);

  target.markSent([mine.id], "decision");
  const sentEdited = target.edit(mine.id, "提交后再修正", "committer");
  assert.equal(sentEdited.status, "draft",
    "改过的版本必须重新提交,不能冒充旧版本已经送达");
  assert.equal(sentEdited.sent_at, undefined);

  const dropped = target.drop(mine.id, "committer");
  assert.equal(dropped.status, "dropped");
});

test("批注 HTTP 权限:开发与 Committer 都只能管理自己提出的意见", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-anno-auth-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("developer", "developer-pass-1", "developer");
  auth.createUser("committer", "committer-pass-1", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const developer = await login("developer", "developer-pass-1");
    const committer = await login("committer", "committer-pass-1");
    const created = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: developer },
      body: JSON.stringify({ requirement: "检视作者权限" }),
    }).then((response) => readJson(response)) as { id: string };

    async function add(cookie: string, note: string): Promise<Annotation> {
      const response = await fetch(`${base}/tasks/${created.id}/annotations`, {
        method: "POST", headers: { cookie },
        body: JSON.stringify({
          artifact: "spec.md", file: "spec.md", line: 1,
          anchor: "原始内容", note, kind: "doc",
        }),
      });
      assert.equal(response.status, 201);
      return await response.json() as Annotation;
    }

    const committerNote = await add(committer, "Committer 的意见");
    const developerNote = await add(developer, "开发的意见");

    const committerEditsOwn = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "PATCH", headers: { cookie: committer },
        body: JSON.stringify({ note: "Committer 修改后的意见" }),
      });
    assert.equal(committerEditsOwn.status, 200,
      "Committer 即使不是任务责任人也能编辑自己的批注");

    const developerCannotEdit = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "PATCH", headers: { cookie: developer },
        body: JSON.stringify({ note: "开发越权修改" }),
      });
    assert.equal(developerCannotEdit.status, 403);
    const developerCannotDelete = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "DELETE", headers: { cookie: developer },
      });
    assert.equal(developerCannotDelete.status, 403);

    const committerCannotEdit = await fetch(
      `${base}/tasks/${created.id}/annotations/${developerNote.id}`, {
        method: "PATCH", headers: { cookie: committer },
        body: JSON.stringify({ note: "Committer 越权修改" }),
      });
    assert.equal(committerCannotEdit.status, 403);

    const committerDeletesOwn = await fetch(
      `${base}/tasks/${created.id}/annotations/${committerNote.id}`, {
        method: "DELETE", headers: { cookie: committer },
      });
    assert.equal(committerDeletesOwn.status, 200);
    const listed = await fetch(`${base}/tasks/${created.id}/annotations`, {
      headers: { cookie: developer },
    }).then((response) => readJson(response)) as { items: Annotation[] };
    assert.deepEqual(listed.items.map((item) => item.id), [developerNote.id]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("检视闭环:确认通过收口,返工退回草稿再送一轮", () => {
  // "本质上是我给 AI 提了检视意见,这条路得闭环"——提出→送达→改动之后,
  // 人必须能落一个裁决:通过就收口,不行就返工。返工不造新送出机制,
  // 退回 draft 走原有两条通道。
  const target = store();
  const first = seed(target, "掩码保留后四位");
  target.markSent([first.id], "interrupt");

  // 通过:状态落 verified,不再出现在待送出里
  const verified = target.verify(first.id, "liaoxiang");
  assert.equal(verified.status, "verified");
  assert.ok(verified.verified_at);
  assert.equal(target.drafts().length, 0);

  // 返工:退回 draft,轮次 +1,锚点可更新且历史留档
  const reopened = target.reopen(first.id, "liaoxiang",
    { line: 50, anchor: "掩码保留后四位(新写法)" });
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.rework, 1);
  assert.equal(reopened.line, 50);
  assert.equal(reopened.anchor, "掩码保留后四位(新写法)");
  assert.equal(reopened.anchor_was, "手机号按后四位掩码");
  assert.equal(target.drafts().length, 1, "返工的必须回到待送出队列");

  // 渲染要点明这是第二轮,并给出上一轮锚点——不然模型当新意见处理
  const text = renderAnnotations(target.drafts(), "REQ-1");
  assert.match(text, /第 2 次提出/);
  assert.match(text, /不要原样重复上次的改法/);
  assert.match(text, /上一轮针对的原文:手机号按后四位掩码/);

  // 边界:草稿没有可裁决的改动;别人的意见不能替裁
  const draft = seed(target, "另一条");
  assert.throws(() => target.verify(draft.id, "liaoxiang"), /没有可裁决/);
  target.markSent([draft.id], "decision");
  assert.throws(() => target.verify(draft.id, "路人"), /只能由他裁决/);
});

test("空内容与缺原文一律拒收——没有原文的批注无从定位", () => {
  const target = store();
  assert.throws(() => seed(target, "   "), AnnotationError);
  assert.throws(() => seed(target, "有意见", { anchor: "" }), AnnotationError);
});

/* ------- 端到端:批注真的成了"需要修改"的理由,进到模型那里 ------- */

const REVIEW_SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "这轮代码通过吗?",
                                   options: ["通过", "需要修改"] }] } } },
  { text: "按你圈的几处改完了。" },
];

async function until(
  probe: () => boolean, what: string, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("批注随决定提交:进 notes 不进 decision,选项记账不被污染", async () => {
  const model = new ScriptedModelServer(REVIEW_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-e2e-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");

    const one = service.addAnnotation(id, {
      author: "liaoxiang", artifact: "REQ-1/spec.md", file: "SmsHandler.java",
      line: 23, anchor: "retry(3)", note: "重试只该对网关失败生效",
      kind: "code",
    });
    assert.equal(service.listAnnotations(id).items.length, 1);

    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      decision: "需要修改",
      annotation_ids: [one.id],
    });
    await until(() => service.get(id)?.status === "completed", "任务收口");

    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    // 选项原样(内核按标签记账),批注作为理由跟在后面
    assert.match(seen, /需要修改/);
    assert.match(seen, /重试只该对网关失败生效/);
    assert.match(seen, /以原文为准定位/);
    // 送出即出队,不会在下一个检视点重复送一遍;但清单上不下架——
    // 人得看得见"这条我提过了、是随决定提的"。
    const after = service.listAnnotations(id).items;
    assert.equal(after.length, 1);
    assert.equal(after[0].status, "sent");
    assert.equal(after[0].sent_via, "decision");
  } finally {
    await model.stop();
  }
});

test("批注 HTTP 面:圈注→清单带进展→送出走插话通道", async () => {
  const model = new ScriptedModelServer([
    { text: "先看看", tool: { name: "bash", input: { command: "sleep 2; echo OK" } } },
    { text: "按你圈的改完了。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-anno-http-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST", body: JSON.stringify({ requirement: "给手机号打码" }),
    }).then((response) => readJson(response));
    const id: string = created.id;
    await until(() => model.requests.length >= 1, "模型开跑");

    const made = await fetch(`${base}/tasks/${id}/annotations`, {
      method: "POST",
      body: JSON.stringify({
        artifact: "未提交改动", file: "SmsHandler.java", line: 23,
        anchor: "retry(3)", note: "重试只该对网关失败生效", kind: "code",
      }),
    });
    assert.equal(made.status, 201);

    // 清单里能看见"我圈了什么、现在什么进展"
    const before = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.equal(before.items.length, 1);
    assert.equal(before.items[0].status, "draft");
    assert.equal(before.checks.length, 1);

    const sent = await fetch(`${base}/tasks/${id}/annotations/send`, {
      method: "POST", body: JSON.stringify({}),
    }).then((response) => readJson(response));
    assert.equal(sent.sent.length, 1);

    // 送出后不下架:状态翻成 sent,人还看得见"这条提过了"
    const after = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.equal(after.items[0].status, "sent");
    assert.equal(after.items[0].sent_via, "interrupt");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? "")).join("\n");
    assert.match(seen, /重试只该对网关失败生效/);

    // AI 收到之后说的话要能在清单里看到(原话,不做逐条对应)——
    // 不然"不同意+理由"永远躺在会话流里,面板上像什么都没发生。
    const replied = await fetch(`${base}/tasks/${id}/annotations`)
      .then((response) => readJson(response));
    assert.ok(replied.reply, "送出之后必须带回 AI 的回话");
    assert.match(replied.reply.texts.join("\n"), /按你圈的改完了/);
  } finally {
    server.close();
    await model.stop();
  }
});

test("重锚定:缩进不同也算命中——两边必须一把尺子量", () => {
  // 实测事故:锚点是渲染时抓的(空白已折叠),文件里是原始缩进,
  // 直接 includes 一条带缩进的代码永远找不到,于是三条批注全被误报成
  // "这处已被改动",而代码一个字都没动。误报比不报更坏——人会以为
  // 提过的都落实了。
  const target = store();
  const one = seed(target, "这里用英文",
    { kind: "code", anchor: "? \"push 已发送\" + NotifyRenderer.SUFFIX" });
  const file = [
    "class PushChannelHandler {",
    "        return SendResult.ok(rendered.isDegraded()",
    "                ? \"push 已发送\" + NotifyRenderer.SUFFIX",
    "                : \"push 已发送\");",
  ].join("\n");
  const checks = reanchor(target.drafts(), () => file);
  assert.equal(checks[0].id, one.id);
  assert.notEqual(checks[0].state, "gone", "缩进差异不该被判成原文消失");
});
