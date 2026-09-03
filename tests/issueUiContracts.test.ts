import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const registration = readFileSync(
  resolve("web/src/issues/Registration.tsx"), "utf-8");
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
  assert.match(registration,
    /页面账号 <i className="req">\*<\/i>[\s\S]*placeholder="admin" required/);
  assert.match(registration,
    /网管环境IP一次只填一个，请不要输入逗号、空格或换行/);
  assert.match(decisions,
    /invalidHost = host !== "" && \/\[\\s,，、\]\//);
  assert.match(registration, /if \(!envPageAccount\.trim\(\)\)/);
  assert.match(registration, /团队资产 → 业务模块/);
  // 模块带仓不占版面(2026-08-31 拍板):常驻仓清单移除,选中后悬停
  // 弹悬浮卡列出将拉取的仓(键盘聚焦同样弹出);要增删仓去团队资产。
  assert.doesNotMatch(registration, /将拉取的代码仓/);
  assert.match(registration, /issue-module-wrap/);
  assert.match(registration, /已带出 \{selectedModule\.repositories\.length\} 个代码仓,悬停查看/);
  assert.match(registration, /issue-module-tip" role="tooltip"/);
  assert.match(css, /\.issue-module-wrap:hover \.issue-module-tip,[\s\S]*focus-within/);
});

test("口令选择器可用键盘操作，窄屏不会溢出", () => {
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.ok(registration.includes(`\"${key}\"`), `缺少 ${key} 键盘行为`);
  }
  assert.match(registration, /aria-haspopup="listbox"/);
  assert.match(css,
    /@media \(max-width: 680px\) \{[\s\S]*\.issue-form, \.issue-group-body \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css,
    /@media \(max-width: 680px\) \{[\s\S]*\.issue-password-menu \{[\s\S]*position: static;/);
});

test("DTS 详情按钮不嵌在勾选标签内，窄屏下拉与触控目标可达", () => {
  const rowLabel = registration.match(
    /<label className="issue-dts-row-main">([\s\S]*?)<\/label>/)?.[1] ?? "";
  assert.ok(rowLabel, "必须保留可点击的单据勾选标签");
  assert.doesNotMatch(rowLabel, /<button/);
  assert.match(registration, /className="issue-dts-expand"[\s\S]*aria-controls=\{detailId\}/);
  assert.match(registration, /aria-label=\{`\$\{isExpanded \? "收起" : "展开"\}/);
  assert.match(css,
    /\.issue-dts-expand \{[\s\S]*min-width: 44px; min-height: 44px;/);
  assert.match(css,
    /@media \(max-width: 680px\) \{[\s\S]*\.issue-dts-version-menu \{[\s\S]*position: static;[\s\S]*max-width: 100%/);
  assert.match(css,
    /\.issue-dts-version-option, \.issue-dts-version-clear-all \{[\s\S]*min-height: 44px/);
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
});

test("隐私说明如实覆盖 AI 上下文，管理员旁路有明确入口", () => {
  assert.match(registration, /不会出现在会话[\s\S]*事件流[\s\S]*明文进入[\s\S]*AI 上下文/);
  assert.match(decisions, /不会出现在会话列表、[\s\S]*事件流[\s\S]*AI 上下文/);
  assert.match(issueFlow, /网管环境口令的契约[\s\S]*AI 上下文[\s\S]*事件流/);
  assert.doesNotMatch(issueFlow, /网管环境密码[\s\S]{0,120}不进模型上下文/);
  assert.match(annotations, /canOverride\?: boolean/);
  assert.match(annotations, /管理员代删/);
  assert.match(annotations, /管理员代确认/);
  assert.match(annotations, /完整内容见“执行现场”/);
});

test("环境保险箱注释与真实 AI 口令契约一致", () => {
  assert.match(environmentVault, /解密到当前问题的 AI 上下文/);
  assert.match(environmentVault, /列表\/状态\/事件只给引用/);
  assert.doesNotMatch(environmentVault, /不(?:进|进入).*Agent 上下文/);
  assert.match(issueService,
    /environmentCredentials 会按 ADR-0003 解密到当前问题的 AI 上下文/);
  assert.match(issueService, /不出现在会话列表、状态摘要或事件流/);
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
  const rail = readFileSync(resolve("web/src/issues/IssueRail.tsx"), "utf-8");
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
  // 对新闸天然成立,这里钉住分派没被绕开。
  assert.match(rail,
    /waiting && \(canOperate\s*\?\s*<IssueDecisionCard[\s\S]*?:\s*<IssueWaitingFacts waiting=\{waiting\} \/>\)\}/);
  // 事实卡按闸种点名"等归属人做什么"(不可修=平台处理,证据=回灌原文)。
  assert.match(rail, /等归属人在交付平台处理\/豁免流水线告警/);
  assert.match(rail, /等归属人回灌流水线报错原文/);
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
  assert.match(confirmDialog, /role="dialog"/);
  assert.match(confirmDialog, /aria-modal="true"/);
  assert.match(confirmDialog, /aria-labelledby="confirm-dialog-title"/);
  assert.match(confirmDialog, /event\.key === "Escape"/);
  assert.match(confirmDialog, /event\.key === "Tab"/);
  assert.match(confirmDialog, /event\.target === event\.currentTarget/);
  assert.match(confirmDialog, /queue\[0\]/, "FIFO 排队:同一时刻只渲染队首");
  assert.match(confirmDialog, /options\.danger \? cancelRef : confirmRef/,
    "危险档默认焦点落「取消」,普通档落「确认」");
  assert.match(confirmDialog, /triggerRef\.current\?\.focus\(\)/,
    "关闭后焦点归还触发元素");
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

test("DTS 列表人工预绑模块列:选即存/显隐记忆/发起静默携带(spec #57)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // API 面:全量拉取 + 单条写(空=解绑),走 /issues/dts-bindings。
  assert.match(apiTypes, /getDtsModuleBindings/);
  assert.match(apiTypes, /putDtsModuleBinding/);
  assert.match(apiTypes, /"\/issues\/dts-bindings"/);
  assert.match(apiTypes, /dts-bindings\/\$\{encodeURIComponent\(ticket\)\}/);
  // 列渲染:每行原生 select + 「未选择」解绑项 + aria 标注。
  assert.match(registration, /issue-dts-module-cell/);
  assert.match(registration,
    /<option value="">未选择\(AI 运行时识别\)<\/option>/);
  assert.match(registration, /aria-label=\{\`\$\{ticket\.ticket\} 所属业务模块\`\}/);
  // 选即存:乐观更新失败回滚,反馈落在行内。
  assert.match(registration, /async function bindModule\(/);
  assert.match(registration, /putDtsModuleBinding\(ticketNo, moduleId \|\| null\)/);
  assert.match(registration, /issue-dts-module-fail/);
  // 显隐:工具栏开关 + localStorage 按用户记忆。
  assert.match(registration, /issue-dts-module-toggle/);
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
  const rail = readFileSync(resolve("web/src/issues/IssueRail.tsx"), "utf-8");
  // 工作台头部:绑单输入是写操作,三元链最末分支必须直接挂在 canOperate
  // 上——把控件挪出该分支(渲染后靠报错兜底)= 回归,当场红;
  // 「无单场景」是状态说明不是控件,查看模式照常示人。
  assert.match(sessionView,
    /\? <span className="issue-ticket empty">无单场景<\/span>[\s\S]*?: canOperate && <span className="issue-bind">/);
  // 认证报错的「去个人设置配置令牌」修的是归属人的凭据,查看模式不渲染。
  assert.match(sessionView,
    /\{canOperate && onNavigateProfile && detail\.error\.includes\(GIT_AUTH_ERROR_TAG\)/);
  // 双栏下传:右栏 NEXT ACTION 与材料页签都必须拿到 canOperate,
  // 面板内部的写控件由各自文件的断言钉住。
  assert.match(sessionView, /<IssueRail[\s\S]*?canOperate=\{canOperate\}/);
  assert.match(sessionView, /<IssueMaterialsPane[\s\S]*?canOperate=\{canOperate\}/);
  // 信息面不收:现场直播(SSE)与耗时卡点不带任何归属条件。
  assert.match(sessionView, /: <IssueEventsPane id=\{detail\.id\} active \/>/);
  assert.match(sessionView, /<IssueCostPanel id=\{detail\.id\} \/>/);
  // 右栏:作答卡(问题卡+平台闸+env 表单)只在归属分支,查看模式渲染
  // 无作答控件的事实卡(题面/选项/背景照看,替归属人判断卡在哪)。
  assert.match(rail,
    /waiting && \(canOperate\s*\?\s*<IssueDecisionCard[\s\S]*?:\s*<IssueWaitingFacts waiting=\{waiting\} \/>\)\}/);
  // 转正卡只在归属分支;挂起的等待说明对围观者保留。
  assert.match(rail,
    /detail\.status === "suspended" && \(canOperate\s*\?\s*<IssueAssociateCard[\s\S]*?:\s*<div className="issue-rail-card is-suspended">/);
  // 三处输入行(收口追问/运行中插话/空闲续聊)逐处收进归属分支。
  assert.equal((rail.match(/canOperate && <RailInput/g) ?? []).length, 3,
    "右栏的续聊/插话输入必须逐处挂在 canOperate 分支下");
  // done 卡的归档按钮与底部归档/取消按钮组整组不渲染。
  assert.match(rail,
    /\{canOperate && <button type="button" className="issue-rail-primary"/);
  assert.match(rail, /\{canOperate && <div className="issue-rail-actions">/);
  // 材料页签:快速修改编辑器整块(选文件/保存/请 AI 复核)、压缩包解压、
  // 检视页签与圈注写口(记意见/提交/移除)全部收闸。
  assert.match(materials, /\{canOperate && <div className="issue-materials-editor">/);
  assert.match(materials,
    /\{canOperate && node\.archive && <button type="button" className="issue-log-extract"/);
  assert.match(materials,
    /canOperate && detail\.mode === "fixed"\s*\?\s*\[\{ key: REVIEW_TAB/);
  assert.match(materials,
    /active === ANALYSIS_DOC && reviewEnabled && canOperate\s*\?\s*<Annotatable/);
});

test("团队看板问题卡片入口行为不变:点击即进,不含归属判断", () => {
  const teamCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  // 入口语义(spec 拍板):纯 onOpen 回调,文案与行为不因身份变化;
  // 非归属人点开即达,查看模式在会话工作台内部呈现,卡片不做归属裁剪。
  assert.match(teamCard, /onOpen: \(\) => void/);
  assert.match(teamCard, /onClick=\{onOpen\}/);
  assert.match(teamCard, /进入问题工作台/);
  // 固化现状:卡片不出现任何身份/归属判断(陈列 issue.account 不算判断)。
  assert.doesNotMatch(teamCard, /canOperate|isOwner|viewerUsername|viewer\.|username/);
});

test("单号处处可选中复制:DTS 行单号独立于勾选 label,user-select 强制放开", () => {
  // 单号是绑单/推送分支名的关键操作对象,复制是高频动作;button(会话
  // 卡片)与 label(DTS 行)内的拖选被浏览器默认禁掉,CSS 强制放开。
  assert.match(css,
    /\.task-ticket,\s*\.issue-dts-ticket,\s*\.issue-ticket\s*\{[^}]*user-select:\s*text/);
  // DTS 行:单号(含远程徽标)是 row-control 的直接子元素,排在勾选
  // label 之前——拖选单号不会误勾选。
  const rowSlice = registration.slice(
    registration.indexOf('className="issue-dts-row-control"'),
    registration.indexOf("issue-dts-expand"));
  assert.ok(rowSlice.includes("issue-dts-identity"),
    "DTS 行模板应包含单号容器");
  assert.ok(
    rowSlice.indexOf("issue-dts-identity") < rowSlice.indexOf("issue-dts-row-main"),
    "单号容器必须在勾选 label 之前(独立可拖选)");
  const labelSlice = rowSlice.slice(rowSlice.indexOf("issue-dts-row-main"));
  assert.equal(labelSlice.includes("issue-dts-identity"), false,
    "勾选 label 内不得再含单号容器");
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

test("推送前 UT 纪律:push_branch 描述写明先跑测试全绿再推,开场契约指路(#83)", () => {
  // 纯文案纪律(用户拍板:不加台账闸、不做宿主拦截)。ADR-0016 文案
  // 外置后,纪律本体钉在 push_branch 的 description(调用时刻的权威
  // 表面,Agent 常驻可见):跑什么(改动相关必跑+时间允许全量)、什么
  // 标准(全绿才推)、不过怎么办(继续修,不许跳过测试直接推);开场
  // 契约(assets/issue-prompts/opening.md)只留指路,不复述机制。
  const opening = readFileSync(
    resolve("assets/issue-prompts/opening.md"), "utf-8");
  assert.match(opening, /推送、提 MR 与清单申报的纪律/,
    "开场契约缺推送/申报纪律的指路句");
  assert.match(opening, /写在对应工具的说明里/,
    "开场契约应把机制让给工具说明(单一权威源)");
  const source = issueTools;
  assert.match(source, /推送前 UT 纪律/, "缺推送前 UT 纪律引导");
  assert.match(source, /用例必跑/, "缺「改动相关用例必跑」口径");
  assert.match(source, /全量回归/, "缺「时间允许跑全量回归」口径");
  assert.match(source, /全绿才推/, "缺「全绿才推」标准");
  assert.match(source, /不许跳过测试直接推/, "缺「挂测不许硬推」红线");
  // 纪律必须落在 push_branch 工具定义的 description 里(name 与
  // parameters 之间),不是 tools.ts 里随便哪个角落。
  const pushBranchDesc = issueTools.match(
    /name: "push_branch"[\s\S]*?parameters: Type\.Object/)?.[0] ?? "";
  assert.ok(pushBranchDesc, "push_branch 工具定义必须存在");
  assert.match(pushBranchDesc, /推送前 UT 纪律/,
    "push_branch 的 description 必须自带推送前跑 UT 的纪律");
});
