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
      { question: "范围?", options: ["仅 SMS", "全部渠道"],
        recommended: "全部渠道" },
      { question: "次数?", options: ["三次", "四次"], recommended: "三次" },
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

test("推荐协议:选项题必须带 recommended 且命中一个选项,开放题不得带", () => {
  // 命中放行;trim 语义:推荐与选项两边的首尾空白都不参与比对。
  assert.equal(validateAskUserQuestionInput({
    questions: [{
      question: "现象是必现还是偶发?",
      options: ["必现", "偶发"],
      recommended: "偶发",
    }],
  }), undefined);
  assert.equal(validateAskUserQuestionInput({
    questions: [{
      question: "现象是必现还是偶发?",
      options: ["必现 ", " 偶发"],
      recommended: "  偶发  ",
    }],
  }), undefined);
  // 缺失打回:recommended 缺席、空串、纯空白都算没给。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
  }) ?? "", /第 1 题缺少推荐项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "" }],
  }) ?? "", /第 1 题缺少推荐项/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "   " }],
  }) ?? "", /第 1 题缺少推荐项/);
  // 错配打回:文案必须逐字命中,前缀/近似都不算。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "继续执行" }],
  }) ?? "", /第 1 题的推荐项不在选项中/);
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "继续吗?", options: ["继续", "停止"],
      recommended: "暂停" }],
  }) ?? "", /第 1 题的推荐项不在选项中/);
  // 自由文本题误带打回。
  assert.match(validateAskUserQuestionInput({
    questions: [{ question: "请直接说明你的期望", recommended: "有" }],
  }) ?? "", /第 1 题是自由作答题.*不能带 recommended/);
  // 多题卡逐题独立:一题缺推荐整卡打回,文案点名题号。
  assert.match(validateAskUserQuestionInput({
    questions: [
      { question: "范围?", options: ["仅 SMS", "全部渠道"],
        recommended: "全部渠道" },
      { question: "次数?", options: ["三次", "四次"] },
    ],
  }) ?? "", /第 2 题缺少推荐项/);
});
