/**
 * 检视账本的单元契约(ADR-0007,数据面在 src/issueFlow/reviews.ts):
 * - 记/移除:作者恒为归属人,软删留痕;空内容/空锚点打回;
 * - 锚点检测:gone = 已被改动的唯一判据,moved 只是漂移;读不到
 *   报告按 hit 放行(fail-open,检测绝不挡人);
 * - 提交:草稿标记送出,被检视报告留版本快照(子目录,不混进过程
 *   文档清单);没有草稿返回空(服务层据此打回);
 * - 渲染:四条护栏原文沿用 annotations.ts 的契约,清单带稳定 id/
 *   行号/原文/要求,收尾指回 submit_analysis。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReview,
  anchorChecks,
  dropReview,
  renderReviewNotes,
  reviewStore,
  submitReviews,
} from "../src/issueFlow/reviews.ts";
import {
  ANALYSIS_DOC_NAME,
  listSessionDocuments,
} from "../src/issueFlow/documents.ts";

function workspace(content = "# 分析报告\n\n根因:重试无上限。\n"): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-reviews-"));
  writeFileSync(join(root, ANALYSIS_DOC_NAME), content);
  return root;
}

test("记意见与移除:草稿入账;空内容/空锚点打回;移除软删留痕", () => {
  const root = workspace();
  const added = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "重试要有上限",
  });
  assert.equal(added.status, "draft");
  assert.equal(added.artifact, ANALYSIS_DOC_NAME,
    "检视对象恒为分析报告(ADR-0007:检视范围只有它)");
  assert.equal(added.kind, "doc");

  assert.throws(() => addReview(root, {
    author: "dev", line: 1, anchor: "x", note: "  ",
  }), /内容不能为空|批注内容不能为空/);
  assert.throws(() => addReview(root, {
    author: "dev", line: 1, anchor: "", note: "n",
  }), /原文快照|无从定位/);

  const dropped = dropReview(root, added.id, "dev");
  assert.equal(dropped.status, "dropped");
  assert.equal(reviewStore(root).visible().length, 0, "软删的不再露面");
  assert.equal(reviewStore(root).list().length, 1, "jsonl 留痕可查");
});

test("锚点检测:没动=hit;重写原文消失=gone(已被改动的唯一判据);漂移=moved;读不到报告按 hit 放行", () => {
  const root = workspace();
  addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "n1",
  });
  assert.equal(anchorChecks(root)[0]?.state, "hit");

  // agent 修订 = 整份重写,意见锚定的原文没了 → gone + 现状原文
  writeFileSync(join(root, ANALYSIS_DOC_NAME),
    "# 分析报告 v2\n\n根因:连接池耗尽。\n");
  const gone = anchorChecks(root)[0];
  assert.equal(gone?.state, "gone");
  assert.match(gone?.now ?? "", /连接池耗尽/, "gone 带现状原文,让人自己判断");

  // 原文还在、只是行号漂移 → moved(不算"已被改动")
  const drift = workspace("# 报告\n\n根因:超时\n");
  addReview(drift, { author: "dev", line: 3, anchor: "根因:超时", note: "n" });
  writeFileSync(join(drift, ANALYSIS_DOC_NAME),
    "# 报告\n\n新增:前言。\n\n根因:超时\n");
  assert.equal(anchorChecks(drift)[0]?.state, "moved");

  // 读不到报告(权限/缺失):按 hit 放行——重锚定绝不挡住面板
  const blind = mkdtempSync(join(tmpdir(), "mfc-issue-reviews-blind-"));
  addReview(blind, { author: "dev", line: 1, anchor: "随便", note: "n" });
  assert.equal(anchorChecks(blind)[0]?.state, "hit");
});

test("提交检视:草稿标记送出;报告版本快照落在子目录、不混进过程文档清单;无草稿返回空", () => {
  const root = workspace();
  addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const sent = submitReviews(root);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.status === "sent"));
  assert.equal(sent[0].line <= sent[1].line, true, "清单按行号升序");
  assert.equal(reviewStore(root).drafts().length, 0);

  // 版本快照(ADR-0007 Q10):意见锚定的原文永远可对照;子目录避开
  // 顶层 .md 扫描,过程文档页签不见它。
  const snapDir = join(root, "reviews");
  assert.ok(existsSync(snapDir));
  assert.ok(readdirSync(snapDir).some((name) => name.startsWith("issue-analysis@")));
  assert.deepEqual(
    listSessionDocuments(root).map((doc) => doc.name),
    [ANALYSIS_DOC_NAME],
    "快照不是过程文档页签");

  // 没有草稿:空清单(服务层据此打回"没有待提交的检视意见")
  assert.deepEqual(submitReviews(root), []);
});

test("意见清单渲染:四条护栏原文沿用;逐条带稳定 id/行号/原文/要求;收尾指回 submit_analysis", () => {
  const root = workspace();
  const first = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  const second = addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const text = renderReviewNotes([second, first], "登录超时", 2);
  assert.match(text, /这是检视结论,不是征求意见/);
  assert.match(text, /不要只回复"已知悉"/);
  assert.match(text, /只按这些意见修订/);
  assert.match(text, /以原文为准定位/);
  assert.match(text, /说明理由,别默默跳过/);
  assert.match(text, new RegExp(`\\[${first.id}\\] 第 3 行`), "稳定 id 入清单");
  assert.match(text, /原文:根因:重试无上限/);
  assert.match(text, /要求:加重试上限/);
  assert.match(text, /第 2 轮/);
  assert.match(text, /重新 submit_analysis/);
});
