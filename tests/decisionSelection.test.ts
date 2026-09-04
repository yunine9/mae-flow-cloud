import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDecisionChoice,
  toggleDecisionChoice,
} from "../web/src/decisionSelection";

test("决策选项再次点击会取消，改点其他项会切换", () => {
  const first = toggleDecisionChoice({}, "问题一", "方案 A");
  assert.deepEqual(first, { "问题一": "方案 A" });

  const cleared = toggleDecisionChoice(first, "问题一", "方案 A");
  assert.deepEqual(cleared, {});
  assert.deepEqual(first, { "问题一": "方案 A" }, "不得改写上一份状态");

  const switched = toggleDecisionChoice(first, "问题一", "方案 B");
  assert.deepEqual(switched, { "问题一": "方案 B" });
});

test("数字题号与字符串题号使用同一套取消语义", () => {
  const picked = toggleDecisionChoice({}, 0, "accept");
  assert.equal(picked[0], "accept");
  assert.deepEqual(toggleDecisionChoice(picked, 0, "accept"), {});
});

test("选择自定义答复时可以清掉已有分支", () => {
  const current = { "怎么处理": "直接继续", untouched: "保留" };
  assert.deepEqual(clearDecisionChoice(current, "怎么处理"), {
    untouched: "保留",
  });
  assert.strictEqual(clearDecisionChoice(current, "不存在"), current);
});
