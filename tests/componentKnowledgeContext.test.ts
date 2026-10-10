import { test } from "node:test";
import assert from "node:assert/strict";
import { componentCodeObservations, createComponentKnowledgeContext, COMPONENT_CONTEXT_TYPE } from "../src/componentKnowledgeContext.ts";
import { componentSection, consumptionFixture } from "./componentConsumptionFixture.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import type { MemoryUsageEvent } from "../src/memoryUsage.ts";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

function exchange(name = "read", args: Record<string, unknown> = { path: "worker.cpp" }, text = "std::thread worker;", error = false, id = "read-1") {
  return [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
    { role: "toolResult", toolName: name, toolCallId: id, isError: error, content: [{ type: "text", text }] }];
}
const supplied = (messages: any[]) => messages.find(m => m.customType === COMPONENT_CONTEXT_TYPE)?.content ?? "";
const contextFor = (f: ReturnType<typeof consumptionFixture>, more = {}) => createComponentKnowledgeContext({ dataDir: f.data, cwd: f.cwd, context: () => f.context, languages: () => ["cpp"], ...more });

test("代码观测不采用需求、工具命令、失败结果、知识正文或仓外文件", () => {
  const messages = [
    { role: "user", content: "std::thread worker;" },
    ...exchange("read", { path: "a.cpp" }, "std::thread worker;", true),
    ...exchange("read", { path: "../a.cpp" }),
    ...exchange("read", { path: "guide.md" }),
    ...exchange("knowledge", { action: "read" }),
    ...exchange("bash", { command: "echo std::thread" }, "std::thread worker;"),
  ];
  assert.deepEqual(componentCodeObservations(messages, "/repo"), []);
});

test("成功修改只观察实际新代码，后续替换会移走该文件旧线索", () => {
  const read = exchange("read", { path: "worker.cpp" });
  const edited = exchange("edit", { path: "worker.cpp", edits: [{ oldText: "std::thread worker;", newText: "run();" }] }, "ok", false, "edit-1");
  assert.equal(componentCodeObservations([...read, ...edited], "/repo")[0].text, "run();");
  const deleted = exchange("edit", { path: "worker.cpp", old_string: "std::thread worker;", new_string: "" }, "ok", false, "edit-2");
  assert.equal(componentCodeObservations([...read, ...deleted], "/repo")[0].text, "");
});

test("检索只用带仓内路径与行号的结果，工具附加说明不成为源码", () => {
  const f = consumptionFixture();
  try {
    writeFileSync(join(f.cwd, "a.cpp"), "int x;\nstd::thread t;\n");
    const messages = exchange("bash", { command: "rg -n thread ." }, "a.cpp:2:std::thread t;\n../b.cpp:1:std::thread outside;\n日志 Pool.submit");
    assert.deepEqual(componentCodeObservations(messages, f.cwd).map(o => [o.path, o.text]), [["a.cpp", "int x;\nstd::thread t;\n"]]);
    for (const command of ["rg -n thread .", "printf fake"]) {
      assert.deepEqual(componentCodeObservations(exchange("bash", { command }, "missing.cpp:1:std::thread t;\na.cpp:1:std::thread forged;"), f.cwd), []);
    }
    const outside = join(f.dir, "outside.cpp"); writeFileSync(outside, "std::thread outside;");
    symlinkSync(outside, join(f.cwd, "linked.cpp"));
    assert.deepEqual(componentCodeObservations(exchange("bash", { command: "rg -n thread linked.cpp" }, "linked.cpp:1:std::thread outside;"), f.cwd), []);
  } finally { f.cleanup(); }
  const read = exchange("read", { path: "a.cpp" }, "int value;");
  (read[1].content as any[]).push({ type: "text", text: "宿主检查：Pool.submit" });
  assert.equal(componentCodeObservations(read, "/repo")[0].text, "int value;");
});

test("正式指南合法的标题缩进与尾部井号不丢掉配置及约束", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish();
    saveKnowledgeDocument(f.data, { content: doc.content.replace("## 接入配置\n", "  ## 接入配置 ##\n").replace("### 使用约束\n", " ### 使用约束 ###\n") }, "expert", doc.id);
    const text = supplied(await contextFor(f)(exchange()));
    assert.match(text, /使用 pool v2 并保持统一生命周期/);
    assert.match(text, /任务结束前不能释放捕获的对象/);
    assert.doesNotMatch(text, /未加载完整使用条件/);
  } finally { f.cleanup(); }
});

test("超长行不被截成有效API，过期工作文件退出观测窗口", () => {
  const long = " ".repeat(47_989) + "std::threadSuffix";
  assert.equal(componentCodeObservations(exchange("read", { path: "a.cpp" }, long), "/repo")[0].text, "");
  const history = [...exchange(), ...Array.from({ length: 12 }, (_, i) => exchange("bash", { command: "pwd" }, "/repo", false, `shell-${i}`)).flat()];
  assert.deepEqual(componentCodeObservations(history, "/repo"), []);
});

test("平台自动给出正式来源、配置与约束，每轮替换并跟随正文修订、停用", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), uses: MemoryUsageEvent[] = [], build = contextFor(f, { onUse: (e: MemoryUsageEvent) => uses.push(e) });
    assert.equal(supplied(await build([{ role: "user", content: "复杂的任务需求，可能用 std::thread" }])), "");
    const history = exchange(), first = await build(history), text = supplied(first);
    assert.match(text, /替代候选/); assert.match(text, /使用 pool v2 并保持统一生命周期/);
    assert.match(text, /任务结束前不能释放捕获的对象/); assert.match(text, /链接已发布的 pool target/);
    assert.ok(text.includes(doc.id) && text.includes(doc.revision));
    const again = await build(first);
    assert.equal(again.filter(m => m.customType === COMPONENT_CONTEXT_TYPE).length, 1);
    assert.equal(uses.length, 1, "相同供给不重复记账");
    assert.ok(uses[0].assets?.some(a => a.heading === "接入配置" && a.start_line && a.end_line));
    const revised = saveKnowledgeDocument(f.data, { content: doc.content.replace("任务结束前不能释放捕获的对象", "必须在退出前完成 drain") }, "expert", doc.id);
    const updated = supplied(await build(first));
    assert.match(updated, /必须在退出前完成 drain/); assert.doesNotMatch(updated, /任务结束前不能释放捕获的对象/);
    assert.ok(updated.includes(revised.revision));
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    assert.equal(supplied(await build(first)), "");
    assert.equal(uses.at(-1)?.status, "empty");
  } finally { f.cleanup(); }
});

test("产品版本和语言不符不提供资料，当前范围变化立即生效", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(undefined, { product_versions: ["v2"] });
    const build = contextFor(f);
    assert.ok(supplied(await build(exchange())).includes(doc.id));
    f.context.productVersion = "v3";
    assert.equal(supplied(await build(exchange())), "");
    f.context.productVersion = "v2";
    assert.equal(supplied(await contextFor(f, { languages: () => ["java"] })(exchange())), "");
  } finally { f.cleanup(); }
});

test("预算不足时不截断使用条件、代码围栏或伪称完整", async () => {
  const f = consumptionFixture();
  try {
    const section = componentSection(); section.example = "```cpp\n// " + "长示例".repeat(6000) + "\nPool pool;\n```";
    f.publish([section]);
    const uses: MemoryUsageEvent[] = [];
    const text = supplied(await contextFor(f, { maxChars: 2200, onUse: (e: MemoryUsageEvent) => uses.push(e) })(exchange()));
    assert.ok(text.length <= 2200); assert.match(text, /任务结束前不能释放捕获的对象/);
    assert.match(text, /完整示例、单元测试示例未加载/); assert.doesNotMatch(text, /长示例/);
    assert.equal(uses[0].components?.[0].complete, false);
    assert.ok(!uses[0].assets?.some(a => a.heading === "完整示例"));
    const huge = componentSection(); huge.integration = "必须遵循条件".repeat(5000);
    f.publish([huge]);
    const locator = supplied(await contextFor(f, { maxChars: 2200 })(exchange()));
    assert.match(locator, /未加载完整使用条件/); assert.doesNotMatch(locator, /必须遵循条件/);
    assert.ok(locator.length <= 2200);
  } finally { f.cleanup(); }
});

test("同名多来源保持候选，超过预算显示遗漏，不一次展开全库", async () => {
  const f = consumptionFixture();
  try {
    for (let i = 0; i < 7; i++) f.publish([componentSection("cpp", `use-${i}`)], { title: `组件指南 ${i}` });
    const uses: MemoryUsageEvent[] = [];
    const text = supplied(await contextFor(f, { onUse: (e: MemoryUsageEvent) => uses.push(e) })(exchange("read", { path: "a.cpp" }, "Pool::submit(work);")));
    assert.match(text, /尚未解析实际依赖归属/); assert.match(text, /另有 3 个关联未加载/);
    assert.equal(uses[0].components?.length, 4); assert.ok(text.length <= 12_000);
    assert.match(text, /已有封装可能承担/);
  } finally { f.cleanup(); }
});

test("多个关联时优先装下主要接口的必要条件，不平均分块使所有资料退化成入口", async () => {
  const f = consumptionFixture();
  try {
    const primary = componentSection(); primary.content = primary.content.replace("任务结束前不能释放捕获的对象。", "主要约束".repeat(1200));
    f.publish([primary]);
    for (let i = 0; i < 3; i++) {
      const alternative = componentSection("cpp", `alternative-${i}`); alternative.paradigm!.api = [`Other${i}.run`];
      f.publish([alternative]);
    }
    const text = supplied(await contextFor(f)(exchange("read", { path: "worker.cpp" }, "Pool pool; pool.submit(work); std::thread worker;")));
    assert.ok(text.includes("主要约束".repeat(1200))); assert.ok(text.length <= 12_000);
  } finally { f.cleanup(); }
});

test("观察回调故障不能移走有效资料，观测和上下文不跨会话共享", async () => {
  const f = consumptionFixture();
  try {
    f.publish();
    const first = contextFor(f, { onUse: () => { throw new Error("不可写"); } }), second = contextFor(f);
    assert.match(supplied(await first(exchange())), /任务结束前不能释放捕获的对象/);
    assert.equal(supplied(await second([{ role: "user", content: "处理另一件事" }])), "");
    const expired = [{ role: "custom", customType: COMPONENT_CONTEXT_TYPE, content: "陈旧资料" }];
    assert.deepEqual(await first(expired), []);
  } finally { f.cleanup(); }
});
