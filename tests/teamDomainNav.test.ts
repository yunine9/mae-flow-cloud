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
} from "../web/src/teamOps.ts";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const teamOps = readFileSync(resolve("web/src/teamOps.ts"), "utf-8");
const issueWorld = readFileSync(
  resolve("web/src/TeamIssueWorld.tsx"), "utf-8");
const historyBoard = readFileSync(
  resolve("web/src/HistoryBoard.tsx"), "utf-8");
const helpCenter = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");

test("导航按域拆两条:团队需求(view=team)+团队问题(view=teamIssues)", () => {
  // View 类型与路由白名单都认 teamIssues,历史恢复不会把它丢成根视图。
  assert.match(app, /type View = "team" \| "teamIssues"/);
  assert.match(app, /"team", "teamIssues", "mine"/);
  // 两条导航都在,徽章各算各的域(需求等决策/问题等答复含 idle)。
  assert.match(app,
    /view="team" current=\{view\} onSelect=\{selectView\} label="团队需求" badge=\{waitingCount\}/);
  assert.match(app,
    /view="teamIssues" current=\{view\} onSelect=\{selectView\} label="团队问题" badge=\{issueWaitingCount\}/);
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
  assert.match(app, /<TeamIssueWorld issues=\{teamIssues\} onOpenIssue=\{openIssueSession\} \/>/);
});

test("两域页签同构:同一 TeamWorldTabs 组件,防版式漂移(2026-09-11)", () => {
  // 单一定义,两页各挂一次(需求/问题)。
  assert.match(app, /function TeamWorldTabs\(/);
  assert.equal((app.match(/<TeamWorldTabs domain=/g) ?? []).length, 2,
    "团队需求与团队问题必须共用同一个页签组件");
  // 骨架:role=tablist + 两张大卡(当前现场/成果档案),卡内 strong+small。
  assert.match(app,
    /<nav className="team-task-tabs" aria-label=\{copy\.label\} role="tablist">/);
  assert.match(app, /<strong>当前现场<\/strong><small>\{copy\.currentSmall\}<\/small>/);
  assert.match(app, /<strong>成果档案<\/strong><small>\{copy\.archiveSmall\}<\/small>/);
  // 两域各自的副标题与 aria 标注。
  assert.match(app, /label: "团队需求视图"/);
  assert.match(app, /label: "团队问题视图"/);
  assert.match(app, /哪个问题在推进、谁需要答复/);
  assert.match(app, /闭环结论与取消记录/);
  // 两页都按 current/archive 两面板切换,页签状态共用同一 state。
  assert.match(app, /<TeamWorldTabs domain="requirement" tab=\{teamTaskTab\}/);
  assert.match(app, /<TeamWorldTabs domain="issue" tab=\{teamTaskTab\}/);
});

test("团队问题页:概览+现场在当前面板,队列空态与需求侧同款", () => {
  // 概览:team-delivery-overview 同一套类名;阶段/状态两组格。
  assert.match(issueWorld, /className="team-delivery-overview"/);
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
  // 空态与需求队列同一个 empty-state 视觉(不再用 review-clear 简块)。
  assert.match(issueWorld, /className="empty-state"/);
  assert.match(issueWorld, /className="empty-visual"/);
  assert.doesNotMatch(issueWorld, /review-clear/);
  // 档案措辞:概览说明句与需求侧同构(已取消…仅保留在成果档案)。
  assert.match(issueWorld, /已取消会话仅保留在成果档案/);
});

test("团队问题档案面板镜像 HistoryBoard 骨架,行仍用问题卡", () => {
  // 骨架四件套与需求侧成果档案同款。
  assert.match(issueWorld, /className="history-board"/);
  assert.match(issueWorld, /className="history-intro"/);
  assert.match(issueWorld, /<h2>成果档案·问题闭环<\/h2>/);
  assert.match(issueWorld, /className="history-metrics"/);
  assert.match(issueWorld, /className="board-empty"/);
  assert.match(issueWorld, /conclusion\?\.kind === kind/);
  // 档案列表仍用会话卡(内容差异),不再与现场平铺在同一页。
  const worldBody = issueWorld.split("/** 成果档案·问题闭环")[0];
  assert.doesNotMatch(worldBody, /history-board/,
    "TeamIssueWorld 本体只出概览+现场;档案必须由页签面板 TeamIssueArchive 承载");
  assert.match(issueWorld, /<TeamIssueCard key=\{issue\.id\} issue=\{issue\}/);
  assert.match(app, /<TeamIssueArchive issues=\{teamIssues\} onOpenIssue=\{openIssueSession\} \/>/);
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

test("档案措辞:需求侧「交付档案」统一改为「成果档案」,两域并列", () => {
  assert.match(app, /<strong>成果档案<\/strong>/);
  assert.match(historyBoard, /<h2>成果档案<\/h2>/);
  for (const [name, source] of [["App", app],
    ["HistoryBoard", historyBoard], ["HelpCenter", helpCenter]] as const) {
    assert.doesNotMatch(source, /交付档案/,
      `${name} 里不应再出现旧措辞「交付档案」`);
  }
});
