/**
 * 问题处理导航组的 UI 契约(票 #171;先例:environmentRegistryUi.test.ts)。
 *
 * 只断言源码里外部可见的结构与交互锚点:Beta 全摘(标签文字/悬停/读屏
 * +导航按钮的 beta 分支删除)、父行=可展开/收起开关(radix Collapsible,
 * 箭头旋转指示)、子页签三枚(问题登记/DTS列表/问题会话)且 admin 只见
 * 「问题会话」、右侧三页面常驻驻留(隐藏切换不卸载)、深链 /issues/:id
 * 自动展开并高亮「问题会话」。不测样式实现细节;子页签区走新 Tailwind
 * 轨道(tw-root 归一、零 css import、零硬编码色值)与台账页同一纪律。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
const registration = readFileSync(
  resolve("web/src/issues/Registration.tsx"), "utf-8");
const css = readFileSync(resolve("web/src/tailwind.css"), "utf-8");
const legacyCss = readFileSync(resolve("web/src/style.css"), "utf-8");

/** 侧边栏导航区(视图切换)整段,角色分支再切片。 */
function navSlices(): { nav: string; admin: string; developer: string } {
  const nav = app.slice(app.indexOf('aria-label="视图切换"'), app.indexOf("</nav>"));
  const admin = nav.slice(
    nav.indexOf('session.role === "admin" ? <>'), nav.indexOf("</> : <>"));
  const developer = nav.slice(nav.indexOf("</> : <>"));
  return { nav, admin, developer };
}

test("Beta 全摘:标签文字、悬停/读屏提示、导航按钮 beta 分支一并删除", () => {
  assert.doesNotMatch(app, /问题处理（Beta）/, "标签文字不得再带 Beta");
  assert.doesNotMatch(app, /能力建设中/, "悬停/读屏的 Beta 提示语应删除");
  assert.doesNotMatch(app, /beta\s*=\s*false|beta\?:\s*boolean|\bbeta\b\s*\?\s*`/,
    "NavButton 的 beta 分支应删净(唯一使用方已退役)");
  // 问题处理入口仍在两侧导航(admin 管理视角组/开发个人工作台组)。
  const { admin, developer } = navSlices();
  assert.ok(admin.includes('view="issues"'), "admin 侧栏缺问题处理入口");
  assert.ok(developer.includes('view="issues"'), "开发侧栏缺问题处理入口");
});

test("父行=展开/收起开关:Collapsible 承载,箭头旋转指示,点击不跳页", () => {
  assert.match(app, /from "radix-ui"/, "折叠原语应来自 radix-ui(已在依赖)");
  assert.match(app, /ChevronDown/, "展开指示箭头(lucide)");
  assert.match(app, /Collapsible\.Trigger/, "父行是触发器");
  assert.match(app, /Collapsible\.Content/, "子页签区是折叠内容");
  assert.match(app, /rotate-180/, "展开态箭头旋转 180°");
  // 父行沿用存量 nav-item 家族(视觉零跳变),但不再走 onSelect 跳页。
  const { nav } = navSlices();
  const parentRow = nav.slice(nav.indexOf("IssueNavGroup"),
    nav.indexOf("</> : <>"));
  assert.ok(parentRow.length > 0, "问题处理导航组应作为独立组件挂两侧");
  assert.doesNotMatch(nav, /<NavButton view="issues"/,
    "问题处理不再是普通 NavButton(它现在是开关,不是直跳页签)");
});

test("子页签:开发三枚(问题登记/DTS列表/问题会话),admin 只见问题会话", () => {
  const { admin, developer } = navSlices();
  for (const [name, branch] of [["admin", admin], ["开发", developer]] as const) {
    assert.ok(branch.includes("<IssueNavGroup"), `${name}侧导航应挂问题处理组`);
  }
  // 子页签集在组件内按角色裁剪:admin 条目只有「问题会话」;开发侧三枚。
  const group = app.slice(app.indexOf("function IssueNavGroup"),
    app.indexOf("function NavButton"));
  assert.match(group,
    /admin\s*\?\s*\[\{ tab: "sessions", label: "问题会话" \}\]/,
    "admin 分支只应有问题会话一个子页签");
  for (const [tab, label] of [
    ["register", "问题登记"], ["dts", "DTS 列表"], ["sessions", "问题会话"],
  ] as const) {
    assert.ok(group.includes(`{ tab: "${tab}", label: "${label}" }`),
      `开发侧子页签缺「${label}」`);
  }
  // 子页签行走新 Tailwind 轨道:tw-root 归一(与台账页同纪律)。
  assert.match(group, /tw-root/, "子页签区挂 tw-root(scoped 归一)");
});

test("子页签状态:默认落问题会话,选择经父层驱动右侧页面", () => {
  assert.match(app, /"sessions"/, "默认子页签=问题会话");
  assert.match(app, /IssueChildTab/, "子页签是具名联合类型,不是散字符串");
  assert.match(board, /childTab/, "问题板按子页签承接右侧页面");
});

test("右侧三页面常驻驻留:登记/DTS/会话列表都是隐藏切换,不卸载", () => {
  // 登记域仅开发者渲染(服务端拒 admin 发起,入口语义不变),面板由
  // 子页签受控;可见性走 hidden,不得条件卸载(卸载即丢表单驻留)。
  assert.match(board, /viewer\.role !== "admin" && <IssueRegistration/);
  assert.match(board, /visible=\{/, "登记域显隐经 visible 属性驱动");
  assert.doesNotMatch(board,
    /childTab === "sessions" && <IssueRegistration/,
    "登记域不得随子页签条件卸载");
  // 会话列表段同样 hidden 切换(保留既有 admin 全部问题标题口径)。
  assert.match(board, /hidden=/, "页面区块显隐走 hidden(状态驻留)");
  // 登记域组件:内部页签按钮退役,两面板由受控属性决定可见性。
  assert.doesNotMatch(registration, /issue-register-tabs/,
    "内部页签按钮已由导航子页签接管");
  assert.match(registration, /hidden=\{/, "两面板仍常驻(hidden 切换)");
});

test("深链 /issues/:id:进入即子页签落问题会话(通知点开直达工作台)", () => {
  // 打开会话(点列表/团队任务联动)与浏览器前进后退两条路都要落。
  const hits = app.match(/setIssueChildTab\("sessions"\)/g) ?? [];
  assert.ok(hits.length >= 2,
    `深链两路(打开会话/前进后退)都应落问题会话,实际 ${hits.length} 处`);
});

test("子页签选择持久化:localStorage 与历史快照双轨,前进/后退可还原", () => {
  assert.match(app, /mae-flow:issue-child-tab/, "localStorage 存储键");
  assert.match(app, /localStorage\.setItem\(ISSUE_CHILD_STORAGE_KEY/,
    "选择变化要写回 localStorage(刷新还原)");
  assert.match(app, /maeFlowIssueChildTab/, "历史快照要带子页签字段");
  assert.match(app, /issueChildTabFromHistoryState\(event\.state\)/,
    "popstate 后退/前进要还原子页签");
  // 已在问题处理时点子页签:不推新历史条目,但必须原地改写快照——
  // 否则快照落后一次点击,前进/后退还原到过期子页签。
  assert.match(app,
    /replaceState\(appHistoryState\("issues", undefined, tab\)/,
    "子页签选择要写进历史快照(经 selectIssueChild 的 replaceState)");
  // selectView 的闭包读不到同 tick 的新状态:子页签当前值必须走 ref。
  assert.match(app, /activeIssueChildRef\.current = tab;/,
    "选择要同步进 ref(selectView 快照不落后)");
});

test("DTS 列表子页签全宽:页面平铺屏幕,其余子页签维持书页宽", () => {
  // 表格横向信息密(spec #171 评审后追加):DTS 子页签下主区放开
  // max-width,其余子页签(登记/问题会话)不放宽。
  assert.match(app,
    /workspace-main\$\{view === "issues" && activeIssueChild === "dts" \? " is-wide" : ""\}/,
    "主区宽度应随 DTS 子页签切换");
  assert.match(legacyCss, /\.workspace-main\.is-wide \{ max-width: none; \}/,
    "css 层要有全宽规则(旧轨道层叠优先级高于工具类层)");
});

test("子页签区零硬编码色值:色彩一律走令牌桥(theme inline 映射存量变量)", () => {
  // 新 Tailwind 轨道的样式纪律:hex/rgb 色值不进 className,统一用
  // text-faint/bg-surface-3 这类令牌工具类(定义见 tailwind.css 桥)。
  // 前瞻要求含字母位:#103 这种纯数字票号引用不算色值。
  const { nav } = navSlices();
  assert.ok(!/#[0-9a-fA-F]*(?:[a-fA-F][0-9a-fA-F]*){1,4}\b/.test(nav),
    "导航区不得硬编码 hex 色值");
  assert.match(css, /--color-faint: var\(--faint\)/, "令牌桥供给 faint 色工具类");
});
