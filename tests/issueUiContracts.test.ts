import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const registration = readFileSync(
  resolve("web/src/issues/Registration.tsx"), "utf-8");
const editor = readFileSync(
  resolve("web/src/EnvironmentEditorDialog.tsx"), "utf-8");
const environmentPicker = readFileSync(
  resolve("web/src/EnvironmentPicker.tsx"), "utf-8");
const decisions = readFileSync(
  resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
const annotations = readFileSync(
  resolve("web/src/AnnotationPanel.tsx"), "utf-8");
const launch = readFileSync(
  resolve("web/src/LaunchWorkspace.tsx"), "utf-8");
const css = readFileSync(resolve("web/src/style.css"), "utf-8");
const issueFlow = readFileSync(resolve("docs/issue-flow.md"), "utf-8");
const environmentVault = readFileSync(resolve("src/issueEnvironment.ts"), "utf-8");
const issueService = readFileSync(resolve("src/issueFlow/service.ts"), "utf-8");
const issuePrompt = readFileSync(resolve("src/issueFlow/prompt.ts"), "utf-8");
const issueTools = readFileSync(resolve("src/issueFlow/tools.ts"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const issueBoard = readFileSync(
  resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
const materials = readFileSync(
  resolve("web/src/issues/MaterialsPane.tsx"), "utf-8");

test("混合问题卡必须逐题完整作答", () => {
  // 手动输入选项:选了它后要求填了自定义文本才算答完(不再强制选给定选项)。
  assert.match(decisions,
    /return questions\.length > 0 && questions\.every\(\(item, index\) => \{/);
  assert.match(decisions,
    /if \(pick === MANUAL_CODE\) return !!custom\[index\]\?\.trim\(\)/);
  assert.match(decisions,
    /const ready = areIssueQuestionsComplete\(questions, picked, custom\)/);
  assert.doesNotMatch(decisions, /optionsAllPicked\s*\|\|\s*freeAnswered/);
});

test("知识全文链接只接管普通点击，保留浏览器修饰键行为", () => {
  assert.match(launch,
    /return !\(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\)/);
  assert.equal((launch.match(/if \(!isPlainKnowledgeActivation\(event\)\) return;/g)
    ?? []).length, 4, "完整清单和三类快捷知识都必须保留修饰键");
});

test("手工登记区分目录失败与空目录，并提供重试和真实必填口径", () => {
  assert.match(registration, /setModuleLoadError\(cause instanceof Error/);
  assert.match(registration, /业务模块加载失败：\{moduleLoadError\}/);
  assert.match(registration, /重试加载/);
  assert.doesNotMatch(registration,
    /\.catch\(\(\) => \{ if \(alive\) setModules\(\[\]\); \}\)/);
  // 环境侧(2026-09-10 走查裁定「只选不手填」):登记页不再手填 IP,
  // 未选台账条目就在提交时给指路文案；页面账号/密码已随
  // 「流程不登录网管页面」契约退役。
  assert.match(registration, /请从环境管理选择网管环境/);
  assert.match(registration, /environment_id: pickedEnv\.id/);
  assert.doesNotMatch(registration,
    /const \[envPage(?:Account|Password)|page_(?:account|password):/);
  assert.match(registration, /团队资产 → 业务模块/);
  // 模块带仓不占版面(2026-08-31 拍板):常驻仓清单移除,选中后悬停
  // 弹悬浮卡列出将拉取的仓(键盘聚焦同样弹出);要增删仓去团队资产。
  assert.doesNotMatch(registration, /将拉取的代码仓/);
  assert.match(registration, /issue-module-wrap/);
  assert.match(registration, /已带出 \{selectedModule\.repositories\.length\} 个代码仓,悬停查看/);
  assert.match(registration, /issue-module-tip" role="tooltip"/);
  assert.match(css, /\.issue-module-wrap:hover \.issue-module-tip,[\s\S]*focus-within/);
});

test("环境选择器可用键盘操作，清单在自身视口滚动", () => {
  // 方向键/Home/End/Enter 由 Command(cmdk) 统一接管，Esc 由 Popover
  // 收口；业务组件不重复实现一套容易漂移的 roving focus。
  assert.match(environmentPicker, /<Popover open=\{open\} onOpenChange=\{toggleOpen\}>/);
  assert.match(environmentPicker, /<Command shouldFilter=\{false\}/);
  assert.match(environmentPicker, /<CommandInput[\s\S]*?<CommandList className="max-h-60"/);
  assert.match(environmentPicker, /<CommandItem[\s\S]*?onSelect=\{\(\) => pick\(entry\)\}/);
  assert.match(readFileSync(resolve("web/src/components/ui/command.tsx"), "utf-8"),
    /CommandPrimitive\.List[\s\S]*overflow-y-auto/,
    "环境清单应在 CommandList 自己的视口滚动");
  assert.match(environmentPicker, /PopoverContent align="start"/);
});

test("DTS 详情按钮独立于勾选格，窄屏下拉与触控目标可达", () => {
  // shadcn 表格化(2026-09-11)后:勾选 Checkbox 独占首格,展开按钮
  // 独占尾格——两个命中目标互不嵌套;旧勾选 label 行退役。
  assert.doesNotMatch(registration, /<label className="issue-dts-row-main">/,
    "旧勾选 label 行应已退役(勾选改 Checkbox 独立格)");
  assert.match(registration, /aria-controls=\{detailId\}/);
  assert.match(registration, /aria-label=\{`\$\{isExpanded \? "收起" : "展开"\}/);
  // 触控目标:展开按钮 36px 见方(size-9),不再依赖旧 css 的 44px 规则。
  assert.match(registration, /size-9 items-center justify-center/);
  // 版本过滤改 shadcn Popover(2026-09-11 对齐环境管理台账):浮层碰撞
  // 归 Base UI,旧 680px static 规则随 legacy 菜单退役;44px 触控目标
  // 由选项行 min-h-11 保留在组件上,不再依赖页面 css。
  assert.match(registration, /<PopoverContent align="start" className="w-72 p-1">/);
  assert.match(registration, /min-h-11 cursor-pointer items-center gap-2\.5/);
  assert.doesNotMatch(registration, /issue-dts-version-menu|issue-dts-version-trigger/);
});

test("问题卡单选组支持读屏分组和方向键 roving focus", () => {
  assert.match(decisions, /role="radiogroup"/);
  assert.match(decisions, /role="radio"[\s\S]*aria-checked=\{chosen\}/);
  assert.match(decisions,
    /tabIndex=\{chosen \|\| \(!picked\[index\] && optionIndex === 0\) \? 0 : -1\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
    assert.ok(decisions.includes(`\"${key}\"`), `缺少 ${key} 单选导航`);
  }
  assert.match(decisions, /radioRefs\.current\[questionIndex\]\?\.\[next\]\?\.focus\(\)/);
  assert.match(decisions,
    /const choices = \[\.\.\.options\.map\(\(option\) => option\.code\), MANUAL_CODE\]/,
    "自定义答复也必须能通过方向键到达");
  assert.match(decisions,
    /moveRadio\(index, manualIndex, event\.key\)/,
    "焦点到达自定义答复后也必须能继续用方向键离开");
});

test("问题决策卡的给定选项和自定义答复都能再次点击取消", () => {
  assert.match(decisions,
    /toggleDecisionChoice\(current, index, option\.code\)/);
  assert.match(decisions,
    /toggleDecisionChoice\(current, index, MANUAL_CODE\)/);
  assert.match(decisions, /自定义答复/);
});

test("隐私说明如实覆盖 AI 上下文，管理员旁路有明确入口", () => {
  assert.match(registration, /不会出现在页面或事件流[\s\S]*明文进入当前 AI 上下文/);
  // 闸卡(2026-09-10 只选不手填)不再有密码输入面:以"台账快照、凭据
  // 无需在此填写"的说明替代;密码的唯一输入处是共用新建/编辑弹框。
  assert.match(decisions, /密码以选定时为准[\s\S]*密码无需在此填写/);
  assert.match(editor, /密码加密保存在服务端[\s\S]*明文提供给当前 AI 会话/);
  assert.match(issueFlow, /网管环境口令的契约[\s\S]*AI 上下文[\s\S]*事件流/);
  assert.doesNotMatch(issueFlow, /网管环境密码[\s\S]{0,120}不进模型上下文/);
  // 管理员旁路的开关由服务端下发(feedbackPolicy 唯一判定处),页面按
  // 结论开按钮;入口本身仍必须在面板上明确存在。
  assert.match(annotations, /closureOf\(item\)\.can_override_drop/);
  assert.match(annotations, /closureOf\(item\)\.can_override_verify/);
  assert.match(annotations, /管理员代确认/);
  assert.match(annotations, /完整内容见“执行现场”/);
});

test("环境保险箱注释与真实 AI 口令契约一致", () => {
  assert.match(environmentVault, /解密到当前问题的 AI 上下文/);
  assert.match(environmentVault, /列表\/状态\/事件只给引用/);
  assert.doesNotMatch(environmentVault, /不(?:进|进入).*Agent 上下文/);
  assert.match(issueService,
    /environmentCredentials 会按 ADR-0003 解密到当前问题的 AI 上下文/);
  assert.match(issueService, /issue\.json\/公开 API\/事件只有引用/);
  assert.doesNotMatch(issueService, /提示词永远只有引用|无消费方,为页面自动化/);
});


test("推送过目闸(push_confirm):前端闸种镜像与变更摘要渲染兼容", () => {  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const stageRegistry = readFileSync(
    resolve("src/issueFlow/stageRegistry.ts"), "utf-8");
  const issueFlowDoc = readFileSync(resolve("docs/issue-flow.md"), "utf-8");
  // 前端闸种联合类型要有 push_confirm(镜像不同步=契约对账当场红的教训)。
  assert.match(apiTypes, /\|\s*"push_confirm"/,
    "web/src/api.ts 的 IssueGateKind 缺 push_confirm 镜像");
  // 码表:服务端注册表的选项与推荐(ADR-0004 徽标按 recommended 画)。
  assert.match(stageRegistry,
    /push_confirm:\s*\{[\s\S]*?code:\s*"push",\s*label:\s*"确认推送"/);
  assert.match(stageRegistry,
    /push_confirm:\s*\{[\s\S]*?recommended:\s*"push"/);
  // 闸卡:推送过目卡的 context(服务端生成的变更摘要)要走既有
  // 决策背景块渲染,标签按内容如实叫「变更摘要」。
  assert.match(decisions, /gate_kind === "push_confirm"\s*\?\s*"变更摘要"/);
  assert.match(decisions, /issue-decision-context/);
  assert.match(decisions, /issue-recommended-badge/);
  // 档案:issue-flow.md 的闸种清单要带上这道闸。
  assert.match(issueFlowDoc, /push_confirm|推送前过目/);
});

test("流水线红灯人工闸(pipeline_unfixable/pipeline_evidence):卡面、作答协议与查看模式收闸", () => {
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const stageRegistry = readFileSync(
    resolve("src/issueFlow/stageRegistry.ts"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const facts = readFileSync(
    resolve("web/src/issues/IssueWaitingFacts.tsx"), "utf-8");
  // 前端闸种镜像:两种新闸都要进 IssueGateKind,pipeline 定位字段随卡
  // 上线(镜像不同步=契约对账当场红的同一教训)。
  assert.match(apiTypes, /\|\s*"pipeline_unfixable"/,
    "web/src/api.ts 的 IssueGateKind 缺 pipeline_unfixable 镜像");
  assert.match(apiTypes, /\|\s*"pipeline_evidence"/,
    "web/src/api.ts 的 IssueGateKind 缺 pipeline_evidence 镜像");
  assert.match(apiTypes, /pipeline\?: \{ repo: string; sha: string \}/);
  assert.match(apiTypes, /gate_pipeline\?: \{ repo: string; sha: string \}/);
  // 码表:服务端注册表的作答码(release=重新监看 / supply=回灌原文),
  // 两卡都无推荐码(人工事实,月光永不代答的同一理由)。
  assert.match(stageRegistry,
    /pipeline_unfixable:\s*\{[\s\S]*?code:\s*"resume",\s*label:\s*"已在平台处理\/豁免,重新监看"/);
  assert.match(stageRegistry,
    /pipeline_evidence:\s*\{[\s\S]*?code:\s*"supply",\s*label:\s*"已粘贴报错原文,继续修复"/);
  // 月光守卫落在月光判定之前(与 push_confirm 同款守卫位)。
  assert.match(issueService,
    /if \(gate\.kind === "push_confirm"\) return;[\s\S]*?if \(gate\.kind === "skill_select"\) return;[\s\S]*?if \(gate\.kind === "pipeline_unfixable"\) return;[\s\S]*?if \(gate\.kind === "pipeline_evidence"\) return;/);
  // 决策卡:两种新闸各有一条卡面分支(共用 PipelineGateCard 组件),
  // 证据卡是自由文本主通道(空文本不可提交),作答提交按码走协议。
  assert.match(decisions, /gate_kind === "pipeline_unfixable"/);
  assert.match(decisions, /gate_kind === "pipeline_evidence"/);
  assert.match(decisions, /evidence \? "supply" : "resume"/);
  assert.match(decisions, /const ready = evidence \? !!text\.trim\(\) : true;/);
  assert.match(decisions, /报错原文粘贴到这里/);
  // 会话视图:闸的 pipeline 定位随卡下传(卡面陈列仓与提交)。
  assert.match(sessionView, /gate_pipeline: detail\.gate\.pipeline/);
  // 查看模式:作答卡只在归属分支,新闸与所有等待卡走同一个
  // canOperate 分派(事实卡照看题面,零作答控件)——既有收闸语义
  // 对新闸天然成立,这里钉住分派没被绕开(#127 起分派在会话视图的
  // currentCard 组装处)。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 事实卡按闸种点名"等归属人做什么"(不可修=平台处理,证据=贴回原文)。
  assert.match(facts, /等归属人在交付平台处理\/豁免流水线告警/);
  assert.match(facts, /等归属人贴回流水线报错原文/);
});

test("页内确认弹框:共享 confirmDialog 取代原生框,键盘与危险档纪律在位", () => {
  const confirmDialog = readFileSync(
    resolve("web/src/ConfirmDialog.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const materialsPane = readFileSync(
    resolve("web/src/issues/MaterialsPane.tsx"), "utf-8");
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  // 组件本体:promise 单例宿主 + FIFO 排队 + 无障碍 + 键盘纪律。
  assert.match(confirmDialog, /export function confirmDialog\(/);
  assert.match(confirmDialog, /export function ConfirmDialogHost\(\)/);
  // 视觉壳与键盘纪律(#219 收尾)走 shadcn AlertDialog(base-ui 原语):
  // role=alertdialog/aria-modal/aria-labelledby、Esc=取消、Tab 困笼、
  // 点背板=取消、关闭归还焦点全由原语接管;页面只留 promise 单例、
  // FIFO 队列、危险档焦点落位与取消汇流(onOpenChange(false))。
  assert.match(confirmDialog,
    /<AlertDialog open=\{current != null\}\s*\n\s*onOpenChange=\{\(open\) => \{ if \(!open\) settle\(false\); \}\}>/);
  assert.match(confirmDialog, /queue\[0\]/, "FIFO 排队:同一时刻只渲染队首");
  assert.match(confirmDialog, /options\.danger \? cancelRef : confirmRef/,
    "危险档默认焦点落「取消」,普通档落「确认」");
  assert.match(confirmDialog,
    /initialFocus=\{current\.options\.danger \? cancelRef : confirmRef\}/,
    "首卡打开由 initialFocus 落位危险档口径");
  // 问题流三处接入:取消会话(危险档)/归档会话/提交检视意见。
  for (const [name, source] of [["SessionView", sessionView],
    ["MaterialsPane", materialsPane]] as const) {
    assert.doesNotMatch(source, /window\.confirm\(/,
      `${name} 不得再用浏览器原生确认框`);
    assert.match(source, /import \{ confirmDialog \} from "\.\.\/ConfirmDialog"/);
  }
  assert.match(sessionView, /title: "终止会话",[\s\S]*?danger: true/);
  assert.match(sessionView, /title: "归档会话"/);
  assert.match(materialsPane, /title: `提交 \$\{drafts\.length\} 条检视意见并重跑分析`/);
  // 宿主挂在 App 根部;App 自己的月光调用点允许暂时保留原生框
  // (T3 换双语义按钮),故这里只查宿主不查 App 的 confirm。
  assert.match(app,
    /import \{[^}]*ConfirmDialogHost[^}]*\} from "\.\/ConfirmDialog"/);
  assert.match(app, /<ConfirmDialogHost \/>/);
});

test("月光档位切换二选一:双语义按钮替换确定/取消绕口令", () => {
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  assert.doesNotMatch(app, /window\.confirm\(/,
    "月光切换不得再借原生框的确定/取消表达业务二选一");
  assert.doesNotMatch(app, /选择“确定”|选择“取消”/);
  assert.match(app, /title: "切换到「月光」档"/);
  assert.match(app, /cancelLabel: "仅对后续节点生效"/);
  assert.match(app, /confirmLabel: "连当前待办一起处理"/);
  // 两条分支的布尔语义不变:前者=includeCurrent,后者=仅后续。
  assert.match(app,
    /includeCurrent = await confirmDialog\(\{[\s\S]*?confirmLabel: "连当前待办一起处理"/);
  // 预览数字(可自动处理/检视拦截)必须完整出现在卡上。
  assert.match(app, /\{preview\.eligible\}/);
  assert.match(app, /\{preview\.blocked_annotations\}/);
});

test("全站 window.confirm 清零:原生确认框一律走共享 confirmDialog", () => {
  const files = readdirSync(resolve("web/src"), { recursive: true })
    .map(String).filter((file) => /\.(tsx|ts)$/.test(file));
  assert.ok(files.length > 20, "web/src 源码清单不应为空");
  const offenders = files.filter((file) => readFileSync(
    resolve("web/src", file), "utf-8").includes("window.confirm("));
  assert.deepEqual(offenders, [], "仍有调用点残留浏览器原生确认框");
  // T2 的七个机械替换点全部挂上共享弹框(危险三处红档)。
  const historyBoard = readFileSync(resolve("web/src/HistoryBoard.tsx"), "utf-8");
  const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
  const settings = readFileSync(resolve("web/src/SettingsView.tsx"), "utf-8");
  const wishWall = readFileSync(resolve("web/src/WishWall.tsx"), "utf-8");
  const modules = readFileSync(resolve("web/src/BusinessModuleLibrary.tsx"), "utf-8");
  const workflows = readFileSync(
    resolve("web/src/workflows/WorkflowAssetWorkspace.tsx"), "utf-8");
  for (const [name, source] of [["HistoryBoard", historyBoard],
    ["TaskCard", taskCard], ["SettingsView", settings], ["WishWall", wishWall],
    ["BusinessModuleLibrary", modules],
    ["WorkflowAssetWorkspace", workflows]] as const) {
    assert.match(source, /confirmDialog\(\{/, `${name} 应改用 confirmDialog`);
  }
  for (const source of [historyBoard, taskCard]) {
    assert.match(source, /danger: true/);
  }
});

test("过程文档可原位全屏，退出后保留当前页签", () => {
  assert.match(materials, /issue-doc\$\{fullscreen \? " is-fullscreen"/);
  assert.match(materials, /fullscreen \? "退出全屏" : "全屏查看"/);
  assert.match(materials, /if \(event\.key === "Escape"\) setFullscreen\(false\)/);
  assert.match(css, /\.issue-thread\.issue-doc\.is-fullscreen \{/);
});

test("环境形态字段:唯一落点是共用新建弹框,登记与闸卡只选不手填(AI 不试错)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const decisionCard = readFileSync(
    resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 形态下拉(虚拟化/容器化)只在共用弹框(EnvironmentEditorDialog):
  // 形态随新建录入台账;登记页与 env 卡不再有手填面。
  assert.match(editor, /<SelectItem value="virtualized">虚拟化\(经网管节点\)<\/SelectItem>/);
  assert.match(editor, /<SelectItem value="k8s">容器化\(经 OM 节点\)<\/SelectItem>/);
  assert.doesNotMatch(registration, /环境形态/);
  assert.doesNotMatch(registration, /env_type/);
  assert.match(registration, /environment_id: pickedEnv\.id/);
  // env_needed 卡:同样只选,提交 wire 只带 environment_id。
  assert.doesNotMatch(decisionCard, /env_type/);
  assert.doesNotMatch(decisionCard, /<option value="k8s">/);
  assert.match(decisionCard, /environment_id: picked\.id/);
  // 拒绝口(票 93)文案直说拒绝;两段式:第一段展开理由框,第二段确认。
  assert.match(decisionCard, /拒绝填写,继续分析/);
  assert.match(decisionCard, /拒绝填写,继续/);
  assert.match(decisionCard, /确认拒绝,继续分析/);
  // 环境卡中途即显(2026-09-08):闸在场即出卡,不等 waiting_user——
  // 模型收口后继续不需要环境的工作,用户填卡与它并行。
  assert.match(sessionView, /const envGateLive = detail\.gate\?\.kind === "env_needed"/);
  // wire 类型:形态字段仍在册(台账/弹框消费,服务端契约不变)。
  assert.match(apiTypes, /env_type\?: "virtualized" \| "k8s"/);
});

test("DTS 列表人工预绑模块列:选即存/显隐记忆/发起静默携带(spec #57)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // API 面:全量拉取 + 单条写(空=解绑),走 /issues/dts-bindings。
  assert.match(apiTypes, /getDtsModuleBindings/);
  assert.match(apiTypes, /putDtsModuleBinding/);
  assert.match(apiTypes, /"\/issues\/dts-bindings"/);
  assert.match(apiTypes, /dts-bindings\/\$\{encodeURIComponent\(ticket\)\}/);
  // 列渲染:每行 shadcn Select + 「未选择」解绑项 + aria 标注。
  assert.match(registration,
    /<Select[\s\S]{0,80}value=\{bindings\[ticket\.ticket\]\?\.module_id \?\? "__none"\}/);
  assert.match(registration,
    /<SelectItem value="__none">[\s\S]{0,40}未选择\(AI 运行时识别\)/);
  assert.match(registration, /aria-label=\{\`\$\{ticket\.ticket\} 所属业务模块\`\}/);
  // 选即存:乐观更新失败回滚,反馈落在行内。
  assert.match(registration, /async function bindModule\(/);
  assert.match(registration, /putDtsModuleBinding\(ticketNo, moduleId \|\| null\)/);
  assert.match(registration, /text-destructive" role="alert"/);
  // 显隐:工具栏「列」Popover(shadcn 列选择器形态)+ localStorage 按用户记忆。
  assert.match(registration, /aria-label="列设置"/);
  assert.match(registration,
    /mae-flow:dts-module-col:\$\{viewer\.username\}/);
  assert.match(registration, /localStorage\.setItem\(moduleColKey/);
  // 发起携带:预绑模块静默进场;没绑的不带(AI 照旧运行时识别)。
  assert.match(registration,
    /\.\.\.\(binding \? \{ module_id: binding\.module_id \} : \{\}\),/);
  // 模块目录与登记页同尺:active 且有仓。
  assert.match(registration,
    /module\.status === "active"\s*&&\s*module\.repositories\.length > 0/);
});

// ---- 问题会话查看模式(docs/issue-session-view-mode.md):非归属人只读
// ---- 围观(四信息面完整、零操作控件),归属人照常操作;团队看板入口
// ---- 行为不变。

test("问题会话查看模式:标识上屏可读,判定按登录用户与会话归属人比对", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  // viewer 下传链:App(登录用户)→ IssueBoard → 会话视图,断链即红。
  assert.match(app, /<IssueBoard viewer=\{session\}/);
  assert.match(board, /viewerUsername=\{viewer\.username\}/);
  // 判定口径:viewer 缺席(auth 关闭的演示形态)按可操作处理;
  // 非归属人一律查看模式(管理员不例外——管理员不处理问题单)。
  assert.match(sessionView,
    /const canOperate = !viewerUsername \|\| viewerUsername === detail\.account;/);
  // 标识:文案用词表词「查看模式」、归属人名上屏,只在非归属人分支
  // 渲染;role 保证读屏能听到这条状态。
  assert.match(sessionView,
    /\{!canOperate && <span className="issue-view-mode" role="status"/);
  assert.match(sessionView, /查看模式:归属人 \{detail\.account\} 的会话/);
  assert.match(css, /\.issue-view-mode \{/);
});

test("问题会话查看模式:操作控件逐处收进归属分支,信息面不收", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const associate = readFileSync(
    resolve("web/src/issues/IssueAssociateCard.tsx"), "utf-8");
  // 工作台头部:「无单场景」是状态说明不是控件,查看模式照常示人。
  // #98 单路径化后一切会话都是固定流程,自由分支的绑单输入已整体删除,
  // 不得再以任何形式回流。
  assert.match(sessionView,
    /\? <span className="issue-ticket">\{detail\.ticket\}<\/span>\s*: <span className="issue-ticket empty">无单场景<\/span>/);
  assert.doesNotMatch(sessionView, /className="issue-bind"/);
  assert.doesNotMatch(sessionView, /bindIssueTicket/);
  // 认证报错的「去个人设置配置令牌」修的是归属人的凭据,查看模式不渲染。
  assert.match(sessionView,
    /canOperate && onNavigateProfile\s*&& detail\.error\.includes\(GIT_AUTH_ERROR_TAG\)/);
  // 双栏下传:右栏协作流与左栏材料内容都必须拿到 canOperate,
  // 面板内部的写控件由各自文件的断言钉住(#127 起右栏是协作流)。
  assert.match(sessionView, /<IssueConversationStream[\s\S]*?canOperate=\{canOperate\}/);
  assert.match(sessionView, /<IssueMaterialsPane[\s\S]*?canOperate=\{canOperate\}/);
  // 信息面不收:现场直播(SSE)不带任何归属条件。耗时卡点已随走查
  // 反馈移出工作台(2026-09-07),又随列表卡展开态退役整个删除
  // (2026-09-11);逐仓交付收编为「逐仓交付」页签。
  // (#123 拍平后对话现场是标签之首,直挂默认分支。)
  assert.match(sessionView, /<IssueEventsPane id=\{detail\.id\} active \/>/);
  assert.match(sessionView, /<IssueWorkspaceRepos detail=\{detail\} \/>/);
  assert.doesNotMatch(sessionView,
    /<IssueCostPanel id=\{detail\.id\} \/>/,
    "耗时卡点不再占工作台纵向空间(面板已整个退役)");
  // 右栏:作答卡(问题卡+平台闸+env 表单)只在归属分支,查看模式渲染
  // 无作答控件的事实卡(题面/选项/背景照看,替归属人判断卡在哪)。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 转正卡只在归属分支(#127 协作流区顶部);挂起的只读说明对围观者保留。
  assert.match(sessionView,
    /suspendedCard=\{detail\.status === "suspended" \? \(canOperate\s*\n\s*\? <IssueAssociateCard[\s\S]*?: <IssueAssociateFacts \/>\)/);
  // 只读说明组件零写口:没有输入、没有按钮。
  const factsBody = associate.slice(associate.indexOf("export function IssueAssociateFacts"));
  assert.doesNotMatch(factsBody, /<input|<button/);
  // 输入区(#127 起发言唯一入口):查看者整段只读,插话/续聊收进归属分支。
  assert.match(stream, /!canOperate \? \{ kind: "readonly" \}/);
  // 头部控件区:归档/终止整组收进归属分支(#127 自侧栏栏脚迁入),
  // 与「导出现场记录」并列;确认语义由 confirmDialog 断言钉住。
  const headControls = sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
  assert.ok(headControls.includes("canOperate && <>"), "归档/终止必须挂在 canOperate 分支下");
  assert.ok(headControls.includes("归档收口"), "头部控件区缺归档");
  assert.ok(headControls.includes("终止会话"), "头部控件区缺终止");
  assert.ok(headControls.includes('onClick={archive}'), "归档必须接 archive(confirmDialog)");
  assert.ok(headControls.includes('onClick={cancelSession}'), "终止必须接 cancelSession(confirmDialog)");
  // 材料页签:快速修改编辑器整块(选文件/保存/请 AI 复核)、压缩包解压、
  // 检视页签与圈注写口(记意见/提交/移除)全部收闸。
  assert.match(materials, /\{canOperate && <div className="issue-materials-editor">/);
  assert.match(materials,
    /\{canOperate && node\.archive && <button type="button" className="issue-log-extract"/);
  assert.match(materials,
    /canOperate\s*\?\s*\[\{ key: REVIEW_TAB/);
  assert.match(materials,
    /active === ANALYSIS_DOC && reviewEnabled && canOperate\s*\?\s*<Annotatable/);
});

// ---- 问题会话单路径化(#98):前端不再感知"模式"概念,任意会话一律
// ---- 按固定流程渲染;自由旅程线与模式徽标整体退场。后端仍会在会话
// ---- 数据里带 mode:"fixed"(#99 删字段),前端不再读它。

test("工作台单路径化(#98):mode 缺席也画固定计划线,自由旅程线不得回流", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const teamCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 会话工作台无条件画固定流程计划线——契约上不再容忍自由形状:对
  // mode 缺席的会话数据(后端删字段后)照样输出固定进度条,不存在
  // 任何条件分支;旅程线组件与 mode 读取一并禁止回流。
  // ADR-0018 骨架对齐后,工作台头部用的是 task-progress 视觉的
  // IssueWorkspaceProgress(数据仍是 stage_states);IssueFixedProgress
  // 保留给列表卡,工作台不得回流自由旅程线。
  assert.match(sessionView, /<IssueWorkspaceProgress issue=\{detail\} \/>/);
  assert.match(sessionView, /<div className="ws-progress">/);
  assert.match(sessionView, /export function IssueFixedProgress/);
  assert.doesNotMatch(sessionView, /IssueJourneyTrail|issue-journey|issue-jnode/);
  assert.doesNotMatch(sessionView, /detail\.mode/);
  // 列表卡与团队卡:轮次标注、进度条无条件渲染(原 mode 恒真判断删除,
  // 固定流程会话的渲染结果不变)。
  assert.match(board, /^        <IssueFixedProgress issue=\{issue\} \/>$/m);
  assert.doesNotMatch(board, /issue\.mode/);
  assert.doesNotMatch(teamCard, /issue\.mode/);
  // 终局(归档/取消/失败)只按状态收口:输入区给只读原因说明,不问
  // 模式(rail 拆除后 #127 起终局说明由输入区承载)。
  assert.match(stream,
    /const ended = \["archived", "canceled", "failed"\]\.includes\(status\);/);
  // 前端类型面不再携带模式:IssueFlowMode 与会话上的 mode 字段删除。
  assert.doesNotMatch(apiTypes, /IssueFlowMode/);
  assert.doesNotMatch(apiTypes, /\bmode\?:/);
  // LEGACY_STAGE_TEXT(ut/deploy_verify)是固定流程自己的旧阶段展示
  // 兼容,与自由探索无关,必须原样保留。
  assert.match(apiTypes, /LEGACY_STAGE_TEXT/);
  assert.match(apiTypes, /ut: "单元测试验证"/);
});

test("帮助中心单一流程化(#98):设置页契约无探索方式卡片", () => {
  const helpCenter = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");
  // 任何角落不得再出现"两种探索方式"与自由探索表述;个人设置文章的
  // 步骤与截图说明不再描述探索方式卡片(区域编号已顺号修正)。
  assert.doesNotMatch(helpCenter, /自由探索|探索方式|两种探索/);
  // 旅程线与模式徽标样式随分支一并退场(查看模式徽标 issue-view-mode 保留)。
  assert.doesNotMatch(css, /\.issue-journey|\.issue-jnode|\.issue-mode[ .:{]/);
  assert.match(css, /\.issue-view-mode \{/);
});

test("团队看板问题卡片入口行为不变:点击即进,不含归属判断", () => {
  const teamCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  const overviewRow = readFileSync(
    resolve("web/src/TaskOverviewRow.tsx"), "utf-8");
  // 入口语义(spec 拍板):纯 onOpen 回调,文案与行为不因身份变化;
  // 非归属人点开即达,查看模式在会话工作台内部呈现,卡片不做归属裁剪。
  // 卡片已收敛为 TaskOverviewRow 单形态(与任务行同款,整行可点即进)。
  assert.match(teamCard, /onOpen: \(\) => void/);
  assert.match(teamCard, /<TaskOverviewRow issue /);
  assert.match(teamCard, /onOpen=\{onOpen\}/);
  assert.match(overviewRow, /onClick=\{onOpen\}/);
  assert.match(overviewRow, /打开\$\{issue \? "问题" : "任务"\}工作台/);
  // 固化现状:卡片不出现任何身份/归属判断(陈列 issue.account 不算判断)。
  assert.doesNotMatch(teamCard, /canOperate|isOwner|viewerUsername|viewer\.|username/);
});

test("admin 只读可见问题处理(#103):角色门拆除,发起入口仅开发者", () => {
  // App 层:问题视图不再按角色拒绝渲染(admin 点团队问题卡不再白屏);
  // 深链 /issues/:id 对 admin 也切视图;「去个人设置配置」跳转仅开发者。
  assert.doesNotMatch(appSource,
    /view === "issues" && session\.role !== "admin"/);
  assert.doesNotMatch(appSource,
    /issueId && session\?\.role !== "admin"/);
  assert.match(appSource,
    /onNavigateProfile=\{session\.role !== "admin" \? /);
  // admin 侧栏常驻问题处理入口(管理视角分组内)。
  const adminNav = appSource.slice(
    appSource.indexOf('session.role === "admin" ? <>'),
    appSource.indexOf("</> : <>"));
  assert.ok(adminNav.includes('view="issues"'), "admin 侧栏缺问题处理入口");
  // 问题板:发起界面(登记/DTS)仅开发者渲染;列表标题分「我的/全部」。
  assert.match(issueBoard,
    /viewer\.role !== "admin" && <IssueRegistration/);
  assert.match(issueBoard,
    /viewer\.role === "admin" \? "全部问题" : "我的问题"/);
  // 会话工作台的查看模式边界不变:写口仍按归属人判定(admin 旁观不写)。
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  assert.match(sessionView,
    /const canOperate = !viewerUsername \|\| viewerUsername === detail\.account/);
});

test("单号处处可选中复制:DTS 表格单号独立成格,user-select 强制放开", () => {
  // 单号是绑单/推送分支名的关键操作对象,复制是高频动作;button(会话
  // 卡片)内的拖选被浏览器默认禁掉,CSS 强制放开。
  assert.match(css,
    /\.task-ticket,\s*\.issue-dts-ticket,\s*\.issue-ticket\s*\{[^}]*user-select:\s*text/);
  // shadcn 表格化后:勾选 Checkbox 在首格,单号在第二个 TableCell——
  // 单号独立成格,拖选复制不会误勾选。
  const rowTemplate = registration.slice(
    registration.indexOf("display.map((ticket)"),
    registration.indexOf("issue-dts-detail-html"));
  const checkboxCell = rowTemplate.indexOf("<Checkbox");
  const ticketCell = rowTemplate.indexOf("issue-dts-ticket");
  assert.ok(checkboxCell > -1, "行模板应有勾选 Checkbox");
  assert.ok(ticketCell > checkboxCell, "勾选在前,单号在后");
  assert.ok(rowTemplate.slice(checkboxCell, ticketCell).includes("</TableCell>"),
    "单号必须独立成格(与勾选不同格)——拖选复制不误勾选");
});

test("现场页签挂载与切回时贴底:程序滚动回声不参与人上翻判定", () => {
  const events = readFileSync(resolve("web/src/issues/EventsPane.tsx"), "utf-8");
  const sticky = readFileSync(resolve("web/src/stickyBottom.ts"), "utf-8");
  // 挂载/激活即无条件回底(用户第一眼看最新);人上翻才撒手是既有语义。
  assert.match(events, /if \(active\) follow\.resync\(\)/);
  // 回声守卫:位置停在程序滚动落点上的 scroll 事件不能松开跟随——
  // 没有它,历史分批装载期间贴底会被竞态打成「已暂停跟随」。
  assert.match(sticky, /Math\.abs\(node\.scrollTop - setTop\.current\) < 2/);
  assert.match(sticky, /setTop\.current = node\.scrollHeight/);
});

test("推送前 UT 纪律:本体住 fix 简报,push_branch 只管平台机械(#83)", () => {
  // 纯文案纪律(用户拍板:不加台账闸、不做宿主拦截)。2026-09-11 减负
  // 收口:UT 口径曾双写——push_branch 描述"时间允许就跑全量回归"与 fix
  // 阶段简报"全量回归交给平台流水线,不要每轮手跑全套"直接矛盾。现单源
  // 住 fix 简报(briefs.md stage.fix);push_branch 描述只写平台机械校验
  // (单号/分支名/串行),不再教测试——工具描述教了就会和简报漂移。
  const briefs = readFileSync(resolve("assets/issue-prompts/briefs.md"), "utf-8");
  assert.match(briefs, /每轮 UT 结果如实上报/, "fix 简报缺 UT 上报口径");
  assert.match(briefs, /先跑与本修改直接相关的函数\/模块级测试,通过即收/,
    "fix 简报缺验证聚焦口径");
  assert.match(briefs, /全量回归交给平台流水线,不要每轮手跑全套/,
    "fix 简报缺全量回归口径");
  const pushBranchDesc = issueTools.match(
    /name: "push_branch"[\s\S]*?parameters: Type\.Object/)?.[0] ?? "";
  assert.ok(pushBranchDesc, "push_branch 工具定义必须存在");
  assert.doesNotMatch(pushBranchDesc, /UT|全量回归|测试/,
    "push_branch 描述不得再教 UT——单源在 fix 简报,双写必漂移");
});

// ---- 左栏六标签(#123 拍平 + 2026-09-07 走查反馈:逐仓交付收编为末签)
// ---- 材料拍平 + 对话现场升格(ADR-0018 左栏对齐)----

test("左栏六标签:顺序固定、对话现场默认,旧顶层页签引用清零", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 六标签一次成表,顺序即规格:对话现场(默认入口)在首位,中间四签
  // 是原"材料"面板二级页签的升格,逐仓交付收编为末签——一签一名,
  // 不得改名换序。
  const table = sessionView.match(
    /const ISSUE_MAIN_TABS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.deepEqual(
    [...table.matchAll(/key: "([a-z]+)", label: "([^"]+)"/g)]
      .map(([, key, label]) => `${key}:${label}`),
    ["events:对话现场", "dts:DTS单据", "doc:过程文档",
      "changes:工作区变更", "logs:拉取日志", "repos:逐仓交付"]);
  // 页签条是任务侧左栏同款:ws-pane-head > ws-source-switch(皮肤类
  // 原样挂 base-ui TabsList),激活签走 data-active + " on" 皮肤类。
  // (#210)手搓 role=tablist 换原语:键盘箭头、roving tabindex 归原语。
  assert.match(sessionView,
    /className="ws-pane-head" aria-label="问题工作台视图">[\s\S]*?className="ws-source-switch h-auto justify-start"/);
  assert.match(sessionView,
    /<TabsTrigger key=\{key\} value=\{key\}[\s\S]*?tab === key \? " on" : ""/);
  // 默认口与重置:对话现场是初始页签;换会话丢弃手选,回到默认入口。
  assert.match(sessionView, /useState<IssueMainTab>\("events"\)/);
  assert.match(sessionView, /setTab\("events"\);\s*\n\s*\}, \[detail\.id\]\);/);
  // 分析报告在库的脉冲点随升格迁到「过程文档」页签(入口要找得到;
  // 旧右栏"分析报告已产出"CTA 已随 #127 侧栏拆除一并退场)。
  assert.match(sessionView, /key === "doc" && detail\.has_analysis/);
  // 拆除项引用清零:旧顶层页签组件、"materials"页签值与材料子视图状态。
  assert.doesNotMatch(sessionView, /IssuePaneTabs/);
  assert.doesNotMatch(sessionView, /"materials"/);
  assert.doesNotMatch(sessionView, /materialsView/);
});

test("左栏五标签(#123):材料面板免壳直渲,页签一签一色走问题域变量", () => {
  // 面板壳(ws-pane-head + ws-source-switch)随拍平拆除:MaterialsPane
  // 只按会话层下发的 view 直渲内容,四个子视图与过程文档子页签原样。
  assert.doesNotMatch(materials, /ws-pane-head/);
  assert.doesNotMatch(materials, /ws-source-switch/);
  // 词边界防误伤:SessionView 一词里就藏着 "onView" 子串。
  assert.doesNotMatch(materials, /\bonView\b/);
  assert.match(materials, /\{view === "dts" && /);
  assert.match(materials, /\{view === "doc" && /);
  assert.match(materials, /\{view === "changes" && /);
  assert.match(materials, /\{view === "logs" && /);
  // (#210)doc 子页签换 base-ui Tabs 原语;旧 .ws-tabs 皮肤类随家族退役,
  // 改用 shadcn 默认页签皮,页签语义(键盘箭头/roving)归原语。
  assert.match(materials, /<TabsList aria-label="过程文档页签"/);
  // 页签一签一色:#123 追加块按页签序发 --workspace-tab-color(五签
  // 五色),激活态样式走该变量;问题域默认值已在 .issue-workspace 定义。
  assert.match(css, /\/\* #123 左栏标签/);
  const block = css.slice(css.indexOf("/* #123 左栏标签"));
  assert.ok(
    block.includes(
      ".issue-workspace.task-workspace-v2 .issue-main-pane .ws-source-switch button.on {"),
    "激活页签的边/底/字必须走 --workspace-tab-color");
  assert.ok(
    (block.match(/--workspace-tab-color:/g) ?? []).length >= 5,
    "五个页签各需一枚 --workspace-tab-color");
});

// ---- 右栏协作对话框(#124):ws-side 从 IssueRail 占位换成「与 Agent
// ---- 协作」——会话流接 GET /issues/:id/conversation 聚合接口(可见
// ---- 轮询,任务侧同款节奏),当前等待卡钉在流末尾的 Agent 气泡内
// ---- (#125 卡座);IssueRail 折叠已于 #127 拆除,引用清零。

test("右栏协作对话框(#124):协作头/聚合接口接线/轮询/当前卡上移", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // ws-side 协作头:流组件自带「与 Agent 协作」栏头(ws-collaboration-head,
  // 与任务侧同一结构类),挂在会话视图的 ws-side(aria 同名)里。
  assert.match(sessionView,
    /<section className="ws-side" aria-label="与 Agent 协作">/);
  assert.match(stream, /<header className="ws-collaboration-head">/);
  assert.match(stream, /<strong>与 Agent 协作<\/strong>/);
  assert.match(sessionView, /<IssueConversationStream/);
  // 聚合接口接线:api.ts 出 getIssueConversation → GET /issues/:id/conversation,
  // 成员形状镜像服务端 IssueConversationItem 的六类成员(session/turn/
  // card/decision/steer/review/receipts);流组件消费它,不自己拼装。
  assert.match(apiTypes,
    /export function getIssueConversation\(\s*\n\s*id: string,\s*\n\): Promise<IssueConversationView>/);
  assert.match(apiTypes,
    /issueFetch\(`\/issues\/\$\{encodeURIComponent\(id\)\}\/conversation`\)/);
  for (const kind of ["session", "turn", "card", "decision", "steer", "review",
    "receipts"]) {
    assert.match(apiTypes, new RegExp(`kind: "${kind}"`),
      `api.ts 协作流类型缺 ${kind} 成员`);
  }
  assert.match(stream, /getIssueConversation\(id\)/);
  // 轮询:会话视图可见时每 4 秒拉一次(任务侧同款节奏,visiblePolling),
  // 换会话重置(流清空 + 序号作废半拍旧响应)。
  assert.match(stream, /startVisiblePolling\(\(\) => load\(issueId\), 4000, document\)/);
  assert.match(stream,
    /useEffect\(\(\) => \{[\s\S]*setView\(\{ items: \[\], truncated: false, loaded: false \}\);[\s\S]*\}, \[issueId, load\]\)/);
  // 当前等待卡已入流(#125 卡座):卡由会话视图组装下传(决策卡/查看
  // 模式事实卡),钉在流末尾的 Agent 气泡内——卡座/dock 的契约为文末
  // #125 测试块钉住。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 输入区分派:运行中=插话(steerIssue)、其余=续聊(replyIssue),
  // 查看者只读(ws-composer-readonly);回调沿用 SessionView 既有口。
  assert.match(sessionView, /onSteer=\{sendSteer\}/);
  assert.match(sessionView, /onReply=\{sendReply\}/);
  assert.match(stream, /status === "running" \? \{ kind: "steer" \}/);
  assert.match(stream, /ws-composer-readonly/);
  // 侧栏拆除(#127):ws-side 再无 rail 挂载与「更多操作」details;
  // 查看模式事实卡自 IssueWaitingFacts.tsx 独立文件导出(组件零变化)。
  assert.doesNotMatch(sessionView, /IssueRail/);
  assert.doesNotMatch(sessionView, /issue-side-more/);
  assert.doesNotMatch(sessionView, /更多操作/);
  const facts = readFileSync(
    resolve("web/src/issues/IssueWaitingFacts.tsx"), "utf-8");
  assert.match(facts, /export function IssueWaitingFacts/);
  // 样式落点:#124 右栏协作的追加块在 style.css 末尾问题工作台区块内;
  // 流上方临时容器(issue-conv-now)的死规则已随 #125 卡座拆除清零。
  assert.match(css, /#124 右栏协作/);
  assert.doesNotMatch(css, /issue-conv-now/);
});

// ---- 右栏侧栏拆除(#127,#120 收尾):IssueRail 六态侧栏整体退场——
// ---- 状态说明由头部徽标/阶段行与协作流承载,归档/终止入头部控件区,
// ---- 挂起转正卡入协作流顶部;拆除项引用清零、死样式清理。

test("侧栏拆除(#127):rail 源码删除引用清零,归档/终止入头部,状态说明不丢", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 拆除项源码清零:IssueRail.tsx 文件不存在,问题工作台源码再无
  // rail 组件/类名/「更多操作」details 的引用(死样式一并清零)。
  assert.equal(
    readdirSync(resolve("web/src/issues")).includes("IssueRail.tsx"), false,
    "IssueRail.tsx 应随 #127 删除");
  assert.doesNotMatch(sessionView, /IssueRail|issue-rail(?!-card)|issue-side-more/);
  assert.doesNotMatch(stream, /IssueRail|issue-side-more/);
  assert.doesNotMatch(css, /issue-side-more|issue-rail-input|issue-rail-foot|issue-rail-actions|issue-analysis-cta/);
  // 归档/终止入头部控件区(与导出并列),确认语义保留:
  // confirmDialog 的两条接入(归档/终止)在 SessionView 原样。
  const headControls = sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
  assert.ok(headControls.includes("导出现场记录"));
  assert.ok(headControls.includes("归档收口"));
  assert.ok(headControls.includes("终止会话"));
  assert.match(sessionView, /title: "归档会话"/);
  assert.match(sessionView, /title: "终止会话",[\s\S]*?danger: true/);
  // 头部危险档:终止钮保留红色危险 affordance(问题域 #127 追加块)。
  assert.match(css,
    /\.issue-workspace\.task-workspace-v2 \.ws-head-controls > button\.danger \{/);
  // 状态信息不丢:六态说明由头部状态徽标(ISSUE_STATUS_TEXT 全表)+
  // 阶段行承载,不依赖已拆的侧栏状态卡。
  assert.match(sessionView,
    /<span className=\{`issue-status status-\$\{detail\.status\}`\}>\s*\n\s*\{ISSUE_STATUS_TEXT\[detail\.status\]\}\s*\n\s*<\/span>/);
  assert.match(sessionView, /<span className="issue-stage">\s*\n\s*\{issueStageText\(detail\)\}/);
  assert.match(stream, /kind: "blocked", title: "会话已结束"/,
    "终局说明由输入区承载(终局无侧栏卡后不断档)");
});

test("挂起转正入流(#127):转正卡在协作流区顶部,两段式与查看模式只读语义原样", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const associate = readFileSync(
    resolve("web/src/issues/IssueAssociateCard.tsx"), "utf-8");
  // 会话视图按挂起状态组装下传:归属人拿两段式转正卡,查看模式只读说明。
  assert.match(sessionView,
    /suspendedCard=\{detail\.status === "suspended" \? \(canOperate\s*\n\s*\? <IssueAssociateCard busy=\{busy\} onAssociate=\{associate\} \/>\s*\n\s*: <IssueAssociateFacts \/>\)\s*\n\s*: undefined\}/);
  // 挂载点:协作流区顶部——「与 Agent 协作」头之下、可滚流区之上
  // (不进流,不会被贴底跟随滚出视野)。
  assert.match(stream,
    /<header className="ws-collaboration-head">[\s\S]*?\{suspendedCard && <div className="issue-conv-suspended">\{suspendedCard\}<\/div>\}[\s\S]*?<div className="ws-stream"/);
  // 样式落点:#127 追加块给槽位留白(ws-anchor 同节奏)。
  assert.match(css,
    /\.issue-workspace\.task-workspace-v2 \.ws-stream-shell > \.issue-conv-suspended \{/);
  // 两段式搬运不改语义:输单号 → 校验过目(单据详情回显)→ 确认转正;
  // 校验/确认都走同一个 onAssociate(ticket, confirm) 口。
  assert.match(associate, /export function IssueAssociateCard/);
  assert.match(associate, /const result = await onAssociate\(ticket\.trim\(\), false\);/);
  assert.match(associate, /await onAssociate\(ticket\.trim\(\), true\);/);
  assert.match(associate, /校验单号/);
  assert.match(associate, /确认转正\(继承分析报告,进入问题修改\)/);
  assert.match(associate, /转正不可逆:本会话将归档,新会话以该单号继续。/);
  // 转正成功跳新会话:associate 结果带 converted 时 onOpenIssue 由
  // 会话视图处理(链路在 SessionView,不在卡组件)。
  assert.match(sessionView,
    /if \(result\.converted\) \{[\s\S]*onOpenIssue\(result\.converted\.id\);/);
  // 输入区挂起提示指向协作区(不再指向已拆的「更多操作」)。
  assert.match(stream, /在上方协作区关联 DTS 单号转正/);
  assert.doesNotMatch(stream, /更多操作/);
});

// ---- 举卡入流(#125,ADR-0018 决策三):当前等待卡钉在协作流末尾的
// ---- Agent 气泡内(卡座),提交区(附言+提交/拒绝按钮)经 portal 挂进
// ---- 输入区 dock;查看模式卡只读不出 dock,无卡时输入区恢复普通输入。
// ---- 模式要素(挂载点/dock 接线/回放去重)供 #126 其余三类卡复制。

test("卡座(#125):当前卡钉在流末尾 Agent 气泡内,按 waiting_id 去重,issue-conv-now 拆除", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡座挂载点:waiting + currentCard 同时在场即钉;气泡是 Agent 身份
  // (conv-msg agent 由 message() 统一给),卡体住 conv-card current,
  // 排在 rows(全部回放条目)之后——新条目到达它也不挪窝。
  assert.match(stream, /const pinnedCard = Boolean\(waiting && currentCard\);/);
  assert.match(stream,
    /\{rows\}[\s\S]*\{pinnedCard && message\(\{[\s\S]*key: `card-\$\{waitingId/);
  assert.match(stream,
    /children: <div className="conv-card current">\{currentCard\}<\/div>/);
  // 去重键:流内同 waiting_id 的投影副本摘除防双卡;其余 waiting 投影
  // (历史卡)不再整类过滤,照常只读回放——旧的整类过滤形状必须消失。
  assert.match(stream,
    /view\.items\.filter\(\(item\) =>\s*\n\s*!\(item\.kind === "card" && item\.waiting_id === waitingId\)\)/);
  assert.doesNotMatch(stream,
    /filter\(\(item\) => !\(item\.kind === "card" && item\.status === "waiting"\)\)/,
    "流内 waiting 投影不得再按状态整类过滤(按 waiting_id 去重)");
  // 去重键来自会话视图下传的当前卡身份,不是流内推断。
  assert.match(sessionView, /waitingId=\{waiting\?\.waiting_id\}/);
  // 拆除:流上方临时容器「当前待你处理」(issue-conv-now)引用清零。
  assert.doesNotMatch(stream, /issue-conv-now/);
  assert.doesNotMatch(stream, /当前待你处理/);
});

test("卡座(#125):dock portal 接线——提交区挂输入区 dock,表单状态仍归卡组件", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡侧:提交区经 DecisionFooterMount 同款挂载器 createPortal 进 dock;
  // 目标缺席(首帧/未接线)时原位渲染,portal 只搬 DOM 不搬状态。
  assert.match(decisions,
    /function IssueDecisionFooterMount\(\{ target, children \}/);
  assert.match(decisions, /return target \? createPortal\(children, target\) : children;/);
  assert.match(decisions, /footerTarget\?: HTMLElement \| null/);
  // env 卡(本票走通的卡):拒绝理由(两段式展开)+错误提示+提交/拒绝
  // 按钮整块进 dock(挂载器包住 dock-foot);未选环境不得提交、拒绝
  // wire 复用 /environment(decline:true + note)。
  assert.match(decisions,
    /<IssueDecisionFooterMount target=\{footerTarget\}>[\s\S]*?issue-decision-dock-foot[\s\S]*?<\/IssueDecisionFooterMount>/);
  assert.match(decisions, /busy \|\| !picked/, "未选环境不得提交");
  assert.match(decisions, /decline: true,/);
  // 输入区侧:dock 容器(与任务侧同一 ws-reply-dock 形状,aria 同名)
  // 只在等卡分支预留,由 dock=waiting && canOperate 门控。
  assert.match(stream,
    /\{dock && <div className="ws-reply-dock" ref=\{dockRef\} role="region"\s*\n\s*aria-label="决定的附言与提交" \/>\}/);
  assert.match(stream, /dock=\{waiting && canOperate\}/);
  // 会话视图:dock 节点回调与卡的 footerTarget 同源一线
  // (dockRef setState → footerTarget → 卡 → portal)。
  assert.match(sessionView, /dockRef=\{setDecisionFooterTarget\}/);
  assert.match(sessionView, /footerTarget=\{decisionFooterTarget\}/);
  // 样式落点:#125 追加块在 style.css 末尾问题工作台区块内,dock 内
  // 的提交区铺陈(附言在上、按钮在下)与原位兜底各有形状。
  assert.match(css, /#125 卡座与 dock/);
  const block = css.slice(css.indexOf("#125 卡座与 dock"));
  assert.ok(block.includes(
    ".issue-workspace.task-workspace-v2 .ws-reply-dock .issue-decision-dock-foot {"),
    "dock 内提交区的铺陈规则必须在 #125 追加块内");
  assert.ok(block.includes(".issue-decision-dock-foot {"),
    "原位(未接线)提交区的兜底形状必须在 #125 追加块内");
});

test("卡座(#125):无卡时输入区恢复普通输入,查看模式只读不出 dock", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 只读分支(查看模式):整段没有 dock 容器——事实卡只读钉在流末尾,
  // 写口一个不出(与 canOperate 门语义一致)。
  const readonlyStart = stream.indexOf('mode.kind === "readonly"');
  const blockedStart = stream.indexOf('mode.kind === "blocked"');
  const readonlySlice = stream.slice(readonlyStart, blockedStart);
  assert.ok(readonlySlice.includes("ws-composer-readonly"));
  assert.doesNotMatch(readonlySlice, /ws-reply-dock/, "查看模式不得出 dock");
  // 无卡分支:插话/续聊的普通输入(steer-input)段没有 dock——dock 只
  // 在等卡的 blocked 分支;无卡时 dock 容器不渲染,输入区恢复普通输入。
  const steerBranch = stream.slice(stream.indexOf('const steer = mode.kind === "steer"'));
  // 旧 textarea.steer-input 换 shadcn Textarea:插话/续聊共用同一输入
  // 组件,由 steer 布尔切换文案;无卡时 dock 容器不渲染。
  assert.ok(steerBranch.includes("<Textarea"), "插话/续聊输入在场");
  assert.doesNotMatch(steerBranch, /ws-reply-dock/, "无卡时不得出 dock");
  // dock 门:归属人 + 有卡才为真;查看者(waiting 也在场)拿不到 dock。
  assert.match(stream, /dock=\{waiting && canOperate\}/);
});

// ---- 举卡入流·三类卡换壳(#126):通用决策/skill 圈选/流水线两闸照
// ---- #125 卡座模式把附言/提交按钮区搬进输入区 dock(同一挂载器),
// ---- 字段、校验、选项与提交语义零变化;流内历史卡只读回放不受影响。

test("卡座(#126):三类卡的提交区进 dock——footerTarget 透传链与挂载器包法", () => {
  // 透传链(#125 同一条):IssueDecisionCard 把 footerTarget 原样交给
  // 三类卡;rail 直挂不传目标,挂载器原位渲染的兜底仍在。
  assert.match(decisions,
    /<SkillSelectForm busy=\{busy\} skills=\{waiting\.gate_skills \?\? \[\]\}\s*\n\s*footerTarget=\{footerTarget\}/);
  assert.match(decisions,
    /<PipelineGateCard waiting=\{waiting\} busy=\{busy\}\s*\n\s*footerTarget=\{footerTarget\} onAnswer=\{onAnswer\} \/>/);
  assert.match(decisions,
    /<GenericDecisionCard waiting=\{waiting\} busy=\{busy\}\s*\n\s*footerTarget=\{footerTarget\} onAnswer=\{onAnswer\} \/>/);
  // 换壳标记:四类卡(env+三类)接上 dock 才收卡内铺陈,同一写法。
  assert.equal(
    (decisions.match(/className=\{`issue-decision\$\{footerTarget \? " foot-docked" : ""\}`\}/g) ?? []).length,
    4, "四类卡必须用同一 foot-docked 条件标记");
  const skillForm = decisions.slice(decisions.indexOf("function SkillSelectForm"));
  const pipelineCard = decisions.slice(decisions.indexOf("function PipelineGateCard"));
  const genericCard = decisions.slice(decisions.indexOf("function GenericDecisionCard"));
  // 三张卡的提交区整块进挂载器(附言/错误提示+按钮排住 dock-foot)。
  for (const [name, body] of [["skill", skillForm], ["pipeline", pipelineCard],
    ["generic", genericCard]] as const) {
    assert.match(body,
      /<IssueDecisionFooterMount target=\{footerTarget\}>[\s\S]*?issue-decision-dock-foot[\s\S]*?<\/IssueDecisionFooterMount>/,
      `${name} 卡的提交区必须包进挂载器`);
  }
  // skill 圈选卡:勾选清单留在卡上,提交语义零变化——至少勾一项才可点
  // 确认;「都不用」提交空选(两条路同口)。
  assert.match(skillForm, /disabled=\{!picked\.size \|\| busy\}/);
  assert.match(skillForm, /确认勾选\(\$\{picked\.size\}\)/);
  assert.match(skillForm, /skill-skip" disabled=\{busy\}/);
  assert.match(skillForm, /onClick=\{\(\) => void submit\(\[\]\)\}/);
  // 流水线卡:证据卡的主字段(报错原文)留在卡上、空文本不可提交;
  // 码与文案仍按服务端 options 镜像(缺省字面量兜底);不可修卡的补充
  // 说明是附言,随提交钮进 dock。
  assert.match(pipelineCard, /\{evidence && <div className="issue-decision-env">/);
  assert.match(pipelineCard, /const ready = evidence \? !!text\.trim\(\) : true;/);
  assert.match(pipelineCard, /evidence \? "supply" : "resume"/);
  assert.match(pipelineCard, /报错原文粘贴到这里/);
  assert.match(pipelineCard, /\{!evidence && <div className="issue-decision-env">/);
  // 通用决策卡:推荐徽标与逐题作答留在卡上,ready 口径零变化(逐题全
  // 答完才可提交);附言(补充说明)与提交答复钮进 dock。
  assert.match(genericCard,
    /const ready = areIssueQuestionsComplete\(questions, picked, custom\)/);
  assert.match(genericCard, /issue-recommended-badge/);
  assert.match(genericCard, /issue-decision-notes-toggle/);
  assert.match(genericCard, /提交答复/);
});

test("卡座(#126):三类卡换壳不碰会话流——历史卡只读回放与 waiting_id 去重原样", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡座与去重(#125 的形状原样):当前卡钉在流末尾,流内同 waiting_id
  // 投影摘除防双卡,其余历史卡(含三类卡的已决定投影)照常只读回放。
  assert.match(stream, /const pinnedCard = Boolean\(waiting && currentCard\);/);
  assert.match(stream,
    /view\.items\.filter\(\(item\) =>\s*\n\s*!\(item\.kind === "card" && item\.waiting_id === waitingId\)\)/);
  assert.match(stream,
    /children: <div className="conv-card current">\{currentCard\}<\/div>/);
  // 流内卡的回放按 status 给词签(waiting=等待决定/superseded=已作废/
  // 其余=已决定),答案逐题对齐:decision 按题序换行拼接,本题行等于
  // 选项原文即出勾,不等于任何选项=自定义答复回填题面(2026-09-08:
  // 自定义回答只按行找选项,卡上无影无踪)。
  assert.match(stream,
    /item\.status === "waiting" \? "等待决定"\s*\n\s*: item\.status === "superseded" \? "已作废" : "已决定"/);
  assert.match(stream, /conversationCardTitle\(item\)/);
  assert.match(stream, /const answerLines = decision \? decision\.decision\.split\("\\n"\) : \[\]/);
  assert.match(stream, /const custom = line !== "" && !question\.options\.includes\(line\)/);
  assert.match(stream, /自定义答复:\$\{line\}/,
    "选项题的自定义答复带前缀回填题面");
  assert.match(stream, /\? `自定义答复:\$\{line\}` : line\}/,
    "开放题的答案直出,不加自定义前缀");
  // 会话视图:dockRef setState → footerTarget → 当前卡一线到底,dock 门
  // 仍是 waiting && canOperate(查看模式不出 dock)。
  assert.match(sessionView, /footerTarget=\{decisionFooterTarget\}/);
  assert.match(sessionView, /dockRef=\{setDecisionFooterTarget\}/);
  assert.match(stream, /dock=\{waiting && canOperate\}/);
  // 样式落点:#126 追加块顺延在 #125 之后,dock 内附言/表单段的铺陈
  // 与 foot-docked 收尾留白各有规则。
  assert.ok(css.indexOf("#126 三类卡 dock 铺陈") > css.indexOf("#125 卡座与 dock"),
    "#126 块必须在 #125 之后追加");
  const block = css.slice(css.indexOf("#126 三类卡 dock 铺陈"));
  assert.ok(block.includes(
    ".issue-workspace.task-workspace-v2 .ws-reply-dock .issue-decision-dock-foot .issue-decision-env {"),
  "dock 内 env 段(不可修卡附言)的铺陈规则必须在 #126 块内");
  assert.ok(block.includes(
    ".issue-decision.foot-docked > .issue-decision-context:last-child,"),
  "foot-docked 卡的收尾留白规则必须在 #126 块内");
});

// ---- 人工接管(2026-09-07 走查拍板):接管=打断 AI;期间人工记录;
// ---- 交还时 AI 带着记录继续。头部紫金徽标 + 输入区 takeover 模式
// ---- (记录到现场/交还给 AI 两钮),api 镜像与 CSS 追加落点对账。

test("人工接管:徽标/下传 takeover/三回调接线/composer 记录+交还两钮/CSS 追加落点", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 头部徽标:detail.takeover 在场即挂「人工接管中」,排在状态徽标之后
  // (横幅态独立于六态,复用 issue-status 徽标语言换紫金色)。
  assert.match(sessionView,
    /\{detail\.takeover\s*\n\s*&& <span className="issue-status status-takingover">人工接管中<\/span>\}/);
  assert.match(css, /\.issue-status\.status-takingover \{/);
  // 下传与三回调接线:takeover 布尔 + 接管/记录/交还各走各的通道——
  // 接管/交还经 perform(成功带新详情回来,徽标与输入区模式随之翻转),
  // 记录不走 perform(免吞错,失败原样抛回输入区报错)。
  assert.match(sessionView, /takeover=\{Boolean\(detail\.takeover\)\}/);
  assert.match(sessionView,
    /const takeoverNow = \(\) => perform\(\(\) => takeoverIssue\(detail\.id\)\);/);
  assert.match(sessionView,
    /const sendTakeoverNote = \(text: string\) =>\s*\n\s*addIssueTakeoverNote\(detail\.id, text\)\.then\(\(\) => undefined\);/);
  assert.match(sessionView,
    /const resumeTakeover = \(note\?: string\) =>\s*\n\s*perform\(\(\) => resumeIssueTakeover\(detail\.id, note\)\);/);
  assert.match(sessionView, /onTakeover=\{takeoverNow\}/);
  assert.match(sessionView, /onTakeoverNote=\{sendTakeoverNote\}/);
  assert.match(sessionView, /onResumeTakeover=\{resumeTakeover\}/);
  // api 镜像:takeover 字段(与服务端 summarize 同形)+ 三个 POST。
  assert.match(api, /takeover\?: \{ at: string; by: string \};/);
  assert.match(api, /export function takeoverIssue\(/);
  assert.match(api, /export function addIssueTakeoverNote\(/);
  assert.match(api, /export function resumeIssueTakeover\(/);
  // composer:takeover 模式分派在插话/续聊之前(接管=true 一票定音),
  // ctx/占位符口径一致,「记录到现场」「交还给 AI 继续」两钮都在。
  assert.match(stream, /\| \{ kind: "takeover" \}/);
  assert.match(stream, /takeover === true \? \{ kind: "takeover" \}/);
  assert.match(stream, /人工驾驶中——AI 已暂停/);
  assert.match(stream, /placeholder="记录你的人工操作,交还时 AI 会看到这些记录"/);
  assert.match(stream, /记录到现场/);
  assert.match(stream, /交还给 AI 继续/);
  // CSS 落点:追加块在既有 #126 块之后(只追加,不改既有行),徽标与
  // 双钮样式都收在块内。
  assert.ok(css.indexOf("---- 人工接管(2026-09-07 走查拍板)")
    > css.indexOf("#126 三类卡 dock 铺陈"),
  "人工接管块必须追加在 #126 块之后");
  const takeoverBlock =
    css.slice(css.indexOf("---- 人工接管(2026-09-07 走查拍板)"));
  assert.ok(takeoverBlock.includes(".issue-status.status-takingover {"),
    "接管徽标规则必须在人工接管追加块内");
  assert.ok(
    takeoverBlock.includes(".issue-takeover-actions > .issue-takeover-resume {"),
    "交还主档按钮规则必须在人工接管追加块内");
});

// ---- 协作流对齐任务侧会话流(2026-09-08 走查拍板四点):长文量高折叠
// ---- (ClampedText 两域共用一份)、工具步骤 conv-act 按钮切「对话现场」、
// ---- 栏头「全部/需要我的」筛选、检视提交 conv-lead 批次卡。

test("协作流对齐(2026-09-08):量高折叠共用/步骤查看过程/流内筛选/批次卡", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const taskStream = readFileSync(
    resolve("web/src/ConversationStream.tsx"), "utf-8");
  const clamped = readFileSync(resolve("web/src/ClampedText.tsx"), "utf-8");
  // 长文折叠:量高版抽成 ClampedText.tsx,两域同用一份;按字数的旧
  // TurnText 已删(残字数阈值=两域折叠观感漂移的根源)。
  assert.match(clamped, /ResizeObserver/);
  assert.match(taskStream, /import \{ ClampedText \} from "\.\/ClampedText";/);
  assert.match(stream, /import \{ ClampedText \} from "\.\.\/ClampedText";/);
  assert.match(stream, /\{last && <ClampedText text=\{last\.text\} \/\>\}/);
  assert.doesNotMatch(stream, /text\.length <= 1200/,
    "按字数收折的旧 TurnText 必须删干净");
  // 工具步骤:conv-act 按钮(任务侧同款)点开切「对话现场」;只读计数
  // 行(issue-conv-steps)连同样式已删。
  assert.match(stream,
    /<button type="button" className="conv-act" onClick=\{onOpenEvents\}/);
  assert.match(sessionView, /onOpenEvents=\{\(\) => setTab\("events"\)\}/);
  assert.doesNotMatch(stream, /issue-conv-steps/);
  assert.doesNotMatch(readFileSync(resolve("web/src/style.css"), "utf-8"),
    /\.issue-conv-steps \{/);
  // 流内筛选:栏头「全部/需要我的」(任务侧同款 ws-stream-filters),
  // 「需要我的」口径=还开着的卡;钉在流末的当前卡不受筛选影响。
  // (#210)手搓 role=tablist 换 base-ui Tabs 原语,ws-stream-filters
  // 皮肤类挂在 TabsList 上,键盘箭头归原语,视觉原样。
  assert.match(stream,
    /<TabsList variant="line" aria-label="会话流筛选" className="ws-stream-filters h-auto">/);
  assert.match(stream, /\["all", "全部"\], \["mine", "需要我的"\]/);
  assert.match(stream,
    /filter === "mine"\s*\n\s*\? limited\.filter\(\(item\) => item\.kind === "card" && item\.status === "waiting"\)/);
  // 检视提交:conv-lead 批次卡导语(任务侧 annotations_sent 同款视觉),
  // 不再是无导语的裸正文。
  assert.match(stream,
    /<p className="conv-lead">提交了 \{item\.count\} 条检视意见给 Agent<\/p>/);
});

test("现场页签对齐(2026-09-08):长内容/结构化内容右侧查看,不再就地展开", () => {
  const events = readFileSync(resolve("web/src/issues/EventsPane.tsx"), "utf-8");
  const eventView = readFileSync(resolve("web/src/eventView.ts"), "utf-8");
  // 预览按钮模式(任务侧 EventValue 同款):>480 字与结构化内容行内只给
  // 预览+「右侧查看 →」,点开在 event-workspace 旁的详情面板看全文。
  assert.match(events, /className="event-value-preview"/);
  assert.match(events, /右侧查看 <i aria-hidden>→<\/i>/);
  assert.match(events, /<div className=\{`event-workspace\$\{detail \? " has-detail" : ""\}`\}>/);
  assert.match(events, /<aside className="event-detail" aria-label="事件完整内容">/);
  assert.doesNotMatch(events, /event-value-expand/,
    "就地 <details> 展开是旧形态,必须删干净");
  // 选中类型两域共用一份(eventView.ts),任务侧 EventTail 同接口。
  assert.match(eventView, /export interface EventDetailSelection/);
  const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
  assert.match(taskCard, /type EventDetailSelection,\n\s*\} from "\.\/eventView";|type EventDetailSelection,[^]*from "\.\/eventView";/,
    "任务侧应从 eventView 导入共享选中类型");
});

// ---- 环境快选接入(票 #150,ADR-0020;2026-09-10 走查重铸):闸卡与
// ---- 登记页「只选不手填」——可搜索下拉挑台账条目,搜不到弹共用表单
// ---- 新建并自动选中;选中提交 environment_id,服务端以选定时点快照进
// ---- 会话 vault(前端永远没有密码)。被触碰的区块按 #146 迁 Tailwind。

test("环境闸卡台账快选(#150;只选不手填):可搜索下拉+新建弹框+两段式拒绝;触迁 Tailwind", () => {
  const decisionCard = readFileSync(
    resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
  const picker = readFileSync(
    resolve("web/src/EnvironmentPicker.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 唯一作答面=可搜索下拉:EnvironmentPicker 进场,选中提交
  // environment_id(服务端从台账解密快照,前端零密码),卡面给
  // 「将使用「环境管理」中的 x.x.x.x」的快照说明;手动表单整体退役。
  assert.match(decisionCard,
    /<EnvironmentPicker selectedId=\{picked\?\.id \?\? null\}/);
  assert.match(decisionCard, /environment_id: picked\.id/);
  assert.match(decisionCard, /「环境管理」中的 \{picked\.ip\}/);
  assert.doesNotMatch(decisionCard, /"picker" \| "manual"/);
  assert.doesNotMatch(decisionCard, /存入环境管理/);
  assert.doesNotMatch(decisionCard, /backend_password: backendPassword/);
  // 拒绝两段式(票 93):第一段展开理由框,第二段「确认拒绝」才提交
  //(硬拒绝:同 scope 工具再调不再举卡,值得一步确认)。
  assert.match(decisionCard, /declineOpen/);
  assert.match(decisionCard, /确认拒绝,继续分析/);
  assert.match(decisionCard, /decline: true,/);
  // #146 触碰即迁:表单区块根挂 .tw-root 走工具类;提交区容器
  // (issue-decision-dock-foot)是四类卡共用的卡座/dock 双上下文皮肤,
  // 按 #146 例外保留 legacy(迁移块内有注释说明)。
  assert.match(decisionCard,
    /tw-root grid gap-\[10px\] px-\[15px\] pt-\[13px\]/);
  assert.match(decisionCard, /issue-decision-dock-foot/);
  // 共用选择器:可搜索下拉(listbox/option + 搜索框,方向键+回车),
  // 「找不到就新建」弹共用表单,保存回传新条目自动选中(onPick)。
  assert.match(picker, /listEnvironments/);
  assert.match(picker, /onPick: \(entry: EnvironmentView\) => void/);
  // #212 起内层清单换 Command(cmdk):listbox/option 语义、方向键高亮、
  // 高亮行滚入视口与行 hover 底色全归原语;页面保留搜索过滤与选中
  // 标记(onSelect → onPick,data-checked 勾选态)。
  assert.match(picker, /<CommandList className="max-h-60" aria-label="环境清单">/);
  assert.match(picker, /<CommandItem key=\{entry\.id\} value=\{entry\.id\}/);
  assert.match(picker, /data-checked=\{picked \|\| undefined\}/);
  assert.match(picker, /onSelect=\{\(\) => pick\(entry\)\}/);
  assert.match(picker, /EnvironmentEditorDialog/);
  assert.match(picker, /onPick\(entry\)/);
  assert.match(picker, /tw-root/);
  assert.match(picker, /entry\.ip/);
  assert.doesNotMatch(picker, /password/i, "台账视图零密码字段");
  // wire 镜像(#150 新键仍在册;root_password/save_to_registry 只服务
  // 登记弹框,服务端契约不变)。
  assert.match(apiTypes, /environment_id\?: string/);
});

test("登记页从环境管理选(#150;只选不手填):常驻快选/只提交 environment_id", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  // 常驻快选(可搜索下拉,自带「找不到就新建」弹框):不再有展开/收起
  // 开关,更没有手填回退。
  assert.match(registration,
    /<EnvironmentPicker\s*\n\s*selectedId=\{pickedEnv\?\.id \?\? null\} onPick=\{pickEnv\} \/>/);
  assert.doesNotMatch(registration, /收起环境列表/);
  assert.doesNotMatch(registration, /清除,改用手动填写/);
  // 选中给台账快照说明(已存后台密码),提交只带 environment_id。
  // 流程不登录网管页面，所以页面账号/密码不再采集。
  assert.match(registration, /将使用「环境管理」里/);
  assert.match(registration, /environment_id: pickedEnv\.id/);
  // 未选环境提交被拦,文案指路下拉里的「新增环境」。
  assert.match(registration, /请从环境管理选择网管环境/);
  assert.doesNotMatch(registration, /page_password|envPagePassword|envPageAccount/);
});

test("问题列表卡:点击整卡直达工作台,展开态与逐卡轮询退役(2026-09-11)", () => {
  const ui = readFileSync(resolve("web/src/components/ui/card.tsx"), "utf-8");
  // 整卡=进工作台的按钮(summary 按钮改语义,不再带 aria-expanded 开关),
  // 悬停提示去向;展开体/展开箭头/展开状态机清零。
  assert.match(issueBoard,
    /<button type="button" className="task-summary" onClick=\{onOpen\}/);
  assert.match(issueBoard, /title="进入问题工作台"/);
  assert.doesNotMatch(issueBoard,
    /aria-expanded|setExpanded|task-detail-body|task-chevron/);
  // 文字入口「进入问题工作台」删除——点击即达,不留第二入口;
  // 直达终止(2026-09-08)保留,终态卡不渲染终止钮的口径不变。
  assert.doesNotMatch(issueBoard, /panel-link/);
  // #219 终止钮随 ui.css 退役换 shadcn Button:ghost 皮 + 危险字色 +
  // hover 下划线,零盒感混排 task-meta 的形态原样保留。
  assert.match(issueBoard,
    /terminatable && <Button type="button" variant="ghost" size="sm"\s*\r?\n\s*className="h-auto px-0 font-semibold text-destructive/);
  assert.match(issueBoard, /action: "cancel"/);
  // 皮肤换 shadcn Card;现场直播(SSE)与耗时卡点(时间线拉取)不再被
  // 列表引用——这两类请求只属于工作台,列表不得回流。
  assert.match(issueBoard, /import \{ Card \} from "\.\.\/components\/ui\/card";/);
  assert.doesNotMatch(issueBoard, /IssueEventsPane|IssueCostPanel/);
  // 轮询边界:列表 5s 可见轮询保留(列表活性唯一来源),工作台内 10s
  // 详情跟随保留;除此之外没有别的循环请求。
  assert.match(issueBoard, /startVisiblePolling\(refreshList, 5000, document\)/);
  assert.match(issueBoard, /if \(!openId\) return;/);
  // 状态轨走令牌工具类;suspended 旧内联色收编为令牌 --suspended
  // (tokens.css 定义)。卡片轨道与状态胶囊不得再写裸色值(工作台
  // 页签等处的同名存量字面量另有专项,不在本契约)。
  assert.match(issueBoard, /suspended: "bg-suspended"/);
  const tokens = readFileSync(resolve("web/src/tokens.css"), "utf-8");
  assert.match(tokens, /--suspended: #3b83d5/);
  assert.doesNotMatch(css, /status-suspended \.task-status-rail/);
  assert.doesNotMatch(css, /\.pill\.suspended \{ color: #3b83d5/);
  // 等待/闲置光效必须住在非分层附录(层序里只有非分层规则能压过卡片皮
  // 的 bg-card/border-* 工具类);在 legacy 层会被静默压掉,不许回流。
  const annex = css.indexOf("非分层附录");
  const halo = css.indexOf(".issue-card-large.status-waiting_user {");
  assert.ok(annex > -1, "非分层附录标记缺失");
  assert.ok(halo > annex, "光效应住在附录里");
  // Card 基座显式 border-solid:legacy DOM 没有 .tw-root 归一,
  // border-width 不带 style 会落到初始值 none。
  assert.match(ui, /rounded-lg border border-solid/);
});

test("DTS 单号在两个列表里都是门户超链接", () => {
  // URL 构造器单源:dtsTicket.ts 是前端唯一拼写处;示例即用户给的
  // 真实门户地址形态,拼错一个字符就该红。
  const dtsTicket = readFileSync(
    resolve("web/src/issues/dtsTicket.ts"), "utf-8");
  assert.match(dtsTicket, /dts-szv\.clouddragon\.huawei\.com/);
  assert.match(dtsTicket, /\/DTSPortal\/ticket\/\$\{encodeURIComponent\(ticket\)\}/);
  // DTS 列表:单号格是真锚点(新开页签),不再是纯文字 span。
  assert.match(registration,
    /href=\{dtsTicketUrl\(ticket\.ticket\)\}\s*target="_blank" rel="noreferrer"/);
  assert.match(registration, /import \{ dtsTicketUrl \} from "\.\/dtsTicket";/);
  // 问题会话列表卡:单号在 task-summary 按钮内,必须 stopPropagation
  // 拦冒泡——点单号开 DTS,不能顺带打开工作台。
  assert.match(issueBoard,
    /href=\{dtsTicketUrl\(issue\.ticket\)\}[\s\S]{0,120}onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(issueBoard, /import \{ dtsTicketUrl \} from "\.\/dtsTicket";/);
});
