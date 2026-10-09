import { test } from "node:test";
import assert from "node:assert/strict";
import { componentKnowledgeMarkdown } from "../src/componentKnowledgeMarkdown.ts";
import { researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
import { publishedComponentParadigms } from "../src/componentKnowledgeDocument.ts";
import { componentSection, consumptionFixture } from "./componentConsumptionFixture.ts";

test("正文清理来源段落，保留后续示例和代码中的同名标题", () => {
  const input = '---\nschema: "internal"\n---\n# 等待任务\n必须 wait 后读取结果。\n## 来源\nrepo:path:1-4 @ abc\n### 引用详情\neverycode-id\n## 示例\n```python\n# 来源\nprint("everycode-example")\n```\n## 使用限制\n不能用于常驻线程。';
  const clean = componentKnowledgeMarkdown(input);
  assert.doesNotMatch(clean, /schema:|repo:path|everycode-id|引用详情/);
  assert.match(clean, /必须 wait 后读取结果/); assert.match(clean, /不能用于常驻线程/);
  assert.match(clean, /```python\n# 来源\nprint\("everycode-example"\)\n```/);
  assert.equal(componentKnowledgeMarkdown("## 来源\n旧引用\n### 公共接口\nPool.submit\n### 最佳示例\n```cpp\npool.submit(work);\n```"), "### 公共接口\nPool.submit\n### 最佳示例\n```cpp\npool.submit(work);\n```");
});

test("下载正文不输出机器字段，正式知识仍能派生相同规则与来源", () => {
  const section = componentSection(); section.content += "\n\n## 来源\n内部证据编号";
  const doc = { overview: "# 并发任务\n\n使用完后等待退出。", sections: [section] };
  const download = researchDocumentMarkdown("研究指令 everycode", doc, true, false);
  assert.doesNotMatch(download, /repository_id|everycode|内部证据编号|### 来源|^---/);
  assert.match(download, /Pool/);
  const f = consumptionFixture();
  try {
    const stored = f.publish([section]);
    const parsed = publishedComponentParadigms({ id: stored.id, revision: stored.revision, content: stored.content, productVersions: [] } as any);
    assert.equal(parsed.length, 1); assert.deepEqual(parsed[0].evidence, section.paradigm!.evidence);
    assert.deepEqual(parsed[0].replaces, section.paradigm!.replaces);
  } finally { f.cleanup(); }
});
