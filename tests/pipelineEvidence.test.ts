import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPipelineRepairEvidence } from "../src/pipelineEvidence.ts";

const checks = [
  { dimension: "COMPILE" as const, status: "failed" as const,
    tool: "build2.0" },
  { dimension: "UT" as const, status: "failed" as const,
    tool: "CPP_UT" },
  { dimension: "CODECHECK" as const, status: "failed" as const,
    tool: "CodeCheck" },
];

test("流水线证据逐维对齐，材料包非空不能掩盖缺失维度", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [
      {
        name: "pipeline_info.json",
        text: JSON.stringify({ defects: [
          { toolName: "build2.0", record_ids: ["compile-rid"] },
          { toolName: "CPP_UT", record_ids: ["ut-rid"] },
        ] }),
      },
      {
        name: "build_log_compile-rid.txt",
        text: "src/main.cpp:42: error: Widget was not declared",
      },
      {
        name: "codecheck_detail.json",
        text: JSON.stringify({ defects: [{
          file: "src/main.cpp", line: 42, rule: "G.FUN.01-CPP",
          message: "function is too long",
        }] }),
      },
      {
        name: "pipeline_log_summary.json",
        text: JSON.stringify({ strategies: {
          coverage: { status: "failed", note: "jobId 不被 codecov 识别" },
        } }),
      },
    ],
  });

  assert.deepEqual(result.availableDimensions.sort(), ["CODECHECK", "COMPILE"]);
  assert.deepEqual(result.missingDimensions, ["UT"]);
  assert.match(result.reasons.UT?.join(" ") ?? "", /jobId/);
});

test("只有汇总计数或 No data 不冒充可定位证据", () => {
  const result = assessPipelineRepairEvidence({
    checks: checks.slice(1),
    artifacts: [
      { name: "codecheck_detail.json",
        text: JSON.stringify({ defectCount: 3, status: "failed" }) },
      { name: "coverage_diff_bad.json", text: "No data found" },
    ],
  });
  assert.deepEqual(result.availableDimensions, []);
  assert.deepEqual(result.missingDimensions, ["UT", "CODECHECK"]);
});

test("人工回灌只覆盖系统当时明确求助的维度", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [],
    humanEvidence: {
      dimensions: ["CODECHECK"],
      text: "src/main.cpp:42 G.FUN.01-CPP function is too long",
    },
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(result.missingDimensions, ["COMPILE", "UT"]);
});

test("终态摘要按内容归维，不以一段文字替全部红灯背书", () => {
  const result = assessPipelineRepairEvidence({
    checks,
    artifacts: [],
    failureSummary: "BUILD FAILURE: src/main.cpp:9: error: missing.hpp not found",
  });
  assert.deepEqual(result.availableDimensions, ["COMPILE"]);
  assert.deepEqual(result.missingDimensions, ["UT", "CODECHECK"]);
});
