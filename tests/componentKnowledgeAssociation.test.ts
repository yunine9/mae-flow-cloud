import { test } from "node:test";
import assert from "node:assert/strict";
import { associateComponentKnowledge, type ComponentCodeObservation } from "../src/componentKnowledgeAssociation.ts";
import type { PublishedComponentParadigm } from "../src/componentKnowledgeDocument.ts";
import { componentSection } from "./componentConsumptionFixture.ts";

function paradigm(overrides: Partial<PublishedComponentParadigm> = {}): PublishedComponentParadigm {
  const section = componentSection();
  return { ...section.paradigm!, id: section.id, title: section.title, revision: 1,
    document_id: "doc-pool", document_revision: "revision-1", start_line: 10, end_line: 80,
    product_versions: [], source_repositories: [], mapping_id: "", source_digest: "",
    policy: { level: "shadow", source_digest: "", owner: "", scope: [], reason: "", updated_at: "", operator: "" },
    ...overrides };
}
const observation = (text: string, path = "src/work.cpp", callId?: string): ComponentCodeObservation => ({ path, text, tool: "Read", callId });

test("完整限定 API 可从签名和有空格的代码关联，不推断变量类型或后缀", () => {
  const p = paradigm({ api: ["void acme::Pool::submit(std::function<void()>)"] });
  const hit = associateComponentKnowledge([p], [observation("acme :: Pool :: submit(job);")]);
  assert.equal(hit.length, 1); assert.equal(hit[0].kind, "api");
  assert.deepEqual(hit[0].symbols, p.api);
  const plain = paradigm();
  for (const text of ["submit(job);", "pool.submit(job);", "Other.submit(job);", "Pool.submitLater(job);", "MyPool.submit(job);", "other.Pool.submit(job);", "其他.Pool.submit(job);", "éPool.submit(job);", "1Pool.submit(job);"]) {
    assert.deepEqual(associateComponentKnowledge([plain], [observation(text)]), [], text);
  }
  assert.equal(associateComponentKnowledge([plain], [observation("Pool::submit(job);")]).length, 1);
});

test("注释、普通字符串、字符、C++原始字符串和Java文本块不提供 API 线索", () => {
  const text = ['// Pool.submit(job);', '/* Pool.submit(job); */', 'const char* a = "Pool.submit(job);";',
    "char c = 'P';", 'auto b = R"marker(Pool.submit(job); "still literal")marker";',
    'auto c = u8R"(Pool.submit(job);)";'].join("\n");
  assert.deepEqual(associateComponentKnowledge([paradigm()], [observation(text)]), []);
  assert.deepEqual(associateComponentKnowledge([paradigm()], [observation("// continued comment \\\nPool.submit(job);")]), []);
  assert.deepEqual(associateComponentKnowledge([paradigm({ language: "java" })], [observation('String s = """\nPool.submit(job);\n""";', "A.java")]), []);
  assert.equal(associateComponentKnowledge([paradigm()], [observation(text + "\nPool.submit(job);")]).length, 1);
});

test("只识别完整替代标识符，不执行 metadata patterns", () => {
  const p = paradigm({ replaces: { identifiers: ["std::thread"], imports: [], patterns: [".*", "while"] } });
  const hit = associateComponentKnowledge([p], [observation("std::thread worker(run);")]);
  assert.equal(hit[0].kind, "replacement"); assert.deepEqual(hit[0].symbols, ["std::thread"]);
  assert.deepEqual(associateComponentKnowledge([p], [observation("while (ready) { mystd::threader(); }")]), []);
});

test("同一代码片段中的简单明确实例声明和参数可关联完整 API", () => {
  const p = paradigm();
  for (const text of [
    "Pool pool; pool.submit(work);",
    "Pool pool{}; pool.submit(work);",
    "void work(Pool pool) { pool.submit(job); }",
    "void work(const Pool& pool, int count) { pool.submit(job); }",
    "void work(Pool *pool) { pool->submit(job); }",
    "auto pool = Pool(4); pool.submit(work);",
    "auto pool = Pool{}; pool.submit(work);",
  ]) {
    const hit = associateComponentKnowledge([p], [observation(text)]);
    assert.equal(hit.length, 1, text); assert.equal(hit[0].kind, "api"); assert.deepEqual(hit[0].symbols, ["Pool.submit"]);
  }
  const java = paradigm({ language: "java" });
  for (const text of ["Pool pool = new Pool(); pool.submit(work);", "void work(final Pool pool) { pool.submit(job); }", "var pool = new Pool(); pool.submit(work);"]) {
    assert.equal(associateComponentKnowledge([java], [observation(text, "Work.java")]).length, 1, text);
  }
  const qualified = paradigm({ api: ["void acme::Pool::submit(Job job)"] });
  assert.equal(associateComponentKnowledge([qualified], [observation("acme::Pool pool; pool.submit(work);")]).length, 1);
});

test("实例关联不靠变量名、不读取注释字符串、不跨观测或冲突类型猜绑定", () => {
  const p = paradigm();
  for (const text of [
    "pool.submit(work);",
    "OtherPool pool; pool.submit(work);",
    "acme::Pool pool; pool.submit(work);",
    "auto pool = getPool(); pool.submit(work);",
    "auto pool = Pool::create(); pool.submit(work);",
    "// Pool pool;\npool.submit(work);",
    'const char* text = "Pool pool;"; pool.submit(work);',
    "Pool pool; // pool.submit(work);",
    'Pool pool; const char* text = "pool.submit(work);";',
    "Pool pool(); pool.submit(work);",
    "Pool pool; OtherPool pool; pool.submit(work);",
    "Pool pool; obj.pool.submit(work);",
    "Pool pool; obj. pool.submit(work);",
    "pool.submit(work); Pool pool;",
    "Pool pool; pool.submitLater(work);",
  ]) assert.deepEqual(associateComponentKnowledge([p], [observation(text)]), [], text);
  assert.deepEqual(associateComponentKnowledge([p], [observation("Pool pool;"), observation("pool.submit(work);")]), []);
  const grep = { ...observation("Pool pool;\npool.submit(work);"), tool: "Grep" };
  assert.deepEqual(associateComponentKnowledge([p], [grep]), []);
  assert.equal(associateComponentKnowledge([p], [{ ...grep, text: "Pool::submit(work);" }]).length, 1);
});

test("C/C++ include 单独匹配真实指令，字符串和注释伪装不能命中", () => {
  const p = paradigm({ api: ["thread"], replaces: { identifiers: [], imports: ["<thread>", '"pool/pool.h"'], patterns: [] } });
  const hit = associateComponentKnowledge([p], [observation('# include <thread> // dependency\n#include "pool/pool.h"')]);
  assert.equal(hit[0].kind, "replacement"); assert.deepEqual(hit[0].symbols, ['"pool/pool.h"', "<thread>"]);
  const falseText = '// #include <thread>\nconst char* a = "#include <thread>";\nauto b = R"(\n#include <thread>\n)";\n/*\n#include "pool/pool.h"\n*/';
  assert.deepEqual(associateComponentKnowledge([p], [observation(falseText)]), []);
  assert.deepEqual(associateComponentKnowledge([p], [observation("#include <thread_extra>")]), []);
});

test("Java import 按完整导入名匹配，通配符不扩展推断其他类型", () => {
  const p = paradigm({ language: "java", api: [], replaces: { identifiers: [], imports: ["java.util.concurrent.Executor", "java.util.concurrent.*", "app.Pool.INSTANCE"], patterns: [] } });
  const text = "import java.util.concurrent.Executor;\nimport static app.Pool.INSTANCE;\nimport java.util.concurrent.*;";
  assert.deepEqual(associateComponentKnowledge([p], [observation(text, "A.java")])[0].symbols,
    ["app.Pool.INSTANCE", "java.util.concurrent.*", "java.util.concurrent.Executor"]);
  for (const text of ['// import java.util.concurrent.Executor;', 'String s = "import java.util.concurrent.Executor;";', 'import java.util.concurrent.ExecutorService;']) {
    assert.deepEqual(associateComponentKnowledge([p], [observation(text, "A.java")]), []);
  }
});

test("按照真实文件扩展限制语言，未知路径不能猜语言", () => {
  const ps = [paradigm(), paradigm({ language: "c", document_id: "doc-c" }), paradigm({ language: "java", document_id: "doc-java" })];
  for (const [path, expected] of [["a.cpp", ["cpp"]], ["a.C", ["cpp"]], ["a.c", ["c"]], ["a.h", ["c", "cpp"]], ["A.java", ["java"]], ["note.md", []], ["a.ts", []]] as const) {
    assert.deepEqual(associateComponentKnowledge(ps, [observation("Pool.submit();", path)]).map(hit => hit.paradigm.language).sort(), [...expected].sort(), path);
  }
  assert.deepEqual(associateComponentKnowledge(ps, [{ text: "Pool.submit();", tool: "Bash" }]), []);
});

test("同名 API 的多个来源保留候选，重复同一范式不重复，非推荐不参与", () => {
  const p = paradigm(), another = paradigm({ document_id: "other-guide" });
  const result = associateComponentKnowledge([another, p, p, paradigm({ document_id: "legacy", status: "legacy" }), paradigm({ document_id: "contract", kind: "contracts" })], [observation("Pool.submit();")]);
  assert.deepEqual(result.map(hit => hit.paradigm.document_id), ["doc-pool", "other-guide"]);
  assert.ok(result.every(hit => hit.kind === "api"));
});

test("同一范式优先保留 API 线索，同强度保留最近观测，顺序确定", () => {
  const p = paradigm(), older = observation("Pool.submit();", "old.cpp", "old"), latest = observation("Pool.submit();", "new.cpp", "new");
  const replacement = observation("std::thread work;", "last.cpp", "replacement");
  assert.equal(associateComponentKnowledge([p], [older, latest, replacement])[0].observation, latest);
  assert.equal(associateComponentKnowledge([p], [older, replacement])[0].observation, older);
  const input = [observation("std::thread work;"), replacement];
  assert.equal(associateComponentKnowledge([p], input)[0].observation, replacement);
});

test("超大观测整体跳过，处理最近有限观测，不在截断位置制造命中", () => {
  const p = paradigm();
  assert.deepEqual(associateComponentKnowledge([p], [observation("Pool.submit();" + " ".repeat(128 * 1024))]), []);
  const tail = Array.from({ length: 64 }, () => observation("int other;"));
  assert.deepEqual(associateComponentKnowledge([p], [observation("Pool.submit();"), ...tail]), []);
  assert.equal(associateComponentKnowledge([p], [...tail, observation("Pool.submit();")]).length, 1);
});
