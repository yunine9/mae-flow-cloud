/**
 * 登记描述预填模板(#273):原样判定纯函数契约——模板原样、仅空白
 * 流转(编辑器序列化往返)都算未填;真实填写/清空不算。登记页靠它
 * 拦「空模板绕过必填、白跑首轮会话」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_DESCRIPTION_TEMPLATE,
  isUntouchedTemplate,
} from "../web/src/issues/descriptionTemplate.ts";

test("模板原样与仅空白流转都判未填(剥空白比较)", () => {
  assert.equal(isUntouchedTemplate(ISSUE_DESCRIPTION_TEMPLATE), true);
  // 编辑器序列化往返会动空白:换行归一、列表空隙增删,内容一字未动。
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace(/\n/g, "\n\n")), true);
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace(/[ \t]+/g, " ")), true);
  assert.equal(isUntouchedTemplate(`  ${ISSUE_DESCRIPTION_TEMPLATE}  `), true);
});

test("真实填写与清空都判已填", () => {
  assert.equal(isUntouchedTemplate(""), false);
  assert.equal(isUntouchedTemplate("   \n  "), false);
  assert.equal(isUntouchedTemplate(
    ISSUE_DESCRIPTION_TEMPLATE.replace("发生时间：", "发生时间：2026/9/16 10:00")),
  false);
  assert.equal(isUntouchedTemplate(
    "## 现象\n\n服务重启后持续 500,截图如下。\n"), false);
});

test("模板含全部引导槽位:基本信息/触发条件/步骤/现象/预期结果", () => {
  for (const slot of ["发生时间", "版本", "复现概率", "触发条件",
    "操作步骤", "实际现象", "预期结果"]) {
    assert.match(ISSUE_DESCRIPTION_TEMPLATE, new RegExp(slot),
      `模板缺引导槽位: ${slot}`);
  }
  // 业务模块与网管环境登记表单单独采集,不重复进模板(#273 拍板)。
  assert.doesNotMatch(ISSUE_DESCRIPTION_TEMPLATE, /业务模块|网管环境/);
});
