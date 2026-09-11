import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDecisionChoice,
  unifiedDecisionReply,
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

test("统一回复保留显式决定分支，补充意见不会替换所选答案", () => {
  assert.deepEqual(unifiedDecisionReply("需要调整代码", "  修复空状态  "), {
    freeResponse: "", notes: "修复空状态",
  });
  assert.deepEqual(unifiedDecisionReply("确认按清单推送", ""), {
    freeResponse: "", notes: "",
  });
});
test("取消选项后意见成为自由答复，不会丢失或重复附带", () => {
  assert.deepEqual(unifiedDecisionReply(undefined, "  先补验证再检视  "), {
    freeResponse: "先补验证再检视", notes: "",
  });
  assert.deepEqual(unifiedDecisionReply(undefined, "  "), {
    freeResponse: "", notes: "",
  });
});


test("推送调整选项不能落入推送按钮分支", async () => {
  const { isAdjustmentAnswer } = await import("../web/src/decisionSelection.ts");
  for (const answer of ["先调整", "需要调整代码（按清单返工）", "需要修改"]) {
    assert.equal(isAdjustmentAnswer(answer), true);
  }
  assert.equal(isAdjustmentAnswer("确认按清单推送"), false);
});

test("旧 API 错投 diff 时宿主推送仍不启用文件清单，普通 diff 不受影响", async () => {
  const { needsDeliverySelection } = await import("../web/src/decisionSelection.ts");
  assert.equal(needsDeliverySelection({ step: "host_push_confirm", recommended_view: "diff" }), false);
  assert.equal(needsDeliverySelection({ step: "cloud_push_confirm", recommended_view: "diff" }), true);
  assert.equal(needsDeliverySelection({ step: "delivery_review", recommended_view: "diff" }), true);
  assert.equal(needsDeliverySelection(undefined), false);
});
