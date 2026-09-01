import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(decisions,
    /return questions\.length > 0 && questions\.every\(\(item, index\) =>[\s\S]*item\.options\.length > 0 \? !!picked\[index\] : !!custom\[index\]\?\.trim\(\)\)/);
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

test("过程文档可原位全屏，退出后保留当前页签", () => {
  assert.match(materials, /issue-doc\$\{fullscreen \? " is-fullscreen"/);
  assert.match(materials, /fullscreen \? "退出全屏" : "全屏查看"/);
  assert.match(materials, /if \(event\.key === "Escape"\) setFullscreen\(false\)/);
  assert.match(css, /\.issue-thread\.issue-doc\.is-fullscreen \{/);
});
