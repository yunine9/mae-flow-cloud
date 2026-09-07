import test from "node:test";
import assert from "node:assert/strict";
import { reanchorRequirementAnnotations, unanchoredRequirementChanges } from "../src/requirementDocument.ts";

const image = "![跨制式KPI分析界面-跨制式自侦测任务列表](.mae-flow-work/review-assets/000000000000000000000000.png)";
const before = ["# 需求", "", "第一段说明", "", "**结论：涉及**", image, "", "独立约束必须保留"].join("\n");
const after = before.replace("**结论：涉及**", "**结论：不涉及**");

test("跨段批注已明确选中图片结论段，末行必须计入允许修改的范围", () => {
  assert.deepEqual(unanchoredRequirementChanges(before, after,
    [{ anchor: "第一段说明", line: 3, line_end: 6 }]), []);
});

test("只选第一段时，改动后面的图片结论仍然拒收", () => {
  assert.deepEqual(unanchoredRequirementChanges(before, after,
    [{ anchor: "第一段说明", line: 3 }]),
  [`**结论：涉及** ${image}`.slice(0, 40)]);
});

test("跨段范围包含末行但不能越过末行扩到后面的独立约束", () => {
  assert.deepEqual(unanchoredRequirementChanges(before,
    after.replace("独立约束必须保留", "无约束"),
    [{ anchor: "第一段说明", line: 3, line_end: 6 }]), ["独立约束必须保留"]);
});

test("前一轮插入内容造成行漂移，渲染后的加粗锚点应定位到当前图片结论段", () => {
  const shifted = "新增一段\n\n" + before;
  const notes = [{ anchor: "结论：涉及", line: 5 }];
  assert.deepEqual(reanchorRequirementAnnotations(shifted, notes), [{ anchor: "结论：涉及", line: 7 }]);
  assert.equal(notes[0].line, 5, "不能改写原始批注台账");
  assert.deepEqual(unanchoredRequirementChanges(shifted,
    shifted.replace("**结论：涉及**", "**结论：不涉及**"), notes), []);
  assert.deepEqual(unanchoredRequirementChanges(shifted,
    shifted.replace("第一段说明", "误改了旧行号所在段"), notes), ["第一段说明"]);
});

test("跨段批注漂移时起止行一起调整，不丢失后半段的授权", () => {
  const shifted = "新增一段\n\n" + before;
  const notes = [{ anchor: "第一段说明", line: 3, line_end: 6 }];
  assert.deepEqual(reanchorRequirementAnnotations(shifted, notes),
    [{ anchor: "第一段说明", line: 5, line_end: 8 }]);
  assert.deepEqual(unanchoredRequirementChanges(shifted,
    "新增一段\n\n" + after, notes), []);
});
