import { test } from "node:test";
import assert from "node:assert/strict";

import { validateAskUserQuestionInput } from "../src/sessionDriver.ts";

test("残缺选择题不发送给用户，开放题和完整多题卡可用", () => {
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "如何处理?", options: ["只剩一个"] }],
  }) ?? "", /只有 1 个选项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{
      question: "如何处理?",
      options: ["采用推荐"],
      "另一个选项": "被模型误放成对象字段",
    }],
  }) ?? "", /不支持字段/);
  assert.equal(validateAskUserQuestionInput({
    questions: [{ question: "请直接说明你的期望" }],
  }), undefined);
  assert.equal(validateAskUserQuestionInput({
    context: "当前配置会影响短信失败后的重试与记账。",
    questions: [
      { question: "范围?", options: ["仅 SMS", "全部渠道"] },
      { question: "次数?", options: ["三次", "四次"] },
    ],
  }), undefined);
  assert.match(validateAskUserQuestionInput({
    context: "",
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
  }) ?? "", /context 必须是非空/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
    scratchpad: "git apply 后再问用户",
  }) ?? "", /问题卡含不支持字段/);
});
