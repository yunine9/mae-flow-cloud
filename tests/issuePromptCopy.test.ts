/**
 * 提示词文案挂载器(ADR-0015)的契约测试:目录挂载、锚点协议、
 * {{var}} 替换的 fail-loud 纪律。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mountedPromptAnchors,
  promptCopy,
  PROMPT_SOURCE_DIR,
} from "../src/issueFlow/promptCopy.ts";

test("文案目录挂载:三个文件全部加载,锚点按域分布", () => {
  const anchors = mountedPromptAnchors();
  assert.ok(anchors.length >= 30, `锚点数量异常少: ${anchors.length}`);
  for (const file of ["opening", "notices", "receipts"]) {
    assert.ok(
      anchors.some((anchor) => anchor.startsWith(`${file}.`)),
      `${file}.md 没有挂载出任何锚点(源目录: ${PROMPT_SOURCE_DIR})`);
  }
  // 高频锚点抽检:契约/催办/单号门禁在,少一个都是让 Agent 裸奔。
  for (const key of [
    "opening.fixed.contract",
    "opening.resume.header",
    "notices.nudge.body",
    "receipts.push.no_ticket",
    "receipts.stage.closed",
  ]) {
    assert.ok(anchors.includes(key), `关键锚点缺失: ${key}`);
  }
});

test("{{var}} 替换:数字自动转串,文本原样保序", () => {
  const text = promptCopy("receipts", "push.branch_mismatch", {
    expected: "master_dev_D1", branch: "main",
  });
  assert.match(text, /应为 master_dev_D1,实际 main/);
  assert.match(text, /master_<工号>_<单号>/, "静态部分不能丢");
  const nudge = promptCopy("notices", "nudge.body", {
    attempt: 1, budget: 2,
    stage_brief: "当前阶段「问题分析」: X。出口: Y。可用工具: Z。",
    remain: 2,
  });
  assert.match(nudge, /平台催办\(第 1\/2 次\)/);
  assert.match(nudge, /当前阶段「问题分析」/);
  assert.match(nudge, /再无故停机 2 次/);
});

test("fail-loud:锚点缺失、变量缺失、替换后残留占位符都当场抛错", () => {
  assert.throws(
    () => promptCopy("receipts", "no.such.anchor"),
    /锚点不存在/,
  );
  assert.throws(
    () => promptCopy("receipts", "push.branch_mismatch"),
    /变量缺失.*\{\{expected\}\}/,
  );
  // md 里写了变量、代码没传,绝不允许静默出门。
  assert.throws(
    () => promptCopy("receipts", "mrgate.awaiting", {}),
    /变量缺失/,
  );
});
