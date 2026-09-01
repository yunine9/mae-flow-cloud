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
