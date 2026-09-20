/**
 * 团队域拆分导航(2026-09-10 拍板)与两域排版同构(2026-09-11 拍板)
 * 的契约:侧栏「团队需求/团队问题」两条目互斥、页内领域切换器退场、
 * 需求板净化(问题会话不再混进需求队列)、两域共用 TeamWorldTabs 页签
 * 骨架、问题页概览+现场/档案面板两面板、问题侧交付概览口径纯函数、
 * 档案措辞。纯文本源码锚点(同 issueUiContracts 模式)+ teamOps 纯函数
 * 直跑(同 teamOps.test.ts 模式)。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  ISSUE_DELIVERY_STATUSES,
  ISSUE_DELIVERY_STAGES,
  issueDeliveryBreakdown,
  issueFeatureOnceRates,
  issueFeatureRows,
} from "../web/src/teamOps.ts";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const teamOps = readFileSync(resolve("web/src/teamOps.ts"), "utf-8");
const issueWorld = readFileSync(
  resolve("web/src/TeamIssueWorld.tsx"), "utf-8");
const historyBoard = readFileSync(
  resolve("web/src/HistoryBoard.tsx"), "utf-8");

test("导航按域拆两条:团队需求(view=team)+团队问题(view=teamIssues)", () => {
  // View 类型与路由白名单都认 teamIssues,历史恢复不会把它丢成根视图。
  assert.match(app, /type View = "team" \| "teamIssues"/);
  assert.match(app, /"team", "teamIssues", "mine"/);
  // 两条导航都在;团队问题的徽章=等答复含 idle。团队需求行不挂数
  // (3c7c3558 移除:等决策入口在「我的需求」,团队行再挂数珠重复无益)。
  assert.match(app,
    /view="team" current=\{view\} onSelect=\{selectView\} label="团队需求" \/>/);
  assert.match(app,
    /view="teamIssues" current=\{view\} onSelect=\{selectView\} label="团队DTS" badge=\{issueWaitingCount\}/);
  assert.match(app,
    /issueWaitingCount = teamIssues\.filter\(\(issue\) =>\n    issue\.status === "waiting_user" \|\| issue\.status === "idle"\)\.length/);
  // 「团队任务」作为页面名退役(源码不再出现;历史提交里留着)。
  assert.doesNotMatch(app, /团队任务/);
  // 头部两域各有标题与一句话说明。
  assert.match(app, /team: \{ title: "团队需求"/);
  assert.match(app, /teamIssues: \{ title: "团队问题"/);
});

test("页内领域切换器退场:组件与挂载点、localStorage 键全都不在了", () => {
  assert.equal(existsSync(resolve("web/src/TeamDomainSwitch.tsx")), false,
    "切换器应从本分支删除(提交留在 git 历史)");
  assert.equal(existsSync(resolve("web/src/prototype/TeamDomainSwitch.tsx")),
    false, "原型文件应保持退场");
  assert.doesNotMatch(app, /TeamDomainSwitch/);
  assert.doesNotMatch(app, /teamDomain/);
  assert.doesNotMatch(app, /mae-flow:team-domain/);
});

test("需求板净化:TeamDashboard 只装需求任务,问题会话不再混进队列", () => {
  // 组件签名不再收 issues/onOpenIssue,队列不再渲染问题卡。
  assert.match(app, /function TeamDashboard\(\{\n  tasks,\n  users,/);
  assert.doesNotMatch(app, /<TeamIssueCard/);
  assert.doesNotMatch(app, /issueToTeamTask/);
  // 适配器随拆分成死代码,teamOps 里一并移除(口径唯一,不留双入口)。
  assert.doesNotMatch(teamOps, /issueToTeamTask/);
  // 问题会话的团队全景有且只有一个家:「团队问题」页签页。
  // (#228)team-tasks-workspace 壳类退役,最小宽约束直接落在 section。
  assert.match(app, /view === "teamIssues" && <section className="min-w-0">/);
  // onceRates 是 #290 票4 一次率二轴统计的取数(服务端聚合,组件只渲染);
  // 卡片自带新页签链接(ADR-0040),App 不再传 onOpenIssue 跳转回调。
  assert.match(app,
    /<TeamIssueWorld issues=\{teamIssues\} onceRates=\{issueOnceRates\} \/>/);
});

test("团队问题页:概览+现场在当前面板,队列空态与需求侧同款", () => {
  // 概览:与需求侧同一套外观配方(#233 去 legacy 化后 skin 类退役,
  // 同款契约由 b0cfe8d 引入的 CELL_BASE 工具类配方承担,与 App.tsx
  // TeamDeliveryOverview 的 CELL_BASE 同文本,teamDashboardLayout 同锚)。
  assert.match(issueWorld, /aria-label="问题处理概览"/);
  assert.match(issueWorld, /const CELL_BASE = "flex min-h-\[38px\][^"]*rounded-lg border border-line bg-surface px-\[11px\] py-1\.5[^"]*disabled:opacity-55"/,
    "概览格与需求侧共用 38px 紧凑筛选格配方(disabled 随 count 置灰)");
  assert.match(issueWorld, /id="issue-delivery-stage-title"/);
  assert.match(issueWorld, /id="issue-delivery-status-title"/);
  // 概览数据走新口径函数(与需求侧 teamDeliveryBreakdown 同构)。
  assert.match(issueWorld, /issueDeliveryBreakdown\(issues\)/);
  // 队列:筛选三件套(搜索/现场范围/责任人)+ 真实 TeamIssueCard。
  assert.match(issueWorld, /aria-label="筛选问题现场"/);
  assert.match(issueWorld, /aria-label="现场范围"/);
  assert.match(issueWorld, /aria-label="责任人"/);
  assert.match(issueWorld, /placeholder="搜索问题、单号或负责人"/);
  assert.match(issueWorld, /<TeamIssueCard key=\{issue\.id\} issue=\{issue\}/);
  // 概览格 0 计数置灰禁用与需求侧同规则(disabled 随 count)。
  assert.match(issueWorld, /disabled=\{count === 0\}/);
  // 空态使用共用 Empty 组件，保留可访问状态与明确说明。
  assert.match(issueWorld, /<Empty[^>]*role="status"/);
  assert.match(issueWorld, /<EmptyTitle>/);
  assert.doesNotMatch(issueWorld, /review-clear/);
  // 档案措辞:概览说明句与需求侧同构(已取消…仅保留在成果档案)。
  assert.match(issueWorld, /已取消会话仅保留在成果档案/);
});

test("团队问题档案面板镜像 HistoryBoard 骨架,行仍用问题卡", () => {
  // 骨架四件套与需求侧成果档案同款(#233 后 history-* 皮肤类退役,
  // 同款契约由与 HistoryBoard 逐字相同的工具类配方承担,见 b0cfe8d)。
  assert.match(issueWorld, /aria-label="成果档案·问题闭环"/);
  assert.match(issueWorld,
    /flex items-center justify-between gap-6 rounded-xl border border-line\s*\n\s*bg-surface px-6 py-\[22px\] shadow-xs/,
    "档案头卡与 HistoryBoard 同配方");
  assert.match(issueWorld, /<h2 className="text-lg font-bold text-text-strong">成果档案·问题闭环<\/h2>/);
  // 结论词表收敛后五格(全部闭环/已交付/问题成立/非问题/已取消,
  // ADR-0037),宽屏一行排下。
  assert.match(issueWorld, /grid grid-cols-2 gap-2\.5 min-\[1081px\]:grid-cols-5/);
  assert.match(issueWorld, /flex min-h-\[94px\] flex-col justify-between rounded-lg border border-line bg-surface px-\[15px\] py-3\.5 shadow-xs/,
    "结论指标瓦片与 HistoryBoard 指标瓦片同配方");
  assert.match(issueWorld, /<EmptyTitle>还没有闭环的问题会话<\/EmptyTitle>/);
  assert.match(issueWorld, /conclusion\?\.kind === kind/);
  // 档案列表仍用会话卡(内容差异),不再与现场平铺在同一页。
  const worldBody = issueWorld.split("/** 成果档案·问题闭环")[0];
  assert.doesNotMatch(worldBody, /history-board/,
    "TeamIssueWorld 本体只出概览+现场;档案必须由页签面板 TeamIssueArchive 承载");
  assert.match(issueWorld, /<TeamIssueCard key=\{issue\.id\} issue=\{issue\} \/>/);
  assert.match(app, /<TeamIssueArchive issues=\{teamIssues\} \/>/);
});

test("问题侧交付概览口径:给定会话集合,规模与阶段/状态格计数正确", () => {
  const issue = (status: string, stage?: string) => ({ status, stage });
  const rows = [
    issue("queued", "dts_info"),
    issue("running", "analyze"),
    issue("failed", "fix"),
    issue("waiting_user", "mr_green"),
    issue("idle", "prep_repo"),
    issue("suspended", "analyze"),
    issue("archived", "mr_green"),
    issue("canceled", "analyze"),
  ];
  const stats = issueDeliveryBreakdown(rows);
  assert.deepEqual({
    total: stats.total,
    active: stats.active,
    waiting: stats.waiting,
    failed: stats.failed,
    closed: stats.closed,
  }, {
    // 已取消不进总数;active 再剔除已闭环;waiting 归一含 idle。
    total: 7, active: 6, waiting: 2, failed: 1, closed: 1,
  });
  // 阶段格=注册表全集(有单五阶段 ∪ 无单 conclude),固定顺序,
  // 0 计数(conclude)也在场——渲染层置灰,口径层保留全集。
  assert.deepEqual(stats.stages, [
    { key: "dts_info", count: 1 },
    { key: "prep_repo", count: 1 },
    { key: "analyze", count: 2 },
    { key: "fix", count: 1 },
    { key: "mr_green", count: 1 },
    { key: "conclude", count: 0 },
  ]);
  // 状态格=展示归一五状态(waiting_user 吸收 idle),各组加总=active。
  assert.deepEqual(stats.statuses, [
    { key: "queued", count: 1 },
    { key: "running", count: 1 },
    { key: "waiting_user", count: 2 },
    { key: "suspended", count: 1 },
    { key: "failed", count: 1 },
  ]);
  assert.equal(stats.stages.reduce((sum, item) => sum + item.count, 0),
    stats.active, "阶段格加总必须等于 active,概览两组不许各算各的");
  assert.equal(stats.statuses.reduce((sum, item) => sum + item.count, 0),
    stats.active, "状态格加总必须等于 active");
});

test("问题侧概览口径:空集合也出全集格子(0 展示但不虚报)", () => {
  const stats = issueDeliveryBreakdown([]);
  assert.equal(stats.total, 0);
  assert.deepEqual(stats.stages.map((item) => item.key), [...ISSUE_DELIVERY_STAGES],
    "阶段全集来自问题流注册表镜像,空现场也摆出完整流程形状");
  assert.deepEqual(stats.statuses.map((item) => item.key), [...ISSUE_DELIVERY_STATUSES]);
  assert.ok(stats.stages.every((item) => item.count === 0));
  assert.ok(stats.statuses.every((item) => item.count === 0));
});

test("特性总账表(2026-09-18 拍板):首行总账默认收起,展开逐特性对比,f: 行筛选进队列", () => {
  // 概览里的表锚点:收起态只有总账行,展开开关与特性行点击各有其锚。
  assert.match(issueWorld, /aria-label="特性总账"/);
  assert.match(issueWorld, /aria-expanded=\{open\}/,
    "展开元素带 aria-expanded,首行=全部特性总账");
  assert.match(issueWorld, /issueFeatureRows\(issues\)/,
    "特性口径与概览同源(teamOps 聚合,组件零计算)");
  assert.match(issueWorld,
    /onClick=\{\(\) => onSelectCell\(`f:\$\{row\.module\}`\)\}/,
    "特性行点击走概览格筛选(f:<module>),与阶段/状态格同语义");
  // 口径:按业务模块聚合复用 issueDeliveryBreakdown,canceled 不计,
  // module 空白归「未分类」;排序=处理中降序→总数降序→名称。
  const rows = issueFeatureRows([
    { status: "running", module: "语音特性-降噪" },
    { status: "waiting_user", module: "语音特性-降噪" },
    { status: "archived", module: "语音特性-降噪" },
    { status: "failed", module: "无线特性-漫游切换" },
    { status: "canceled", module: "无线特性-漫游切换" },
    { status: "archived" },
  ]);
  assert.deepEqual(rows, [
    { module: "语音特性-降噪", active: 2, waiting: 1, failed: 0, closed: 1, total: 3 },
    { module: "无线特性-漫游切换", active: 1, waiting: 0, failed: 1, closed: 0, total: 1 },
    { module: "未分类", active: 0, waiting: 0, failed: 0, closed: 1, total: 1 },
  ]);
  // 每特性一次率:per_session 明细按会话归特性,分母 0 显示 —(null)。
  assert.match(issueWorld, /issueFeatureOnceRates\(/,
    "总账表一次定位/一次修复两列与头部瓦片同源(端点 per_session)");
  const once = issueFeatureOnceRates(
    rows.map((row) => ({ id: row.module, module: row.module })),
    [
      { id: "语音特性-降噪", localization_pass: false, repair_pass: true },
      { id: "语音特性-降噪", localization_pass: true, repair_pass: false },
      { id: "无线特性-漫游切换", localization_pass: true, repair_pass: true },
    ],
  );
  assert.deepEqual(once.get("语音特性-降噪"),
    { total: 2, localization: 50, repair: 50 });
  assert.deepEqual(once.get("无线特性-漫游切换"),
    { total: 1, localization: 100, repair: 100 });
  assert.equal(once.get("未分类"), undefined, "无完成交付会话的特性不出列值");
});
