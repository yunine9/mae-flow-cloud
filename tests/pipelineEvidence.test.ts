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

test("CodeCheck 状态明细必须带文件行号；只有页面 URL 仍算缺证据", () => {
  const located = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", job: "codecheck",
      details: [{
        file: "src/TextUtil.java", line: 22, rule: "ARCH-UTIL-02",
        message: "Unicode 空白策略应迁出工具类",
      }],
    }],
    artifacts: [],
    failureSummary: "FAILED stage=CodeCheck",
  });
  assert.deepEqual(located.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(located.missingDimensions, []);

  const urlOnly = assessPipelineRepairEvidence({
    checks: [{ dimension: "CODECHECK", status: "failed", job: "codecheck" }],
    artifacts: [],
    failureSummary: "FAILED stage=CodeCCP2.0 job=CodeCCP2.0 detail: "
      + "https://codecheck.intra.example/tasks/123",
  });
  assert.deepEqual(urlOnly.availableDimensions, []);
  assert.deepEqual(urlOnly.missingDimensions, ["CODECHECK"]);
});

test("识别内网 CodeCheck 真实 fileName/lineNum/indicatorName 字段", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
    }],
    artifacts: [{
      name: "codecheck_detail.json",
      text: JSON.stringify({ defects: [{
        tool: "codecheck",
        ruleId: "45deed5a4d6140c8b10884643f930bc3",
        indicatorName: "G.FUN.01-CPP 函数功能要单一",
        fileName: "service/HandleAdvice/AcceptNRAdviceMML.hpp",
        lineNum: 13,
        description: "函数行数建议不超过 50 行",
        yellowResult: false,
      }] }),
    }],
  });
  assert.deepEqual(result.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(result.missingDimensions, []);
});

/** 前端测试 runner(Jest)真实输出形态(脱敏自 issue-28 的构建日志):
 * 旧 UT 尺子按 C/C++/Maven 写,这三类特征行一个都不中。 */
const JEST_LOG = [
  "FAIL  src/_tests_/containers/CrossRatCollection/KpiTaskList.test.jsx (5.426 s)",
  "  ● KpiTaskList › detail dialog header labels use consistent colon style",
  "    expect(received).toBeTruthy()",
  "    Received: undefined",
  "",
  "      602 |   expect(detailBtn).toBeTruthy();",
  "    at Object.<anonymous> "
    + "(src/_tests_/containers/CrossRatCollection/KpiTaskList.test.jsx:602:27)",
  "Test Suites: 1 failed, 34 passed, 35 total",
  "Tests: 1 failed, 449 passed, 450 total",
].join("\n");

test("前端 runner(Jest/Mocha)失败特征让 UT 维度从构建日志拿到证据", () => {
  const utFailed = [{ dimension: "UT" as const, status: "failed" as const }];
  const assess = (text: string) => assessPipelineRepairEvidence({
    checks: utFailed,
    artifacts: [{ name: "build_log_ut-1.txt", text }],
  });
  for (const [feature, sample] of [
    ["FAIL 行", "FAIL  src/_tests_/KpiTaskList.test.jsx (5.426 s)"],
    ["Test Suites 汇总", "Test Suites: 1 failed, 34 passed, 35 total"],
    ["Tests 汇总", "Tests: 1 failed, 449 passed, 450 total"],
    ["Mocha failing 计数", "  2 failing\n  1) KpiTaskList detail dialog"],
  ] as const) {
    const result = assess(sample);
    assert.deepEqual(result.availableDimensions, ["UT"],
      `${feature} 应让 UT 维度拿到证据`);
    assert.deepEqual(result.missingDimensions, [],
      `${feature} 在场时 UT 不算缺口`);
    assert.ok(result.sources.UT?.includes("build_log_ut-1.txt"),
      `${feature} 的证据来源是构建日志本身`);
  }
  const full = assess(JEST_LOG);
  assert.deepEqual(full.availableDimensions, ["UT"]);
  assert.deepEqual(full.missingDimensions, []);
});

test("复合构建工具的 record 被归到编译维时，日志内容仍按 UT 背书", () => {
  // 真实形态:CodeCCP2.0 下 build2.0 跑 JS UT,defects[].toolName=build2.0
  // 被 record-id 归类硬映射成编译维;日志内容嗅探才是权威,映射降级为
  // 弱提示,两者并集背书。
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed", tool: "build2.0" }],
    artifacts: [
      {
        name: "pipeline_info.json",
        text: JSON.stringify({ defects: [
          { toolName: "build2.0", record_ids: ["3BW2BKXV-UT"] },
        ] }),
      },
      { name: "build_log_3BW2BKXV-UT.txt", text: JEST_LOG },
    ],
  });
  assert.deepEqual(result.availableDimensions, ["UT"]);
  assert.deepEqual(result.missingDimensions, []);
  assert.ok(result.sources.UT?.includes("build_log_3BW2BKXV-UT.txt"),
    "内容嗅探(强信号)把 UT 日志背书给 UT 维");
  assert.ok(result.sources.COMPILE?.includes("build_log_3BW2BKXV-UT.txt"),
    "record-id 归类(弱提示)的并集背书保留");
});

test("无强特征的日志不因嗅探放宽而冒充证据", () => {
  const result = assessPipelineRepairEvidence({
    checks: [{ dimension: "UT", status: "failed" }],
    artifacts: [{
      name: "build_log_plain.txt",
      text: "build finished with warnings; quality gate not met",
    }],
  });
  assert.deepEqual(result.availableDimensions, [],
    "没有失败特征/堆栈的日志什么维度都不背书");
  assert.deepEqual(result.missingDimensions, ["UT"]);
  assert.deepEqual(result.fallbackSources, [],
    "没有可定位内容的日志也不进跨维度兜底");
});

test("堆栈行参与全量日志判定：测试文件堆栈归 UT，业务文件堆栈归编译", () => {
  const assess = (text: string, dims: Array<{
    dimension: "UT" | "COMPILE";
  }>) => assessPipelineRepairEvidence({
    checks: dims.map((dimension) => ({ ...dimension, status: "failed" as const })),
    artifacts: [{ name: "build_log_stack.txt", text }],
  });
  const utStack = assess(
    "at Object.<anonymous> (src/_tests_/KpiTaskList.spec.tsx:88:11)",
    [{ dimension: "UT" }]);
  assert.deepEqual(utStack.availableDimensions, ["UT"],
    "测试文件的 path:line 堆栈按内容归 UT");

  // 编译维与 UT 同时红:业务文件堆栈按内容背书编译维;UT 拿不到
  // (该日志未被 UT 认领,也不能拿编译堆栈替 UT 背书)。
  const compileStack = assess("at create (src/service/Order.java:88)",
    [{ dimension: "UT" }, { dimension: "COMPILE" }]);
  assert.deepEqual(compileStack.availableDimensions, ["COMPILE"],
    "业务文件的 path:line 堆栈按内容归编译维");
  assert.deepEqual(compileStack.missingDimensions, ["UT"]);
  assert.deepEqual(compileStack.fallbackSources, [],
    "日志已被失败维度(编译)认领,不再跨维度兜底给 UT");
});

test("CodeCheck lineNum=0 表示整文件或 MR 级规则，不误判成无报错", () => {
  const artifact = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
    }],
    artifacts: [{
      name: "codecheck_detail.json",
      text: JSON.stringify({ defects: [{
        fileName: "service/Advice.cpp",
        lineNum: 0,
        indicatorName: "ARCH.MR.01 变更范围违反架构约束",
        description: "本次变更跨越了禁止依赖的模块边界",
      }] }),
    }],
  });
  assert.deepEqual(artifact.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(artifact.missingDimensions, []);

  const structured = assessPipelineRepairEvidence({
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "codecheck",
      details: [{
        file: "service/Advice.cpp", line: 0,
        rule: "ARCH.MR.01", message: "本次变更违反架构约束",
      }],
    }],
    artifacts: [],
  });
  assert.deepEqual(structured.availableDimensions, ["CODECHECK"]);
  assert.deepEqual(structured.missingDimensions, []);
});
