/**
 * 团队任务页「领域即标题」切换(原型五稿确认后的正式实现)的契约:
 * 切换器存在与标题位接管方式、两域互斥渲染、问题侧交付概览口径纯函数、
 * 档案措辞「成果档案」。纯文本源码锚点(同 issueUiContracts 模式)+
 * teamOps 纯函数直跑(同 teamOps.test.ts 模式)。
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
const switcher = readFileSync(resolve("web/src/TeamDomainSwitch.tsx"), "utf-8");
const issueWorld = readFileSync(
  resolve("web/src/TeamIssueWorld.tsx"), "utf-8");
const historyBoard = readFileSync(
  resolve("web/src/HistoryBoard.tsx"), "utf-8");
const helpCenter = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");

test("领域切换器挂在团队页标题位,原型已退场", () => {
  // 团队页挂正式切换器,原型文件与挂载点都不在了。
  assert.match(app, /<TeamDomainSwitch domain=\{teamDomain\} onSelect=\{selectTeamDomain\}/);
  assert.doesNotMatch(app, /TeamDomainSwitchPrototype/);
  assert.equal(existsSync(resolve("web/src/prototype/TeamDomainSwitch.tsx")),
    false, "原型文件应从本分支删除(五稿提交留在 git 历史)");
  // 弹层两行选项:领域名与统计行都在切换器里。
  assert.match(switcher, /aria-haspopup="listbox"/);
  assert.match(switcher, /"需", "需求交付"/);
  assert.match(switcher, /"问", "问题处理"/);
  // 领域选择持久化:localStorage 键 + App 侧读/写都接上。
  assert.match(switcher, /mae-flow:team-domain/);
  assert.match(switcher, /export function readTeamDomain/);
  assert.match(switcher, /export function persistTeamDomain/);
  assert.match(app, /useState<TeamDomain>\(readTeamDomain\)/);
  assert.match(app, /persistTeamDomain\(next\)/);
});

test("h1 接管必须是隐藏+自有宿主,绝不清空 React 管理的节点(9f926bf 教训)", () => {
  // 安全方式三要素:隐藏 h1、在它后面插入自有宿主、卸载恢复。
  assert.match(switcher, /querySelector<HTMLElement>\("\.workspace-header h1"\)/);
  assert.match(switcher, /h1\.insertAdjacentElement\("afterend", host\)/);
  assert.match(switcher, /h1\.style\.display = "none"/);
  assert.match(switcher, /h1\.style\.display = ""/);
  assert.match(switcher, /host\.remove\(\)/);
  // 红线:不许对 React 管理的节点做 textContent/innerHTML 写操作
  // (曾删掉 h1 的文本子节点,视图切换 commit 时 removeChild 崩页)。
  assert.doesNotMatch(switcher, /textContent\s*=/);
  assert.doesNotMatch(switcher, /innerHTML\s*=/);
});

test("切换器样式守 #146:Tailwind+shadcn,自带 tw-root,不硬编码色值", () => {
  assert.match(switcher, /@\/components\/ui\/popover/);
  assert.match(switcher, /tw-root/);
  // 不新增 legacy css:不 import 任何 css 文件;颜色只出令牌工具类。
  assert.doesNotMatch(switcher, /from "\.[^"]*\.css"/);
  assert.doesNotMatch(switcher, /#[0-9a-fA-F]{6}\b/);
  // 领域色走令牌桥:需求域=ink,问题域=success。
  assert.match(switcher, /bg-ink/);
  assert.match(switcher, /bg-success/);
});

test("两域互斥渲染:问题域整页换成问题世界,需求域原页面原样", () => {
  // App 以 teamDomain 分支:issue → TeamIssueWorld;否则原样渲染
  // 页签导航 + TeamDashboard/HistoryBoard(需求域真实页面)。
  assert.match(app, /teamDomain === "issue"\s*\n\s*\? <TeamIssueWorld issues=\{teamIssues\} onOpenIssue=\{openIssueSession\} \/>/);
  assert.match(app, /<nav className="team-task-tabs"/);
  assert.match(app, /<TeamDashboard/);
  assert.match(app, /<HistoryBoard/);
  // 问题世界不渲染需求域页签(整页换掉,不是叠加)。
  assert.doesNotMatch(issueWorld, /team-task-tabs/);
});

test("问题域页面三段齐备,概览复用需求侧类名体系与既有卡片", () => {
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
  // 档案分区:成果档案·问题闭环(conclusion 维度归档统计)。
  assert.match(issueWorld, /成果档案·问题闭环/);
  assert.match(issueWorld, /conclusion\?\.kind === kind/);
  // 概览格 0 计数置灰禁用与需求侧同规则(disabled 随 count)。
  assert.match(issueWorld, /disabled=\{count === 0\}/);
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
