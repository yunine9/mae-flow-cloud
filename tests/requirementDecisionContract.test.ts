import test from "node:test";
import assert from "node:assert/strict";
import { requirementDecisionContract, confirmsRequirementGraph } from "../src/requirementDecisionContract.ts";

test("分析确认卡在展示前归一自由文案，反复投影不漂移，不改原记录", () => {
  const source = { questions: [{ question: "需求分析方案确认", options: ["确认,按7单元+依赖顺序生成任务", "需要修改"], recommended: "确认,按7单元+依赖顺序生成任务" }] };
  const normalized = requirementDecisionContract(source, true) as typeof source;
  assert.deepEqual(normalized.questions[0].options, ["确认并生成任务", "需要修改"]);
  assert.equal(normalized.questions[0].recommended, "确认并生成任务");
  assert.deepEqual(requirementDecisionContract(normalized, true), normalized);
  assert.equal(source.questions[0].options[0], "确认,按7单元+依赖顺序生成任务");
  assert.equal(requirementDecisionContract(source, false), source);
  const clarification = { ...source, purpose: "clarification" };
  assert.equal(requirementDecisionContract(clarification, true), clarification);
  const multiple = { questions: [...source.questions, ...source.questions] };
  assert.equal(requirementDecisionContract(multiple, true), multiple);
});

test("确认判断不将否定、备注引用或历史自由文案当作拆单授权", () => {
  for (const answer of ["不确认并生成任务", "暂不确认分析结论", "不要选择确认并生成任务", "确认,按7单元+依赖顺序生成任务"]) {
    assert.equal(confirmsRequirementGraph(answer), false);
  }
  assert.equal(confirmsRequirementGraph("确认并生成任务"), true);
  assert.equal(confirmsRequirementGraph("确认分析结论"), true);
  const source = { questions: [{ question: "处理方式", options: ["确认不生成任务", "暂不确认，生成任务前先修改"] }] };
  assert.deepEqual(requirementDecisionContract(source, true), source);
});
