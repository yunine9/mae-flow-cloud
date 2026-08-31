/**
 * 固定流程的阶段注册表——阶段规则的唯一事实源(问题域自有,不进内核)。
 *
 * 此前阶段知识散在三处,改一个阶段要同步三处,还会静默漂移:阶段简报
 * (prompt.ts 的 FIXED_STAGE_BRIEFS,引导层)手工复写每阶段的工具清单;
 * 工具门禁白名单(tools.ts 的 gateStage/gateStageFrom 调用点,权威层)
 * 独立硬编码;闸门裁决(service.ts 的 resolveGate)里另有写死的阶段
 * 分支。漂移有实锤:无单 conclude 的简报写着 submit_analysis,门禁却
 * 只在 analyze 放行——AI 被告知能用的工具,调用会被机械拒绝。
 *
 * 现在一张表定规矩:每个阶段一行,声明显示名(label)、目标(goal)、
 * 出口(exit)、出口动作(exitAction)、开放工具(tools)与出口闸
 * (gate);无单三节点与有单七阶段共用同一机制(prep_repo/analyze
 * 两场景同格,conclude 只属无单路线)。阶段简报、门禁白名单、裁决
 * 阶段分支全部由本表生成——简报与门禁读同一列 tools,引导层说能用
 * 的与权威层放行的永远一致;工具回执的交接文案也走本表的
 * stageBriefLines,不再手写。往后给阶段加技能/资料门槛只是加一列
 * requiredResources(本版只预留字段,不实现门槛逻辑)。
 *
 * 词表与路线也住这里:阶段推进的机械操作(fixedAdvance 等)留在
 * state.ts,它们查本表的路线;本表只声明规则,不做任何状态变更。
 */

import type { AnyIssueStage, IssueGateKind, IssueScenario } from "./state.ts";

// ---- 阶段词表与路线 ----

/** 有单场景七阶段。 */
export const FIXED_TICKET_STAGES = [
  "dts_info",      // 获取 DTS 单信息(通读单据后 complete_stage 自报收口)
  "prep_repo",     // 拉取代码仓+创建分支(拉齐后 complete_stage 自报收口,无需代码仓也由它跳过)
  "analyze",       // 问题分析:证据链定位,产出四要素分析报告(submit_analysis 触发人工闸)
  "fix",           // 问题修改(complete_stage 自报完成)
  "ut",            // UT 验证(report_ut 事实上报;结果可接受后 complete_stage 收口)
  "mr_green",      // 提交 MR+流水线跑绿(建齐 MR 后 complete_stage 申报清单,平台验绿放行)
  "deploy_verify", // 换库环境验证(build_deploy 部署后平台闸等用户真实验证)
] as const;

/** 无单场景三节点:测试/开发自行定位用,结论"是问题"→挂起待关联。 */
export const FIXED_NO_TICKET_STAGES = [
  "prep_repo",     // 拉取代码仓(无单不建分支——分支名规范需要单号)
  "analyze",       // 问题分析(同有单,产出报告)
  "conclude",      // 确定结论(平台闸:是问题→挂起 / 非问题→闭环)
] as const;

/** 固定流程的阶段键。与自由词表刻意不同名:两套语义并存,UI 按
 * 会话模式选词表渲染,不互相污染。 */
export type FixedStage =
  | (typeof FIXED_TICKET_STAGES)[number]
  | (typeof FIXED_NO_TICKET_STAGES)[number];

// ---- 注册表本体:每阶段一行 ----

/** 阶段开放的一个平台工具。name 是工具工厂里的注册名(门禁按它比对);
 * note 只是简报里的用途注记(如「重查」),不参与门禁。 */
export interface IssueStageTool {
  name: string;
  note?: string;
}

/** 阶段出口举的平台闸与裁决后的阶段去向。resolveGate 的阶段分支
 * 查这里——确认后推进到哪(confirmTo)、补充意见后回流到哪
 * (reworkTo)都是阶段知识,不再写在裁决代码里。 */
export interface IssueStageGate {
  kind: IssueGateKind;
  /** 用户确认/通过出口闸后推进到的阶段。 */
  confirmTo?: FixedStage;
  /** 用户补充意见后回到的阶段(同域返工,不换问题)。 */
  reworkTo?: FixedStage;
}

/** 阶段出口动作——每个阶段有且只有一个出口,全流程只有两种形态:
 * complete_stage = AI 判断目标达成后自报收口(平台不核实其工作事实);
 * 其余值 = 卡工具本身(submit_analysis/build_deploy)就是出口,举卡
 * 阶段没有 complete_stage 可绕。本列是声明与对账用:门禁白名单仍以
 * tools 列为准,两列不一致在测试里当场红。 */
export type StageExitAction =
  | "complete_stage"
  | "submit_analysis"
  | "build_deploy";

export interface IssueStageSpec {
  /** 阶段显示名(有单口径;无单不同的用 noTicketLabel 覆写)。 */
  label: string;
  /** 无单场景的显示名覆写(目前只有 prep_repo:无单不建分支)。 */
  noTicketLabel?: string;
  /** 阶段目标(提示词引导层:这个阶段干什么)。 */
  goal: string;
  /** 出口——"到什么程度算完"的白纸黑字,停机合法性只认出口动作。 */
  exit: string;
  /** 出口动作(见 StageExitAction):五阶段=complete_stage 自报;
   * 三个举卡阶段=卡工具本身。 */
  exitAction: StageExitAction;
  /** 本阶段开放的平台工具。引导层(简报的"可用工具")与权威层
   * (工具门禁白名单)读同一列——两边的工具清单由构造保证一致。 */
  tools: readonly IssueStageTool[];
  /** 必读资源扩展位(技能/资料门槛的预留列):本版只声明,不实现
   * 门槛逻辑;哪天要"没读过不许出阶段",加数据不加机制。 */
  requiredResources?: readonly string[];
  /** 出口闸(仅出口举闸的阶段声明;env_needed 不绑阶段,不在此列)。 */
  gate?: IssueStageGate;
}

/**
 * 阶段注册表。工具列 = 该阶段门禁实际放行的全集(含工读类:
 * fetch_logs 全程开放、dts_get_ticket 任意阶段可重查、get_issue_meta
 * 任意阶段可查登记元信息,2026-08-28 拍板"作业自由,门只守流程出口
 * 与出厂动作",所以它们每行都在)。
 */
export const FIXED_STAGE_SPECS: Record<FixedStage, IssueStageSpec> = {
  dts_info: {
    label: "获取 DTS 单信息",
    goal: "调 dts_get_ticket 拉全单据详情,通读现象与处理历史",
    exit: "通读单据后 complete_stage 收口(dts_get_ticket 成功返回只是材料到位,不自动推进)",
    exitAction: "complete_stage",
    tools: [
      { name: "dts_get_ticket" },
      { name: "complete_stage" },
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
    ],
  },
  prep_repo: {
    label: "拉取代码仓·建分支",
    noTicketLabel: "拉取代码仓",
    goal: "把代码仓拉齐:lookup_modules 按单据里的业务关键词检索模块,"
      + "命中就 bind_module 登记它的仓,再逐个 pull_repo 拉取(有单场景"
      + "平台会顺带切好修复分支);检索不到就 AskUserQuestion 问用户要"
      + "仓地址再 pull_repo。本单无需代码改动则直接 complete_stage 跳过",
    exit: "要用的仓都 pull_repo 落地 → complete_stage 收口;无需代码仓则直接 complete_stage 跳过",
    exitAction: "complete_stage",
    tools: [
      { name: "lookup_modules" },
      { name: "bind_module" },
      { name: "pull_repo" },
      { name: "complete_stage" },
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
    ],
  },
  analyze: {
    label: "问题分析",
    goal: "按证据链定位(方法论取用/分流/取证规范见技能 issue-analysis),"
      + "产出 issue-analysis.md(结论/证据链/置信度/下一步建议),"
      + "然后 submit_analysis 提交(无单场景需带结论 issue/non_issue)。"
      + "中途发现还缺仓,pull_repo 随时可补",
    exit: "issue-analysis.md 完成 → submit_analysis 提交并等平台举卡",
    exitAction: "submit_analysis",
    tools: [
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket", note: "重查" },
      { name: "lookup_modules" },
      { name: "bind_module" },
      { name: "pull_repo", note: "补仓" },
      { name: "submit_analysis" },
    ],
    gate: { kind: "analysis_confirm", confirmTo: "fix" },
  },
  fix: {
    label: "问题修改",
    goal: "按已确认的方案实施修复(多仓问题在涉及的每个仓里改,"
      + "用 bash 直接改码);改完自检通过后 complete_stage 自报完成",
    exit: "所有涉及的仓改完且自检通过 → complete_stage 自报完成",
    exitAction: "complete_stage",
    tools: [
      { name: "fetch_logs", note: "补证据" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo", note: "补仓" },
      { name: "bind_module" },
      { name: "push_branch" },
      { name: "complete_stage" },
    ],
  },
  ut: {
    label: "UT 验证",
    goal: "在改过的代码仓里用 bash 跑单元测试;每轮结果用 report_ut 如实上报"
      + "(事实上报:平台只记账,不推进、不设门)",
    exit: "测试结果可接受(通常全绿)→ complete_stage 收口(report_ut 只是记账,不是出口)",
    exitAction: "complete_stage",
    tools: [
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
      { name: "bind_module" },
      { name: "push_branch" },
      { name: "report_ut" },
      { name: "complete_stage" },
    ],
  },
  mr_green: {
    label: "提交 MR·跑绿",
    goal: "对**每个改过的仓**分别 push_branch + create_mr(一仓一 MR,"
      + "仓参数别漏);然后调 complete_stage 必带 mrs 申报 MR 清单,"
      + "平台验绿放行:清单=台账+流水线全绿,红打回、在跑受理等绿",
    exit: "对每个改过的仓 push_branch + create_mr,然后 complete_stage 申报 MR 清单"
      + "(平台按台账与流水线验绿:全绿当场进下一阶段,有红当场打回,在跑受理等绿)",
    exitAction: "complete_stage",
    tools: [
      { name: "push_branch" },
      { name: "create_mr" },
      { name: "complete_stage", note: "申报 MR 清单" },
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
      { name: "bind_module" },
    ],
  },
  deploy_verify: {
    label: "换库环境验证",
    goal: "调 build_deploy 换库部署(多仓时用 repo 参数指定要部署的仓);"
      + "部署完成平台举验证卡,停下等用户真实验证",
    exit: "build_deploy 部署完成 → 平台举「环境验证」卡等用户",
    exitAction: "build_deploy",
    tools: [
      { name: "build_deploy" },
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
      { name: "bind_module" },
      { name: "push_branch" },
    ],
    gate: { kind: "env_verify" },
  },
  conclude: {
    label: "确定结论",
    goal: "submit_analysis 提交结论(是问题/非问题)——本场景没有修改与交付环节",
    exit: "结论明确 → submit_analysis 提交并等平台举「结论确认」卡",
    exitAction: "submit_analysis",
    // 出口动作 submit_analysis 是在 analyze 调的(调完即推进到本节点
    // 等闸),本阶段不再放行它——工具列以门禁真相为准,简报不谎报。
    tools: [
      { name: "fetch_logs" },
      { name: "get_issue_meta" },
      { name: "dts_get_ticket" },
      { name: "pull_repo" },
      { name: "bind_module" },
    ],
    gate: { kind: "conclude", reworkTo: "analyze" },
  },
};

/** 场景 → 阶段路线(顺序即流程)。 */
export const STAGE_ROUTES: Record<IssueScenario, readonly FixedStage[]> = {
  ticket: FIXED_TICKET_STAGES,
  no_ticket: FIXED_NO_TICKET_STAGES,
};

export function fixedStages(scenario: IssueScenario): readonly FixedStage[] {
  return STAGE_ROUTES[scenario];
}

/** 固定流程路线里的位次(自由词表的值不在任何路线里,一律 -1)。 */
export function fixedStageIndex(
  scenario: IssueScenario, stage: AnyIssueStage,
): number {
  return STAGE_ROUTES[scenario].indexOf(stage as FixedStage);
}

/** 阶段显示名(按场景取词;prep_repo 两场景叫法不同)。 */
export function fixedStageLabel(scenario: IssueScenario, stage: FixedStage): string {
  const spec = FIXED_STAGE_SPECS[stage];
  return scenario === "no_ticket" && spec.noTicketLabel
    ? spec.noTicketLabel
    : spec.label;
}

/** 场景 × 阶段的完整显示名词表(state.ts 沿用的导出形状)。 */
export const FIXED_STAGE_LABELS: Record<IssueScenario, Record<FixedStage, string>> = {
  ticket: Object.fromEntries(
    (Object.keys(FIXED_STAGE_SPECS) as FixedStage[]).map((stage) =>
      [stage, fixedStageLabel("ticket", stage)]),
  ) as Record<FixedStage, string>,
  no_ticket: Object.fromEntries(
    (Object.keys(FIXED_STAGE_SPECS) as FixedStage[]).map((stage) =>
      [stage, fixedStageLabel("no_ticket", stage)]),
  ) as Record<FixedStage, string>,
};

/** 阶段规格(fail-loud:未知阶段当场响,不让 undefined 溜进提示词)。 */
export function fixedStageSpec(stage: FixedStage): IssueStageSpec {
  const spec = FIXED_STAGE_SPECS[stage];
  if (!spec) {
    throw new Error(`固定流程没有这个阶段: ${String(stage)}`);
  }
  return spec;
}

// ---- 门禁视角(权威层:工具工厂的越权拒绝查这里) ----

/** 这个阶段放行这个工具吗。stage 不在场景路线里(异常现场)一律拒绝。 */
export function stageAllowsTool(
  scenario: IssueScenario, stage: FixedStage, tool: string,
): boolean {
  if (!STAGE_ROUTES[scenario].includes(stage)) return false;
  return FIXED_STAGE_SPECS[stage]?.tools.some((entry) => entry.name === tool)
    ?? false;
}

/** 反查:某工具在本场景的哪些阶段开放(拒绝文案的"允许的阶段")。 */
export function stagesAllowingTool(
  scenario: IssueScenario, tool: string,
): FixedStage[] {
  return STAGE_ROUTES[scenario].filter((stage) =>
    stageAllowsTool(scenario, stage, tool));
}

/** 注册表登记过的全部工具名(等价性对账的枚举域)。 */
export function registeredStageTools(): string[] {
  const names: string[] = [];
  for (const spec of Object.values(FIXED_STAGE_SPECS)) {
    for (const tool of spec.tools) {
      if (!names.includes(tool.name)) names.push(tool.name);
    }
  }
  return names;
}

// ---- 简报视角(引导层:提示词的"可用工具"行查这里) ----

/** 阶段简报的工具行:与门禁同一列 tools,只多渲染用途注记。 */
export function stageToolLine(stage: FixedStage): string {
  return fixedStageSpec(stage).tools
    .map((tool) => (tool.note ? `${tool.name}(${tool.note})` : tool.name))
    .join("、");
}

/** 阶段简报三行(引导层单点):当前阶段「X」:goal / 出口:exit /
 * 可用工具:tools。开场词、交接词、催办词、工具回执共用——工具回执
 * 也从这里生成,消灭手写交接文案;label 按场景取词(prep_repo 两
 * 场景叫法不同)。 */
export function stageBriefLines(
  scenario: IssueScenario, stage: FixedStage,
): string[] {
  const spec = fixedStageSpec(stage);
  return [
    `当前阶段「${fixedStageLabel(scenario, stage)}」: ${spec.goal}`,
    `出口(到什么程度算完): ${spec.exit}`,
    `可用工具: ${stageToolLine(stage)}`,
  ];
}

// ---- 举卡决策码(裁决协议:按码分派,文案只管显示) ----

/** 闸卡的一个选项。code 是裁决协议(resolveGate 按 code 单点分派,
 * 前端提交回传 code);label 只是给人看的文案——改文案零协议后果,
 * 旧协议里文案前缀/包含就是匹配键,改一个字裁决静默 409(实锤债务)。 */
export interface GateOption {
  code: string;
  label: string;
}

/** 每类闸的码表行:选项整表 + 推荐码(ADR-0004 平台闸同款推荐)。
 * recommended 是宿主能定的推荐(值为 options 里的码,前端按它标
 * 「AI 推荐」);宿主定不了的留空——无单结论从 AI 的结论提案派生
 * (见 gateRecommendedCode),换库验证通过与否只有用户知道,不硬给。 */
export interface GateOptionTable {
  options: readonly GateOption[];
  /** 宿主码表定死的推荐码;缺省=该闸不由码表定推荐。 */
  recommended?: string;
}

/** 每类闸的码表(码+文案对,附推荐码)。raiseGate 举卡时整表投影进
 * 闸卡,resolveGate 按码裁决,前端渲染 label、提交 code——文案的定义
 * 地只此一处,「改字两处要同步」的自警从此作废。 */
export const GATE_OPTIONS: Record<IssueGateKind, GateOptionTable> = {
  analysis_confirm: {
    // 分析确认的推荐就是放行:报告已过 submit_analysis 的文件门票,
    // 平台没有更多事实可核,推荐摇摆只会把用户拖回追问循环。
    options: [
      { code: "confirm", label: "确认报告,开始问题修改" },
      { code: "supplement", label: "有补充意见(填写补充说明)" },
    ],
    recommended: "confirm",
  },
  conclude: {
    // 结论推荐跟 AI 提案走(提案是问题→推荐「是问题」码),不在此定死。
    options: [
      { code: "issue", label: "确认是问题,挂起等提单" },
      { code: "non_issue", label: "确认非问题,闭环归档" },
      { code: "supplement", label: "有补充意见(填写补充说明)" },
    ],
  },
  env_verify: {
    options: [
      { code: "pass", label: "验证通过" },
      { code: "fail", label: "验证发现问题(填写补充说明)" },
    ],
  },
  // env_needed 在决策卡上渲染为专用表单(地址+密码),作答口是
  // /environment,不走选项裁决;这个选项只是卡面占位,自然无推荐。
  env_needed: {
    options: [
      { code: "fill", label: "填写并继续" },
    ],
  },
};

/** 闸卡的推荐码(questions[].recommended 与 Agent 卡同一键)。分析
 * 确认取码表定死值;无单结论按 AI 提案派生——提案是问题→推荐
 * 「是问题」码,非问题同理;提案缺席不派生,宿主不替 AI 表态。 */
export function gateRecommendedCode(
  kind: IssueGateKind,
  proposal?: { conclusion?: "issue" | "non_issue" },
): string | undefined {
  if (kind === "conclude") return proposal?.conclusion;
  return GATE_OPTIONS[kind].recommended;
}

/** 码 → 文案(显示语义的还原:现场账与续聊提示词里永远是人话)。 */
export function gateOptionLabel(kind: IssueGateKind, code: string): string {
  const option = GATE_OPTIONS[kind]?.options.find((item) => item.code === code);
  return option?.label ?? code;
}

/** 闸裁决的语义动作(与改造前的分支行为逐项对齐)。分派是纯函数:
 * 只认 (kind, code),中文文案根本不是输入——文案怎么改都动不了它。 */
export type GateVerdict =
  | "advance"       // analysis_confirm+confirm:推进到 confirmTo
  | "rework"        // 有补充意见/自由作答:留在或回流分析
  | "suspend"       // conclude+issue:挂起待关联单号
  | "archive"       // conclude+non_issue:闭环归档
  | "pass"          // env_verify+pass:验证通过收尾
  | "fail"          // env_verify+fail:验证不通过回退
  | "unrecognized"; // 认不得的答复(仅 env_verify 打回,其余按补充意见)

/** 决策码分派单点。语义钉死:
 * - analysis_confirm:confirm 推进;其余(补充意见码/自由文本)一律
 *   留在分析阶段完善重提——与旧 startsWith 前缀匹配的 else 分支一致;
 * - conclude:issue 挂起 / non_issue 闭环;其余回流分析(旧的
 *   includes 匹配同样认不得就回流);
 * - env_verify:pass 收尾 / fail 回退;认不得的原样 409(旧语义:
 *   验证闸不允许自由发挥)。 */
export function gateVerdict(kind: IssueGateKind, code: string): GateVerdict {
  switch (kind) {
    case "analysis_confirm":
      return code === "confirm" ? "advance" : "rework";
    case "conclude":
      if (code === "issue") return "suspend";
      if (code === "non_issue") return "archive";
      return "rework";
    case "env_verify":
      if (code === "pass") return "pass";
      if (code === "fail") return "fail";
      return "unrecognized";
    case "env_needed":
      // 作答口是配置表单;走到选项裁决即调用方违约,一律打回。
      return "unrecognized";
  }
}

// ---- 闸门裁决视角(resolveGate 的阶段分支查这里) ----

export interface StageGateRoute {
  /** 举这个闸的阶段(出口动作所在)。 */
  stage: FixedStage;
  kind: IssueGateKind;
  /** 确认/通过后推进到的阶段。 */
  confirmTo?: FixedStage;
  /** 补充意见后回流到的阶段。 */
  reworkTo?: FixedStage;
}

/** 闸 kind → 所属阶段与去向。env_needed 不绑阶段(作答口是配置
 * 表单),查不到返回 undefined。 */
export function stageGateRoute(
  kind: IssueGateKind,
): StageGateRoute | undefined {
  for (const stage of Object.keys(FIXED_STAGE_SPECS) as FixedStage[]) {
    const gate = FIXED_STAGE_SPECS[stage].gate;
    if (gate?.kind === kind) {
      return { stage, ...gate };
    }
  }
  return undefined;
}
