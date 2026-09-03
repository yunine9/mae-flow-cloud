/**
 * 阶段注册表(问题域阶段规则单源化)的契约测试。
 *
 * 两件事:
 * ① 模块接口直测——每阶段的 label/目标/出口/允许工具与出口闸归属,
 *    门禁矩阵在注册表层面钉死(与既有工具直调矩阵互为表里);
 * ② 生成等价性对账——同一注册表分别喂简报(引导层,催办词的渲染
 *    路径)与门禁(权威层,stageAllowsTool 的查询路径),两边出的
 *    工具清单必须完全一致。历史上 conclude 的简报写着 submit_analysis、
 *    门禁却只在 analyze 放行,就是对账要拦住的漂移。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIXED_NO_TICKET_STAGES,
  FIXED_STAGE_LABELS,
  FIXED_STAGE_SPECS,
  FIXED_TICKET_STAGES,
  GATE_OPTIONS,
  STAGE_ROUTES,
  fixedStageLabel,
  gateRecommendedCode,
  gateVerdict,
  registeredStageTools,
  stageAllowsTool,
  stageGateRoute,
  stagesAllowingTool,
  stageToolLine,
  type FixedStage,
} from "../src/issueFlow/stageRegistry.ts";
import { fixedNudgeNotice } from "../src/issueFlow/prompt.ts";
import type { IssueScenario, IssueSessionState } from "../src/issueFlow/state.ts";

test("阶段注册表:每个路线的每个阶段都有 label/目标/出口/工具,conclude 只属无单", () => {
  for (const scenario of ["ticket", "no_ticket"] as const) {
    for (const stage of STAGE_ROUTES[scenario]) {
      const spec = FIXED_STAGE_SPECS[stage];
      assert.ok(spec.label.length > 0, `${scenario}/${stage} 缺 label`);
      assert.ok(spec.goal.length > 8, `${scenario}/${stage} 缺目标`);
      assert.ok(spec.exit.length > 0, `${scenario}/${stage} 缺出口`);
      assert.ok(spec.tools.length > 0, `${scenario}/${stage} 至少声明一个工具`);
      for (const tool of spec.tools) {
        assert.match(tool.name, /^[a-z_]+$/, `${stage} 的工具名须是注册名`);
      }
    }
  }
  // 场景归属:conclude 这类只属无单的阶段在路线里有明确位置。
  // (先做成员断言再做整表 deepEqual——后者会让 TS 把路线收窄成
  // 字面量元组,随后的 includes 就成了类型错误。)
  assert.ok(STAGE_ROUTES.no_ticket.includes("conclude"));
  assert.equal(STAGE_ROUTES.ticket.includes("conclude"), false);
  assert.deepEqual(STAGE_ROUTES.ticket, [...FIXED_TICKET_STAGES]);
  assert.deepEqual(STAGE_ROUTES.no_ticket, [...FIXED_NO_TICKET_STAGES]);
  // 出口动作(2026-08-28 目标驱动拍板):四阶段出口=complete_stage
  // 自报;两个举卡阶段卡工具即出口,没有 complete_stage 可绕。
  // (deploy_verify 封存下线,ADR-0013——注册表不再有它的行。)
  for (const stage of ["dts_info", "prep_repo", "fix", "mr_green"] as const) {
    assert.equal(FIXED_STAGE_SPECS[stage].exitAction, "complete_stage",
      `${stage} 的出口动作应是 complete_stage 自报`);
  }
  assert.equal(FIXED_STAGE_SPECS.analyze.exitAction, "submit_analysis");
  assert.equal(FIXED_STAGE_SPECS.conclude.exitAction, "submit_analysis");
  assert.ok(!(FIXED_TICKET_STAGES as readonly string[]).includes("deploy_verify"),
    "换库验证已封存:有单词表五阶段,不含 deploy_verify");
  // 标签:prep_repo 两场景叫法不同(无单不建分支),其余共用。
  assert.equal(fixedStageLabel("ticket", "prep_repo"), "拉取代码仓·建分支");
  assert.equal(fixedStageLabel("no_ticket", "prep_repo"), "拉取代码仓");
  assert.equal(FIXED_STAGE_LABELS.no_ticket.conclude, "确定结论");
  // 必读资源是预留列:当前没有任何阶段启用(将来上门槛逻辑时改这里)。
  for (const [stage, spec] of Object.entries(FIXED_STAGE_SPECS)) {
    assert.equal(spec.requiredResources, undefined,
      `${stage} 声明了必读资源——门槛逻辑仍未实现,先别让这列静默生效`);
  }
});

test("阶段注册表:门禁矩阵在注册表层面钉死(工读全程,出口工具各归其位)", () => {
  const allStages = [...FIXED_TICKET_STAGES, ...FIXED_NO_TICKET_STAGES];
  // 工读类(2026-08-28 拍板):fetch_logs 全程开放,dts_get_ticket 任意
  // 阶段可重查,get_issue_meta 任意阶段可查登记元信息(ADR-0003)。
  for (const scenario of ["ticket", "no_ticket"] as const) {
    for (const stage of STAGE_ROUTES[scenario]) {
      assert.equal(stageAllowsTool(scenario, stage, "fetch_logs"), true,
        `${scenario}/${stage} 的 fetch_logs 应全程开放`);
      assert.equal(stageAllowsTool(scenario, stage, "dts_get_ticket"), true,
        `${scenario}/${stage} 的 dts_get_ticket 应任意阶段可调`);
      assert.equal(stageAllowsTool(scenario, stage, "get_issue_meta"), true,
        `${scenario}/${stage} 的 get_issue_meta 应任意阶段可查`);
    }
  }
  // 出口/出厂工具各归其位(权威层矩阵,值与单源化前逐项一致)。
  assert.deepEqual(stagesAllowingTool("ticket", "submit_analysis"), ["analyze"]);
  assert.deepEqual(stagesAllowingTool("no_ticket", "submit_analysis"), ["analyze"]);
  assert.deepEqual(stagesAllowingTool("ticket", "report_ut"), ["fix"]);
  assert.deepEqual(stagesAllowingTool("ticket", "create_mr"), ["mr_green"]);
  // build_deploy 封存(ADR-0013):无阶段开放,阶段门禁恒拒。
  assert.deepEqual(stagesAllowingTool("ticket", "build_deploy"), []);
  // complete_stage 是四个自报阶段(拉单/拉仓/修复/提交MR)的出口;
  // 两个举卡阶段(分析/无单结论)卡工具即出口,不含它。
  assert.deepEqual(stagesAllowingTool("ticket", "complete_stage"),
    ["dts_info", "prep_repo", "fix", "mr_green"]);
  assert.deepEqual(stagesAllowingTool("ticket", "lookup_modules"), ["prep_repo", "analyze"]);
  // 自 prep_repo 起常开:拉仓与改绑,越往后越不收回。
  const fromPrep = FIXED_TICKET_STAGES.filter((stage) => stage !== "dts_info");
  assert.deepEqual(stagesAllowingTool("ticket", "pull_repo"), fromPrep);
  assert.deepEqual(stagesAllowingTool("ticket", "bind_module"), fromPrep);
  // 自 fix 起常开:推送。
  assert.deepEqual(stagesAllowingTool("ticket", "push_branch"),
    ["fix", "mr_green"]);
  // 无单 conclude:提交与跳过不再开放,拉仓/改绑/工读仍在。
  assert.equal(stageAllowsTool("no_ticket", "conclude", "submit_analysis"), false);
  assert.equal(stageAllowsTool("no_ticket", "conclude", "complete_stage"), false);
  assert.equal(stageAllowsTool("no_ticket", "conclude", "pull_repo"), true);
  assert.equal(stageAllowsTool("no_ticket", "conclude", "bind_module"), true);
  // 无单场景没有 fix 阶段:push_branch 无处开放(阶段门禁必拒)。
  assert.deepEqual(stagesAllowingTool("no_ticket", "push_branch"), []);
  assert.equal(stageAllowsTool("no_ticket", "conclude", "push_branch"), false);
  // 不在路线里的阶段(异常现场)一律拒绝,不放空子。
  assert.equal(stageAllowsTool("no_ticket", "dts_info", "fetch_logs"), false);
});

test("阶段注册表:出口闸归属与裁决去向(确认推进/补充回流)", () => {
  const analysis = stageGateRoute("analysis_confirm");
  assert.equal(analysis?.stage, "analyze", "报告确认闸是分析阶段的出口闸");
  assert.equal(analysis?.confirmTo, "fix", "确认后推进到问题修改");
  const conclude = stageGateRoute("conclude");
  assert.equal(conclude?.stage, "conclude", "结论闸属无单的确定结论节点");
  assert.equal(conclude?.reworkTo, "analyze", "补充意见回流问题分析");
  // env_verify 随换库验证封存(ADR-0013):无所属阶段,永不举起。
  assert.equal(stageGateRoute("env_verify"), undefined,
    "换库验证闸已封存,无阶段归属");
  assert.equal(stageGateRoute("env_needed"), undefined,
    "环境闸不绑阶段(作答口是配置表单,不走选项裁决)");
  assert.equal(stageGateRoute("push_confirm"), undefined,
    "推送过目闸不绑阶段(push_branch 的工具级硬闸,两模式同过)");
});

test("举卡决策码:码表钉死(码+文案对),分派纯函数只认 (kind, code)", () => {
  // 码表:每类闸的选项都有稳定码(协议)与人类文案(显示)。
  assert.deepEqual(GATE_OPTIONS.analysis_confirm.options.map((option) => option.code),
    ["confirm", "supplement"]);
  assert.deepEqual(GATE_OPTIONS.conclude.options.map((option) => option.code),
    ["issue", "non_issue", "supplement"]);
  assert.deepEqual(GATE_OPTIONS.env_verify.options.map((option) => option.code),
    ["pass", "fail"]);
  assert.deepEqual(GATE_OPTIONS.env_needed.options.map((option) => option.code),
    ["fill"]);
  assert.deepEqual(GATE_OPTIONS.push_confirm.options.map((option) => option.code),
    ["push", "hold"]);
  for (const [kind, table] of Object.entries(GATE_OPTIONS)) {
    for (const option of table.options) {
      assert.ok(option.label.length > 0, `${kind}/${option.code} 缺文案`);
      // 码是协议 token:小写词,不含文案碎片——文案怎么改都碰不到它。
      assert.match(option.code, /^[a-z_-]+$/, `${kind} 的码须是稳定 token`);
    }
    const codes = table.options.map((option) => option.code);
    assert.equal(new Set(codes).size, codes.length, `${kind} 决策码不得重复`);
    // 推荐码若在场,必是本行选项之一(悬空推荐=前端高亮不存在的项)。
    if (table.recommended !== undefined) {
      assert.ok(codes.includes(table.recommended),
        `${kind} 的推荐码 ${table.recommended} 不在选项中`);
    }
  }

  // 分派直测:每类闸每个码的裁决语义,与协议化之前的分支行为逐项一致。
  assert.equal(gateVerdict("analysis_confirm", "confirm"), "advance");
  assert.equal(gateVerdict("analysis_confirm", "supplement"), "rework");
  assert.equal(gateVerdict("conclude", "issue"), "suspend");
  assert.equal(gateVerdict("conclude", "non_issue"), "archive");
  assert.equal(gateVerdict("conclude", "supplement"), "rework");
  assert.equal(gateVerdict("env_verify", "pass"), "pass");
  assert.equal(gateVerdict("env_verify", "fail"), "fail");
  // 认不得的答复(自由作答/乱码):报告确认与结论按补充意见处理
  // (旧协议里非确认文本的 else 分支语义),验证闸一律打回(旧 409)。
  assert.equal(gateVerdict("analysis_confirm", "确认报告,开始问题修改"), "rework",
    "旧文案只是普通文本,不再是匹配键");
  assert.equal(gateVerdict("conclude", ""), "rework");
  assert.equal(gateVerdict("env_verify", "确认非问题,闭环归档"), "unrecognized");
  assert.equal(gateVerdict("env_verify", ""), "unrecognized");
  // env_needed 的作答口是配置表单:走到选项裁决即调用方违约,一律打回。
  assert.equal(gateVerdict("env_needed", "fill"), "unrecognized");
  // 推送过目(ADR-0009):确认=授一次性令牌;暂不推送与认不得的答复
  // 一律 hold——过目闸的 fail-open 是"不推"而不是打回。
  assert.equal(gateVerdict("push_confirm", "push"), "grant_push");
  assert.equal(gateVerdict("push_confirm", "hold"), "hold_push");
  assert.equal(gateVerdict("push_confirm", ""), "hold_push");
  assert.equal(gateVerdict("push_confirm", "先别推,改完再说"), "hold_push",
    "自由文本也是对这次推送的意见,不产令牌即可,不打回");
});

test("闸卡推荐(ADR-0004):码表定死分析确认,结论闸按提案派生,验证闸不硬给", () => {
  // 宿主能定的在码表里定死:分析确认推荐放行。
  assert.equal(gateRecommendedCode("analysis_confirm"), "confirm");
  assert.equal(gateRecommendedCode("analysis_confirm", {
    conclusion: "issue",
  }), "confirm", "非结论闸不理会提案");
  // 无单结论从 AI 提案派生:提案是问题→推荐「是问题」码,非问题同理;
  // 提案缺席不派生——宿主不替 AI 表态。
  assert.equal(gateRecommendedCode("conclude", { conclusion: "issue" }), "issue");
  assert.equal(
    gateRecommendedCode("conclude", { conclusion: "non_issue" }), "non_issue");
  assert.equal(gateRecommendedCode("conclude"), undefined,
    "提案缺席不派生");
  assert.equal(gateRecommendedCode("conclude", {}), undefined,
    "提案无结论同样不派生");
  // 宿主定不了的不硬给:换库验证通过与否只有用户知道;
  // 网管环境是语义表单,无选项天然无推荐。
  assert.equal(gateRecommendedCode("env_verify"), undefined);
  assert.equal(gateRecommendedCode("env_needed"), undefined);
  // 推送过目在码表里定死推荐「确认推送」(ADR-0009):摘要已在卡上,
  // 推荐只是标注,拍板权仍在用户;月光也不代这张卡。
  assert.equal(gateRecommendedCode("push_confirm"), "push");
});

test("生成等价性对账:同一注册表生成的简报与门禁,工具清单完全一致", () => {
  const state = (scenario: IssueScenario, stage: FixedStage): IssueSessionState => {
    const now = new Date().toISOString();
    return {
      id: "issue-registry", account: "dev",
      created_at: now, updated_at: now,
      title: "t", description: "", source: "dts", ticket: "T1",
      repo_url: "/tmp/x.git", mode: "fixed", scenario, round: 1,
      stage_states: STAGE_ROUTES[scenario].map(() => "pending"),
      status: "running", stage, stage_note: "", stage_at: now,
    };
  };
  const universe = registeredStageTools();
  assert.ok(universe.includes("create_mr") && universe.includes("pull_repo"),
    "枚举域应覆盖全部登记工具");
  for (const scenario of ["ticket", "no_ticket"] as const) {
    for (const stage of STAGE_ROUTES[scenario]) {
      // 引导层:走催办词的真实渲染路径("可用工具"行,开场词/交接词同源)。
      const notice = fixedNudgeNotice(state(scenario, stage), 1, 2);
      assert.match(notice,
        new RegExp(`当前阶段「${fixedStageLabel(scenario, stage)}」`),
        `${scenario}/${stage} 简报要带场景正确的阶段名`);
      const line = notice.split("\n")
        .find((row) => row.startsWith("可用工具: "));
      assert.ok(line, `${scenario}/${stage} 简报缺可用工具行`);
      const briefTools = line!.slice("可用工具: ".length).split("、")
        .map((name) => name.replace(/[（(].*[)）]$/, "").trim());
      // 权威层:门禁查询路径对同一阶段放行的工具全集。
      const gateTools = universe
        .filter((tool) => stageAllowsTool(scenario, stage, tool));
      assert.deepEqual([...briefTools].sort(), [...gateTools].sort(),
        `${scenario}/${stage} 简报与门禁的工具清单漂移——AI 被告知能用的`
        + "与实际调通的必须同源");
    }
  }
  // 渲染注记不参与门禁:同一条目带 note 与不带 note 放行结果一致。
  assert.match(stageToolLine("analyze"), /dts_get_ticket\(重查\)/);
  assert.equal(stageAllowsTool("ticket", "analyze", "dts_get_ticket"), true);
});
