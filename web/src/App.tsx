/**
 * 管理员默认看团队全局，开发默认直达我的需求；
 * 登录身份决定任务归属与操作权限，任务事实仍来自服务端。
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  createUser, deleteUser, getKnowledgeInsights, getLaunchOptions, getSession, getTask, listMyReviews, listTasks, listUsers,
  login, logout, putCommitter, resetUserPassword,
  type AuthUser, type TaskStatus, type TaskSummary,
  type ReviewRequest, type TeamKnowledgeInsights, type UserRole,
} from "./api";
import { TaskCard } from "./TaskCard";
import { HistoryBoard } from "./HistoryBoard";
import { LaunchWorkspace } from "./LaunchWorkspace";
import { TaskWorkspace } from "./TaskWorkspace";
import { SettingsBoard } from "./SettingsView";
import { GitTokenCard } from "./GitTokenCard";
import { LubanTokenCard } from "./LubanTokenCard";
import {
  getMoonlightPreview,
  putMoonlight,
  putPersonalPushConfirmation,
  putIssueFlowMode,
} from "./api";
import { byUrgency } from "./taskTime";
import {
  byTeamAttention,
  isBlocked,
  isCurrentTeamTask,
  matchesTeamScope,
  responsibleOf,
  type TeamScope,
} from "./teamOps";
import { formatLocalDateTime } from "./time";
import { taskSyncCopy, type TaskSyncState } from "./taskSync";
import {
  launchGateCopy,
  type LaunchGateState,
} from "./launchGate";
import { startVisiblePolling } from "./visiblePolling";
import { KnowledgeFlywheel } from "./KnowledgeFlywheel";
import { WishWall, type WishWallDraft } from "./WishWall";
import { BusinessModuleLibrary } from "./BusinessModuleLibrary";
import { WorkflowAssetWorkspace } from "./workflows";
import {
  knowledgeAssetPath,
  readKnowledgeAssetFocus,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";

// 问题处理页独立分包(懒加载):问题流与需求流互不拖累,改哪边都不
// 用动另一边的构建产物。
const IssueBoard = lazy(() =>
  import("./issues/IssueBoard").then((module) => ({ default: module.IssueBoard })));
// 帮助中心内容多、截图也多，但不是每次进工作台都要用。和问题处理页一样
// 独立加载，不能为了 FAQ 拖慢用户每天打开的首页。
const HelpCenter = lazy(() =>
  import("./HelpCenter").then((module) => ({ default: module.HelpCenter })));

// 两侧各退役一个视图,取并集:"business" 并入团队资产页签(modules,
// 本地);"history" 并入团队任务的档案页签(origin)。
type View = "team" | "mine" | "issues" | "profile" | "users"
  | "settings" | "knowledge" | "wishes" | "help";
type Theme = "light" | "dark";
type Density = "comfortable" | "compact";
type MineScope = "all" | "waiting" | "intervention" | "active" | "delivered";
type TeamTaskTab = "current" | "archive";
type TeamAssetTab = "knowledge" | "modules" | "workflows";

const APP_VIEWS = new Set<View>([
  "team", "mine", "issues", "profile", "users", "settings", "knowledge",
  "wishes", "help",
]);
const TEAM_ASSET_TABS = new Set<TeamAssetTab>([
  "knowledge", "modules", "workflows",
]);

function appHistoryState(view: View, teamAssetTab?: TeamAssetTab) {
  const current = history.state && typeof history.state === "object"
    ? history.state as Record<string, unknown> : {};
  return {
    ...current,
    maeFlowView: view,
    maeFlowTeamAssetTab: teamAssetTab,
  };
}

function viewFromHistoryState(state: unknown): View | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>).maeFlowView;
  return typeof candidate === "string" && APP_VIEWS.has(candidate as View)
    ? candidate as View : undefined;
}

function teamAssetTabFromHistoryState(
  state: unknown,
): TeamAssetTab | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>).maeFlowTeamAssetTab;
  return typeof candidate === "string"
      && TEAM_ASSET_TABS.has(candidate as TeamAssetTab)
    ? candidate as TeamAssetTab : undefined;
}

interface WorkspaceRoute {
  taskId: string;
  reviewId: string;
}

function readWorkspaceRoute(): WorkspaceRoute {
  const match = location.pathname.match(
    /^\/work\/([^/]+)(?:\/review\/([^/]+))?\/?$/,
  );
  if (match) {
    try {
      return {
        taskId: decodeURIComponent(match[1]),
        reviewId: match[2] ? decodeURIComponent(match[2]) : "",
      };
    } catch { return { taskId: "", reviewId: "" }; }
  }
  // 兼容此前已经发送的根路径查询参数通知，进入后会规范成 /work/...。
  const params = new URLSearchParams(location.search);
  return {
    taskId: params.get("task")?.trim() ?? "",
    reviewId: params.get("review")?.trim() ?? "",
  };
}

function workspacePath(taskId: string, reviewId = ""): string {
  return `/work/${encodeURIComponent(taskId)}`
    + (reviewId ? `/review/${encodeURIComponent(reviewId)}` : "");
}

function initialView(user: AuthUser): View {
  if (/^\/help(?:\/|$)/.test(location.pathname)) return "help";
  if (readKnowledgeAssetFocus()) return "knowledge";
  // 管理员没有"我的待办"(不下单的角色没有个人任务收件箱,用户拍板):
  // 深链也一律落到团队总览,从那里打开任意任务行使兜底控制。
  if (user.role === "admin") return "team";
  if (readWorkspaceRoute().reviewId) return "mine";
  return "mine";
}

/** 人工介入程度(用户拍板:一个旋钮说清,不做任务粒度设置)。
 * 两个正交轴合成四档:月光管"过程节点停不停",push 前确认管
 * "交付清单出门前给不给人过目"。月光转开仍走预览/是否处理当前
 * 待办的既有流程;push 默认开,只落显式的关。 */
const INTERVENTION_PRESETS = [
  { key: "full", moonlight: false, push: true, title: "全程把关",
    hint: "过程节点等你拍板,验证后确认最终交付范围（默认）" },
  { key: "process", moonlight: false, push: false, title: "逐步确认",
    hint: "过程节点等你拍板,交付信任三道门禁" },
  { key: "delivery", moonlight: true, push: true, title: "只看交付",
    hint: "过程自动放行,验证后确认最终交付范围" },
  { key: "auto", moonlight: true, push: false, title: "全自动",
    hint: "不中断执行,完成后统一复盘" },
] as const;

function InterventionSetting({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (patch: Partial<AuthUser>) => Promise<void>;
}) {
  const [moon, setMoon] = useState(!!session.moonlight);
  const [push, setPush] = useState(session.push_confirmation !== false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const current = INTERVENTION_PRESETS
    .find((preset) => preset.moonlight === moon && preset.push === push)!;
  async function select(preset: typeof INTERVENTION_PRESETS[number]) {
    if (busy || preset.key === current.key) return;
    setBusy(true);
    try {
      const notes: string[] = [];
      let nextMoon = moon;
      let nextPush = push;
      if (preset.moonlight !== moon) {
        let includeCurrent = false;
        let expectedEligible: number | undefined;
        if (preset.moonlight) {
          const preview = await getMoonlightPreview();
          expectedEligible = preview.eligible;
          if (preview.eligible > 0) {
            includeCurrent = window.confirm(
              `过程自动放行默认仅对后续节点生效。\n\n当前有 ${preview.eligible} 项可自动处理`
              + (preview.blocked_annotations > 0
                ? `，另有 ${preview.blocked_annotations} 项因存在检视意见不会自动放行` : "")
              + "。\n\n选择“确定”同时处理当前待办；选择“取消”仅对后续节点生效。",
            );
          }
        }
        const result = await putMoonlight(
          preset.moonlight, includeCurrent, expectedEligible);
        nextMoon = result.moonlight;
        setMoon(result.moonlight);
        notes.push(result.moonlight
          ? (result.swept > 0
              ? `过程节点已自动放行，并处理 ${result.swept} 项当前待办`
              : result.blocked_annotations > 0
                ? `过程节点对后续生效；${result.blocked_annotations} 项含检视意见的待办仍需人工处理`
                : "过程节点对后续生效，当前待办保持不变")
          : "过程节点恢复等你拍板");
      }
      if (preset.push !== push) {
        const user = await putPersonalPushConfirmation(preset.push);
        nextPush = user.push_confirmation !== false;
        setPush(nextPush);
        notes.push(nextPush
          ? "后续任务会在 Build-Fix 完成后展示最终交付范围"
          : "后续任务推送不再等待清单确认；已在等确认的任务点一下确认即可");
      }
      setNote(notes.join("；"));
      await onChanged({ moonlight: nextMoon, push_confirmation: nextPush });
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className={`approval-setting${moon ? " is-auto" : ""}`} aria-labelledby="approval-setting-title">
    <header className="approval-setting-head">
      <span className="approval-setting-icon" aria-hidden><svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg></span>
      <div><span className="section-kicker">HUMAN INTERVENTION</span><h2 id="approval-setting-title">人工介入程度</h2></div>
      <span className="approval-setting-state">当前：{current.title}</span>
    </header>
    <p className="approval-setting-summary">一处设定,所有任务生效:过程节点(需求澄清、方案确认)停不停,Build-Fix 完成后是否确认最终交付范围。纯自动修复留在已确认文件范围内时不会重复询问；人工检视意见引发的修改一定回到意见作者复检。流水线绑 SHA、MR 人工合入等门禁始终生效。</p>
    <div className="approval-options" role="group" aria-label="人工介入程度">
      {INTERVENTION_PRESETS.map((preset) => <button type="button" key={preset.key}
        className={current.key === preset.key ? "on" : ""} disabled={busy}
        onClick={() => void select(preset)}>
        <i aria-hidden>{preset.moonlight
          ? <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg>
          : "✓"}</i>
        <span><strong>{preset.title}</strong><small>{preset.hint}</small></span>
      </button>)}
    </div>
    {note && <p className="approval-setting-note" role="status">{note}</p>}
  </section>;
}

function ThemeSwitch({ theme, onChange }: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const light = theme === "light";
  return <button type="button" className={`theme-switch${light ? " is-light" : ""}`}
    onClick={() => onChange(light ? "dark" : "light")}
    title={light ? "切换到深夜主题" : "切换到云昼主题"}
    aria-label={light ? "当前为云昼主题，切换到深夜主题" : "当前为深夜主题，切换到云昼主题"}>
    <span className="theme-switch-icon" aria-hidden>
      {light
        ? <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.2" /><path d="M10 2.2v1.5M10 16.3v1.5M2.2 10h1.5M16.3 10h1.5M4.5 4.5l1 1M14.5 14.5l1 1M4.5 15.5l1-1M14.5 5.5l1-1" /></svg>
        : <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg>}
    </span>
    <span className="theme-switch-copy"><strong>{light ? "云昼主题" : "深夜主题"}</strong><small>{light ? "明亮 · 柔和" : "沉浸 · 专注"}</small></span>
    <span className="theme-switch-track" aria-hidden><i /></span>
  </button>;
}

function DensitySwitch({ density, onChange }: {
  density: Density;
  onChange: (density: Density) => void;
}) {
  const compact = density === "compact";
  return <button type="button" className="density-switch"
    onClick={() => onChange(compact ? "comfortable" : "compact")}
    title={compact ? "切换到舒适密度" : "切换到紧凑密度"}
    aria-label={compact ? "当前为紧凑密度，切换到舒适密度" : "当前为舒适密度，切换到紧凑密度"}>
    <span className="density-switch-icon" aria-hidden>
      <svg viewBox="0 0 20 20"><path d={compact ? "M4 5.5h12M4 10h12M4 14.5h12" : "M4 4.5h12M4 10h12M4 15.5h12"} /></svg>
    </span>
    <span className="density-switch-copy"><strong>{compact ? "紧凑密度" : "舒适密度"}</strong><small>{compact ? "适合高信息量浏览" : "更易读的默认字号"}</small></span>
  </button>;
}

function TaskSyncIndicator({
  state,
  onRetry,
}: {
  state: TaskSyncState;
  onRetry: () => Promise<void>;
}) {
  const copy = taskSyncCopy(state);
  const title = state.kind === "error"
    ? state.detail
    : state.last_success_at
      ? `最近同步：${formatLocalDateTime(state.last_success_at, { seconds: true })}`
      : copy.detail;
  const body = <>
    <i aria-hidden />
    <span><strong>{copy.title}</strong><small>{copy.detail}</small></span>
    {copy.retry && <svg viewBox="0 0 18 18" aria-hidden>
      <path d="M14.5 6.5A5.75 5.75 0 1 0 15 11M14.5 3v3.5H11" />
    </svg>}
  </>;
  return copy.retry ? (
    <button type="button" className="task-sync error" title={title}
      onClick={() => void onRetry()}>{body}</button>
  ) : (
    <span className={`task-sync ${state.kind}`} title={title}>{body}</span>
  );
}

/** 问题处理探索方式(2026-08-27 拍板):固定流程=平台按阶段状态机
 * 推进、工具按阶段开放;自由探索=AI 按 playbook 自主编排。缺省固定
 * 流程;只烙印新会话——进行中的会话不迁移,自由路径从未删掉,随时
 * 一键切回。 */
function IssueFlowModeSetting({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (patch: Partial<AuthUser>) => void;
}) {
  const [mode, setMode] = useState<"fixed" | "free">(
    session.issue_flow === "free" ? "free" : "fixed");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function select(next: "fixed" | "free") {
    if (busy || next === mode) return;
    setBusy(true);
    try {
      const user = await putIssueFlowMode(next);
      setMode(user.issue_flow === "free" ? "free" : "fixed");
      setNote(next === "fixed"
        ? "新发起的问题处理将按固定流程推进(七阶段/三节点,平台把关)"
        : "新发起的问题处理改为自由探索(AI 按 playbook 自主编排);进行中的会话不受影响");
      onChanged({ issue_flow: user.issue_flow });
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className="issue-flow-mode-setting" aria-labelledby="issue-flow-mode-title">
    <header className="approval-setting-head">
      <span className="approval-setting-icon" aria-hidden><svg viewBox="0 0 20 20"><path d="M4.5 15.5 8 9l3 3.5L14.5 5l2 4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg></span>
      <div><span className="section-kicker">ISSUE EXPLORATION</span><h2 id="issue-flow-mode-title">问题处理探索方式</h2></div>
      <span className="approval-setting-state">当前：{mode === "fixed" ? "固定流程" : "自由探索"}</span>
    </header>
    <p className="approval-setting-summary">只影响新发起的问题处理:固定流程按阶段状态机推进(有单七阶段、无单三节点,两个节点停下等你确认);自由探索交给 AI 按 playbook 自主编排。进行中的会话不受切换影响。</p>
    <div className="approval-options" role="group" aria-label="问题处理探索方式">
      <button type="button" className={mode === "fixed" ? "on" : ""} disabled={busy}
        onClick={() => void select("fixed")}>
        <strong>固定流程</strong><small>阶段固定、工具按阶段开放;报告确认与环境验证两处等你拍板(默认)</small>
      </button>
      <button type="button" className={mode === "free" ? "on" : ""} disabled={busy}
        onClick={() => void select("free")}>
        <strong>自由探索</strong><small>AI 自主决定研究路线,阶段自行上报;保留给需要灵活排查的场景</small>
      </button>
    </div>
    {note ? <p className="approval-setting-note" role="status">{note}</p> : null}
  </section>;
}

function PersonalSettingsPage({
  session,
  onSessionPatch,
  onTasksChanged,
}: {
  session: AuthUser;
  onSessionPatch: (patch: Partial<AuthUser>) => void;
  onTasksChanged: () => Promise<void>;
}) {
  return <div className="personal-settings-page">
    <InterventionSetting session={session} onChanged={async (patch) => {
      onSessionPatch(patch);
      await onTasksChanged();
    }} />
    <IssueFlowModeSetting session={session} onChanged={onSessionPatch} />
    <section className="personal-connections" aria-labelledby="personal-connections-title">
      <div className="personal-connections-head">
        <div><span className="section-kicker">PERSONAL CONNECTIONS</span><h2 id="personal-connections-title">个人接入</h2></div>
        <p>配置一次，后续任务自动使用你的代码身份和消息通知。</p>
      </div>
      <div className="credential-grid">
        <GitTokenCard session={session} onChanged={onSessionPatch} />
        <LubanTokenCard session={session} onChanged={onSessionPatch} />
      </div>
    </section>
  </div>;
}

function NavIcon({ name }: { name: View }) {
  if (name === "team") return <svg viewBox="0 0 24 24" aria-hidden><path d="M4.75 19.25V11.5h4v7.75h-4Zm5.75 0V4.75h4v14.5h-4Zm5.75 0V8h4v11.25h-4Z" /></svg>;
  if (name === "mine") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="8" r="3.25" /><path d="M5.5 19.25c.65-3.45 2.82-5.25 6.5-5.25s5.85 1.8 6.5 5.25" /></svg>;
  if (name === "issues") return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4.75 20 18.5H4L12 4.75Z" /><path d="M12 10v4M12 16.4v.2" /></svg>;
  if (name === "profile") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75" /><circle cx="17.5" cy="15.5" r="2.25" /><path d="M17.5 11.75v1.5M17.5 17.75v1.5M13.75 15.5h1.5M19.75 15.5h1.5" /></svg>;
  if (name === "wishes") return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 20.25s-7.25-4.1-7.25-10.1A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 7.25 3.35c0 6-7.25 10.1-7.25 10.1Z" /><path d="m17.5 3.75.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45.45-1.3Z" /></svg>;
  if (name === "users") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75M16.5 7.5h4M18.5 5.5v4" /></svg>;
  if (name === "settings") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4" /></svg>;
  if (name === "help") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8.25" /><path d="M9.7 9.1a2.5 2.5 0 0 1 4.8.9c0 1.8-2.5 2-2.5 3.7M12 17.3v.15" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4.75h14A1.25 1.25 0 0 1 20.25 6v12A1.25 1.25 0 0 1 19 19.25H5A1.25 1.25 0 0 1 3.75 18V6A1.25 1.25 0 0 1 5 4.75Z" /><path d="M8 9h8M8 13h5" /></svg>;
}

// MR 绿灯/待合入仍是活动任务：它继续监听门禁、流水线和人工检视。
// 只有真正合入后的 completed 才进入“已交付”。
const DELIVERED_STATUSES: TaskStatus[] = ["completed"];

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [density, setDensity] = useState<Density>(() =>
    document.documentElement.dataset.density === "compact" ? "compact" : "comfortable");
  const [session, setSession] = useState<AuthUser | null>();
  const [view, setView] = useState<View>("team");
  const [mineScope, setMineScope] = useState<MineScope>("all");
  const [teamTaskTab, setTeamTaskTab] = useState<TeamTaskTab>("current");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [teamUsers, setTeamUsers] = useState<AuthUser[]>([]);
  const [knowledgeInsights, setKnowledgeInsights] = useState<TeamKnowledgeInsights>();
  const [knowledgeInsightsLoading, setKnowledgeInsightsLoading] = useState(false);
  const [knowledgeInsightsError, setKnowledgeInsightsError] = useState("");
  const [teamAssetTab, setTeamAssetTab] = useState<TeamAssetTab>(() =>
    readKnowledgeAssetFocus()?.kind === "business" ? "modules" : "knowledge");
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeAssetFocus | undefined>(
    readKnowledgeAssetFocus,
  );
  /** 下单选择器"查看方案"带过来的直达目标;资产库挂载时消费。 */
  const [workflowFocusId, setWorkflowFocusId] = useState("");
  const [helpArticleId, setHelpArticleId] = useState(() => {
    const match = location.pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
    if (!match?.[1]) return "getting-started";
    try { return decodeURIComponent(match[1]); }
    catch { return "getting-started"; }
  });
  const [myReviews, setMyReviews] = useState<ReviewRequest[]>([]);
  const [artifactTaskId, setArtifactTaskId] = useState("");
  const [artifactTaskSnapshot, setArtifactTaskSnapshot] = useState<TaskSummary>();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [wishDraft, setWishDraft] = useState<WishWallDraft>();
  const [launchGate, setLaunchGate] = useState<LaunchGateState>({ kind: "checking" });
  const launchGateRequest = useRef(0);
  const [taskSync, setTaskSync] = useState<TaskSyncState>({ kind: "loading" });
  /** 深链指向的任务已不存在时的提示(空串=无提示)。 */
  const [missingTaskNotice, setMissingTaskNotice] = useState("");
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined);
  const [targetRoute, setTargetRoute] = useState(readWorkspaceRoute);
  const targetTaskId = targetRoute.taskId;
  const targetReviewId = targetRoute.reviewId;

  useEffect(() => {
    const syncRoute = () => {
      const next = readWorkspaceRoute();
      setTargetRoute(next);
      if (!next.taskId) {
        setArtifactTaskId("");
        setArtifactTaskSnapshot(undefined);
      }
    };
    addEventListener("popstate", syncRoute);
    return () => removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    const syncKnowledgeRoute = (event: PopStateEvent) => {
      const focus = readKnowledgeAssetFocus();
      setKnowledgeFocus(focus);
      if (!focus) {
        const restoredView = viewFromHistoryState(event.state);
        const restoredTab = teamAssetTabFromHistoryState(event.state);
        if (restoredView) setView(restoredView);
        if (restoredTab) setTeamAssetTab(restoredTab);
        return;
      }
      setTeamAssetTab(focus.kind === "business" ? "modules" : "knowledge");
      setView("knowledge");
    };
    addEventListener("popstate", syncKnowledgeRoute);
    return () => removeEventListener("popstate", syncKnowledgeRoute);
  }, []);

  // FAQ 支持把具体文章链接直接发给别人；浏览器前进/后退也要真的切页，
  // 不能只改地址栏。离开 /help 后回到该角色的默认首页。
  useEffect(() => {
    if (!session) return;
    const syncHelpRoute = () => {
      const match = location.pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
      if (match) {
        let articleId = "getting-started";
        try { articleId = match[1] ? decodeURIComponent(match[1]) : articleId; }
        catch { /* 坏地址由帮助中心回到第一篇 */ }
        setHelpArticleId(articleId);
        setView("help");
      } else {
        setView((current) => current === "help" ? initialView(session) : current);
      }
    };
    addEventListener("popstate", syncHelpRoute);
    return () => removeEventListener("popstate", syncHelpRoute);
  }, [session?.username, session?.role]);

  useEffect(() => {
    void getSession().then((user) => {
      setSession(user);
      if (user) setView(initialView(user));
    }).catch(() => setSession(null));
  }, []);

  function refreshLaunchGate(showChecking = true): Promise<void> {
    const account = session;
    if (!account || account.role === "admin") return Promise.resolve();
    const request = ++launchGateRequest.current;
    if (showChecking) setLaunchGate({ kind: "checking" });
    return getLaunchOptions().then((options) => {
      if (launchGateRequest.current !== request) return;
      setLaunchGate(options.blockers.length > 0
        ? { kind: "blocked", blockers: options.blockers }
        : { kind: "ready" });
    }).catch((cause) => {
      if (launchGateRequest.current !== request) return;
      setLaunchGate({
        kind: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  // 发起条件必须以服务端为准：部署形态决定是否需要 Git / 小鲁班，
  // 管理员配置也可能热更新。个人设置保存后 session hint 改变，会立即
  // 复查；不能再靠前端硬编码几个字段猜测。
  useEffect(() => {
    if (!session || session.role === "admin") return;
    void refreshLaunchGate(true);
  }, [
    session?.username,
    session?.role,
    session?.git_token_hint,
    session?.git_email,
    session?.luban_token_hint,
  ]);

  function refresh(): Promise<void> {
    if (refreshInFlight.current) return refreshInFlight.current;
    // 等人的排最前、等最久的第一:这块屏幕先回答"谁在等我"。
    setTaskSync((current) => current.kind === "error"
      ? { kind: "loading", last_success_at: current.last_success_at }
      : current);
    const running = (async () => {
      try {
        const [nextTasks, reviews] = await Promise.all([listTasks(), listMyReviews()]);
        setTasks(nextTasks.sort(byUrgency));
        setMyReviews(reviews);
        setTaskSync({ kind: "live", last_success_at: new Date().toISOString() });
      } catch (cause) {
        // 网络抖动不能把用户踢回登录页；只有 /auth/me 明确返回未登录才退出。
        let current: AuthUser | null | undefined;
        try { current = await getSession(); } catch { current = undefined; }
        if (current === null) {
          setSession(null);
          return;
        }
        setTaskSync((previous) => ({
          kind: "error",
          last_success_at: previous.last_success_at,
          detail: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    })();
    refreshInFlight.current = running;
    void running.finally(() => {
      if (refreshInFlight.current === running) refreshInFlight.current = undefined;
    });
    return running;
  }

  useEffect(() => {
    if (!session) return;
    setTaskSync({ kind: "loading" });
    return startVisiblePolling(() => void refresh(), 1500, document);
  }, [session?.username]);

  useEffect(() => {
    if (session?.role !== "admin" || view !== "team") return;
    void listUsers().then(setTeamUsers).catch(() => setTeamUsers([]));
  }, [session?.username, session?.role, view]);

  function refreshKnowledgeInsights(): void {
    setKnowledgeInsightsLoading(true);
    setKnowledgeInsightsError("");
    void getKnowledgeInsights().then(setKnowledgeInsights).catch((cause) => {
      setKnowledgeInsightsError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => setKnowledgeInsightsLoading(false));
  }

  // 知识聚合要读取多份任务足迹，独立低频刷新，不能跟 1.5 秒任务心跳
  // 绑在一起。开发成员也能看团队只读视图，和现有任务可见性一致。
  useEffect(() => {
    if (!session || view !== "knowledge" || teamAssetTab !== "knowledge") return;
    refreshKnowledgeInsights();
    const timer = window.setInterval(refreshKnowledgeInsights, 60_000);
    return () => window.clearInterval(timer);
  }, [session?.username, view, teamAssetTab]);

  useEffect(() => {
    if (view !== "mine" || !targetTaskId || tasks.length === 0) return;
    const timer = window.setTimeout(() => document.getElementById(`task-${targetTaskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    return () => clearTimeout(timer);
  }, [view, targetTaskId, tasks.length]);

  // 通知/复制链接进入时直接打开指定任务工作台。Committer 不要求任务
  // 归属本人；能否操作仍由服务端和 canOperate 决定，URL 不授予权限。
  useEffect(() => {
    if (!targetTaskId || artifactTaskId === targetTaskId || tasks.length === 0) return;
    const target = tasks.find((task) => task.id === targetTaskId);
    if (!target) {
      // 深链指向的任务不在列表里(已删除/链接过期):静默返回的话页面
      // 停在普通"我的工作",人只会怀疑自己点错或系统坏了(2026-08-30
      // 审计)。说破并把 URL 收回根路径。
      setMissingTaskNotice(targetTaskId);
      setTargetRoute({ taskId: "", reviewId: "" });
      history.replaceState({}, "", "/");
      return;
    }
    setArtifactTaskSnapshot(target);
    setArtifactTaskId(target.id);
    const canonical = workspacePath(targetTaskId, targetReviewId);
    if (location.pathname + location.search !== canonical) {
      history.replaceState({}, "", canonical);
    }
  }, [targetReviewId, targetTaskId, tasks, artifactTaskId]);

  // 打开的工作台必须跨轮询稳定存在。任务在状态切换时可能有一拍没出现在
  // 列表响应里；若直接用 tasks.find 渲染,组件会被卸载再挂载,表现为
  // “一点专注审阅就闪退”,同时丢掉当前文件和展开状态。
  useEffect(() => {
    if (!artifactTaskId) return;
    const latest = tasks.find((task) => task.id === artifactTaskId);
    if (latest) setArtifactTaskSnapshot((current) => current?.id === latest.id
      ? {
          ...current,
          ...latest,
          knowledge_usage: current.knowledge_usage,
        }
      : latest);
  }, [tasks, artifactTaskId]);

  // 列表轮询保持轻量；只有真正打开工作台时才读取知识足迹和完整收据。
  useEffect(() => {
    if (!artifactTaskId) return;
    let alive = true;
    void getTask(artifactTaskId).then((detail) => {
      if (alive) setArtifactTaskSnapshot(detail);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [artifactTaskId]);

  const assignedToMe = session
    ? tasks.filter((task) => responsibleOf(task) === session.username)
    : [];
  // 管理员不再有个人待办:归属人=下单人是硬规则,无主任务只可能来自
  // 无鉴权的老现场,团队总览里照常可见、可打开兜底处置。

  // 视图打标:问题处理(issues)用淡红主题,与需求流的淡紫视觉分区
  // (body 级 data-view,CSS 变量作用域覆盖,见 style.css 尾部)。
  useEffect(() => {
    document.body.dataset.view = view;
    return () => { delete document.body.dataset.view; };
  }, [view]);

  if (session === undefined) return <LoadingScreen />;
  if (session === null) return <LoginScreen onAuthenticated={(user) => {
    launchGateRequest.current += 1;
    setLaunchGate({ kind: "checking" });
    setSession(user); setMineScope("all");
    setView(initialView(user));
  }} />;

  async function signOut() {
    await logout().catch(() => undefined);
    setTasks([]);
    setKnowledgeInsights(undefined);
    setKnowledgeInsightsError("");
    setMineScope("all");
    setTaskSync({ kind: "loading" });
    launchGateRequest.current += 1;
    setLaunchGate({ kind: "checking" });
    setSession(null);
  }

  function changeTheme(next: Theme) {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem("mae-flow-theme", next); } catch { /* 仍保留本次选择 */ }
  }

  function changeDensity(next: Density) {
    document.documentElement.dataset.density = next;
    setDensity(next);
    try { localStorage.setItem("mae-flow-density", next); } catch { /* 仍保留本次选择 */ }
  }

  function patchSession(patch: Partial<AuthUser>) {
    setSession((current) => current ? { ...current, ...patch } : current);
  }

  const waitingCount = tasks.filter((task) => task.status === "waiting_for_human").length;
  const myTasks = assignedToMe;
  const myWaiting = myTasks.filter((task) => task.status === "waiting_for_human");
  const pendingReviews = myReviews.filter((review) => review.status === "pending");
  const myBlocked = myTasks.filter((task) =>
    task.status !== "waiting_for_human" && isBlocked(task));
  const myPaused = myTasks.filter((task) => task.status === "paused");
  const myIntervention = [...new Map(
    [...myBlocked, ...myPaused].map((task) => [task.id, task]),
  ).values()].sort(byTeamAttention);
  const myActive = myTasks.filter((task) =>
    task.status !== "waiting_for_human" && !isBlocked(task)
    && task.status !== "paused" && task.status !== "canceled"
    && !DELIVERED_STATUSES.includes(task.status));
  const myCurrent = myTasks.filter((task) =>
    task.status !== "canceled" && !DELIVERED_STATUSES.includes(task.status))
    .sort(byTeamAttention);
  const myDelivered = myTasks.filter((task) =>
    DELIVERED_STATUSES.includes(task.status));
  const scopedMyWork = mineScope === "waiting" ? myWaiting
    : mineScope === "intervention" ? myIntervention
      : mineScope === "active" ? myActive
        : mineScope === "delivered" ? myDelivered : myCurrent;
  const visibleMyWork = scopedMyWork;
  const myWorkTitle = mineScope === "waiting" ? "待我核对"
    : mineScope === "intervention" ? "需要介入 / 已暂停"
      : mineScope === "active" ? "自动推进中"
        : mineScope === "delivered" ? "等待合入与最近完成" : "当前任务";
  const artifactTask = artifactTaskId
    ? artifactTaskSnapshot?.id === artifactTaskId
      ? artifactTaskSnapshot
      : tasks.find((task) => task.id === artifactTaskId)
    : undefined;
  const openArtifacts = (task: TaskSummary) => {
    setArtifactTaskSnapshot(task);
    setArtifactTaskId(task.id);
    const next = workspacePath(task.id);
    if (location.pathname + location.search !== next) {
      history.pushState({}, "", next);
      setTargetRoute({ taskId: task.id, reviewId: "" });
    }
  };
  const closeArtifacts = () => {
    setArtifactTaskId("");
    setArtifactTaskSnapshot(undefined);
    history.replaceState({}, "", "/");
    setTargetRoute({ taskId: "", reviewId: "" });
  };
  // 谁能提交决定:管理员或任务归属人。工作台与列表共用这一个口径。
  const canOperate = (task: TaskSummary) =>
    session.role === "admin" || responsibleOf(task) === session.username;
  const canCollaborate = (task: TaskSummary) => canOperate(task)
    || (task.requirement_graph?.stage === "analysis"
      && (task.collaborators?.includes(session.username) === true
        || task.requirement_graph.repositories.some((repository) =>
          repository.assignee === session.username)));
  const header = {
    team: { title: "团队任务", description: teamTaskTab === "current"
      ? (session.role === "admin"
        ? "查看团队当前推进、负责人和阻塞风险；需要时进入任务工作台兜底。"
        : "了解团队此刻正在推进什么；你的操作仍留在个人工作台。")
      : "回看已经形成结果的交付档案、MR 和事件记录。" },
    mine: { title: "我的需求", description: "从发起到交付，集中推进你的每一项需求任务。" },
    issues: { title: "问题处理", description: "我的问题研究与 DTS 问题单处理：先定位，后补单，非问题也是合法结论。" },
    profile: { title: "个人设置", description: "集中管理任务审批方式、CodeHub 提交身份和小鲁班通知。" },
    knowledge: { title: "团队资产", description: "管理团队通用知识、业务模块和工作流；代码仓内容始终由 Git 管理。" },
    wishes: { title: "许愿墙", description: "汇聚真实诉求和使用问题；每一个声音都应该被看见、被回应、被闭环。" },
    users: { title: "账号管理", description: "创建本地账号并分配管理员或开发权限。" },
    settings: { title: "服务设置", description: "集中管理模型网关和团队运行策略；部署链路在此只读自检。" },
    help: { title: "使用帮助", description: "用大白话讲清每个功能：什么时候用、点哪里、接下来会发生什么。" },
  }[view];
  const relevantWaiting = view === "mine"
    ? myWaiting.length + pendingReviews.length
    : view === "team" && teamTaskTab === "current" ? waitingCount : 0;
  const launchEntry = launchGateCopy(launchGate);
  const selectView = (next: View) => {
    const leavingKnowledgeFocus = readKnowledgeAssetFocus();
    if (leavingKnowledgeFocus) setKnowledgeFocus(undefined);
    if (next === "help") {
      const nextPath = `/help/${encodeURIComponent(helpArticleId)}`;
      if (location.pathname !== nextPath) {
        history.replaceState(appHistoryState(view,
          view === "knowledge" ? teamAssetTab : undefined), "",
          location.pathname + location.search);
        history.pushState(appHistoryState("help"), "", nextPath);
      }
    } else if (/^\/help(?:\/|$)/.test(location.pathname)) {
      history.pushState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined), "", "/");
    } else if (leavingKnowledgeFocus) {
      history.pushState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined), "", "/");
    } else if (location.pathname === "/") {
      history.replaceState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined), "",
        location.pathname + location.search);
    }
    setView(next);
  };
  const selectTeamAssetTab = (next: TeamAssetTab) => {
    setTeamAssetTab(next);
    if (!knowledgeFocus) {
      if (location.pathname === "/") {
        history.replaceState(appHistoryState("knowledge", next), "",
          location.pathname + location.search);
      }
      return;
    }
    setKnowledgeFocus(undefined);
    history.pushState(appHistoryState("knowledge", next), "", "/");
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><span className="brand-symbol" aria-hidden><svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg></span><span className="brand-copy"><strong>Mae-Flow</strong><small>{session.role === "admin" ? "Management Console" : "Developer Workspace"}</small></span></div>
      <nav className="sidebar-nav" aria-label="视图切换">
        {session.role === "admin" ? <>
          <span className="nav-section-label">管理视角</span>
          <NavButton view="team" current={view} onSelect={selectView} label="团队任务" badge={waitingCount} />
          <NavButton view="wishes" current={view} onSelect={selectView} label="许愿墙" />
          <NavButton view="knowledge" current={view} onSelect={selectView} label="团队资产" />
          <span className="nav-section-label admin-tools">系统管理</span>
          <NavButton view="users" current={view} onSelect={selectView} label="账号管理" />
          <NavButton view="settings" current={view} onSelect={selectView} label="服务设置" />
        </> : <>
          <span className="nav-section-label">个人工作台</span>
          <NavButton view="mine" current={view} onSelect={selectView} label="我的需求" badge={myWaiting.length + pendingReviews.length} personal />
          <NavButton view="issues" current={view} onSelect={selectView} label="问题处理" />
          <NavButton view="profile" current={view} onSelect={selectView} label="个人设置" />
          <span className="nav-section-label team-context">团队信息</span>
          <NavButton view="team" current={view} onSelect={selectView} label="团队任务" badge={waitingCount} />
          <NavButton view="wishes" current={view} onSelect={selectView} label="许愿墙" />
          <NavButton view="knowledge" current={view} onSelect={selectView} label="团队资产" />
        </>}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-help-entry">
          <NavButton view="help" current={view} onSelect={selectView} label="使用帮助" />
        </div>
        <DensitySwitch density={density} onChange={changeDensity} />
        <ThemeSwitch theme={theme} onChange={changeTheme} />
        <div className="sidebar-foot session-foot"><span className="account-avatar" aria-hidden>{session.username.slice(0, 1).toUpperCase()}</span><span className="sidebar-account"><strong>{session.username}</strong><small>{session.role === "admin" ? "管理员" : "开发成员"}</small></span><button type="button" className="logout-button" onClick={signOut} title="退出登录" aria-label="退出登录"><svg viewBox="0 0 20 20"><path d="M8 4H4.75A1.25 1.25 0 0 0 3.5 5.25v9.5A1.25 1.25 0 0 0 4.75 16H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" /></svg></button></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="workspace-header"><div><div className="eyebrow">MAE-FLOW CLOUD</div><h1>{header.title}</h1><p className={view === "mine" ? "header-context-line" : undefined}>{view === "mine" && <span className="header-user-context">{session.username}</span>}<span>{header.description}</span></p></div><div className="workspace-header-actions">{view !== "wishes" && view !== "help" && <TaskSyncIndicator state={taskSync} onRetry={refresh} />}{relevantWaiting > 0 && view !== "users" && view !== "settings" && <div className="header-attention"><span className="attention-pulse" aria-hidden /><span><strong>{relevantWaiting}</strong>{view === "mine" ? " 项需要我处理" : " 项工作等待决策"}</span></div>}{view === "mine" && session.role !== "admin" && <div className="header-launch-gate"><button type="button" className={`header-launch${launchEntry.enabled ? "" : " is-blocked"}`} title={launchEntry.title} aria-label={launchEntry.ariaLabel} onClick={() => setLaunchOpen(true)}><svg viewBox="0 0 20 20" aria-hidden>{launchEntry.enabled ? <path d="M10 4v12M4 10h12" /> : <><rect x="5" y="8.5" width="10" height="8" rx="1.5" /><path d="M7.5 8.5V6.75a2.5 2.5 0 0 1 5 0V8.5" /></>}</svg><span>发起新任务</span></button>{launchEntry.helper && (launchEntry.action ? <button type="button" className="header-unlock" title={launchEntry.title} onClick={() => launchEntry.action === "profile" ? setView("profile") : void refreshLaunchGate(true)}>{launchEntry.helper}<svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg></button> : <span className="header-unlock is-status" title={launchEntry.title}>{launchEntry.helper}</span>)}</div>}</div></header>
      <main className="workspace-main">
        {view === "team" && <section className="team-tasks-workspace">
          <nav className="team-task-tabs" aria-label="团队任务视图" role="tablist">
            <button type="button" role="tab" id="team-task-current-tab"
              aria-controls="team-task-current-panel"
              aria-selected={teamTaskTab === "current"}
              className={teamTaskTab === "current" ? "active" : ""}
              onClick={() => setTeamTaskTab("current")}>
              <strong>当前现场</strong><small>谁在推进、哪里卡住、谁需要行动</small>
            </button>
            <button type="button" role="tab" id="team-task-archive-tab"
              aria-controls="team-task-archive-panel"
              aria-selected={teamTaskTab === "archive"}
              className={teamTaskTab === "archive" ? "active" : ""}
              onClick={() => setTeamTaskTab("archive")}>
              <strong>交付档案</strong><small>待合入、完成、失败与取消记录</small>
            </button>
          </nav>
          {teamTaskTab === "current" ? <div role="tabpanel"
            id="team-task-current-panel" aria-labelledby="team-task-current-tab">
            <TeamDashboard
              tasks={tasks}
              users={teamUsers}
              onChanged={refresh}
              onOpenArtifacts={openArtifacts}
            />
          </div> : <div role="tabpanel"
            id="team-task-archive-panel" aria-labelledby="team-task-archive-tab">
            <HistoryBoard
              tasks={tasks}
              viewer={session}
              onChanged={refresh}
              onOpenTask={openArtifacts}
            />
          </div>}
        </section>}

        {view === "knowledge" && <section className="team-assets-workspace">
          <nav className="team-assets-tabs" aria-label="团队资产类型">
            <button type="button" className={teamAssetTab === "knowledge" ? "active" : ""}
              aria-pressed={teamAssetTab === "knowledge"}
              onClick={() => selectTeamAssetTab("knowledge")}>
              <strong>知识资产</strong><small>团队通用知识及全部资产的真实使用效果</small>
            </button>
            <button type="button" className={teamAssetTab === "modules" ? "active" : ""}
              aria-pressed={teamAssetTab === "modules"}
              onClick={() => selectTeamAssetTab("modules")}>
              <strong>业务模块</strong><small>模块是抽屉，集中维护业务语义和模块知识</small>
            </button>
            <button type="button" className={teamAssetTab === "workflows" ? "active" : ""}
              aria-pressed={teamAssetTab === "workflows"}
              onClick={() => selectTeamAssetTab("workflows")}>
              <strong>工作流方案</strong><small>保存、复制、审核并精确编排阶段内能力</small>
            </button>
          </nav>
          {teamAssetTab === "knowledge" ? <KnowledgeFlywheel
            admin={session.role === "admin"}
            initialAsset={knowledgeFocus}
            insights={knowledgeInsights}
            loading={knowledgeInsightsLoading}
            error={knowledgeInsightsError}
            onRetry={refreshKnowledgeInsights}
            onOpenTask={(taskId) => {
              const target = tasks.find((task) => task.id === taskId);
              if (target) openArtifacts(target);
            }}
          /> : teamAssetTab === "modules" ? <BusinessModuleLibrary
            admin={session.role === "admin"}
            initialAsset={knowledgeFocus?.kind === "business"
              ? knowledgeFocus : undefined} />
            : <WorkflowAssetWorkspace initialWorkflowId={workflowFocusId
              || undefined} />}
        </section>}

        {view === "wishes" && <WishWall viewer={session} draft={wishDraft}
          onDraftConsumed={() => setWishDraft(undefined)} />}

        {view === "mine" && <>
          {missingTaskNotice && <div className="missing-task-notice" role="alert">
            <span>任务 {missingTaskNotice} 不存在或已被删除,已返回「我的需求」。
              链接可能已过期。</span>
            <button type="button" onClick={() => setMissingTaskNotice("")}>知道了</button>
          </div>}
          <PersonalActionInbox
            waiting={myWaiting}
            intervention={myIntervention}
            merges={myTasks.filter((task) => task.status === "await_merge")}
            reviews={pendingReviews}
            tasks={myTasks}
            onOpen={openArtifacts}
          />
          <section className="personal-pulse four" aria-label="我的任务摘要">
            <button type="button" className={`personal-stat personal-action attention${mineScope === "waiting" ? " selected" : ""}`} aria-pressed={mineScope === "waiting"} onClick={() => setMineScope((current) => current === "waiting" ? "all" : "waiting")}><span>待我核对 <i aria-hidden>→</i></span><strong>{myWaiting.length}</strong></button>
            <button type="button" className={`personal-stat personal-action danger${mineScope === "intervention" ? " selected" : ""}`} aria-pressed={mineScope === "intervention"} onClick={() => setMineScope((current) => current === "intervention" ? "all" : "intervention")}><span>需要介入 / 已暂停 <i aria-hidden>→</i></span><strong>{myIntervention.length}</strong></button>
            <button type="button" className={`personal-stat personal-action active${mineScope === "active" ? " selected" : ""}`} aria-pressed={mineScope === "active"} onClick={() => setMineScope((current) => current === "active" ? "all" : "active")}><span>自动推进中 <i aria-hidden>→</i></span><strong>{myActive.length}</strong></button>
            <button type="button" className={`personal-stat personal-action success${mineScope === "delivered" ? " selected" : ""}`} aria-pressed={mineScope === "delivered"} onClick={() => setMineScope((current) => current === "delivered" ? "all" : "delivered")}><span>待合入 / 完成 <i aria-hidden>→</i></span><strong>{myDelivered.length}</strong></button>
          </section>
          {(session.committer || myReviews.length > 0) && <CommitterInbox
            reviews={pendingReviews}
            tasks={tasks}
            onOpen={openArtifacts}
          />}
          <section className="task-section current-work-section" aria-labelledby="current-work-title">
            <div className="section-head"><div><span className="section-kicker">{mineScope === "all" ? "CURRENT WORK" : "FOCUSED WORK"}</span><h2 id="current-work-title">{myWorkTitle}</h2></div><div className="current-work-counts">{mineScope === "all" && myWaiting.length > 0 && <span className="section-count attention">{myWaiting.length} 项待核对</span>}{mineScope === "all" && myIntervention.length > 0 && <span className="section-count danger">{myIntervention.length} 项需介入</span>}<span className="section-count">{mineScope === "all" ? `共 ${visibleMyWork.length} 项` : `筛选出 ${visibleMyWork.length} 项`}</span></div></div>
            {visibleMyWork.length === 0 && <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div><strong>{mineScope === "all" ? "当前没有进行中的任务" : `没有${myWorkTitle}的任务`}</strong><p>{mineScope === "all" ? "新任务启动后会出现在这里；需要你核对的任务会自动排在最前。" : "再次点击上方已选中的摘要卡，可恢复查看全部当前任务。"}</p></div></div>}
            <div className="task-list current-work-list">{visibleMyWork.map((task) => <TaskCard key={task.id} task={task} onChanged={refresh} focused={task.id === targetTaskId} canOperate onOpenArtifacts={() => openArtifacts(task)} />)}</div>
          </section>
          {mineScope === "all" && myDelivered.length > 0 && <TaskGroup kicker="DELIVERY" title="等待合入与最近完成" tasks={myDelivered} onChanged={refresh} onOpenArtifacts={openArtifacts} targetTaskId={targetTaskId} />}
        </>}
        {view === "issues" && session.role !== "admin" && <Suspense fallback={<div className="issue-board-loading">问题处理页加载中…</div>}><IssueBoard viewer={session} onNavigateProfile={() => setView("profile")} /></Suspense>}
        {view === "profile" && session.role !== "admin" && <PersonalSettingsPage
          session={session}
          onSessionPatch={patchSession}
          onTasksChanged={refresh}
        />}
        {view === "users" && session.role === "admin"
          && <UsersBoard me={session.username} />}
        {view === "settings" && session.role === "admin" && <SettingsBoard />}
        {view === "help" && <Suspense fallback={<div className="help-loading">使用帮助加载中…</div>}>
          <HelpCenter viewer={session}
            initialArticleId={helpArticleId}
            onArticleChange={(articleId) => {
              setHelpArticleId(articleId);
              history.pushState({}, "", `/help/${encodeURIComponent(articleId)}`);
            }} />
        </Suspense>}
      </main>
    </div>
    {launchOpen && <LaunchWorkspace session={session}
      onCreated={(created) => {
        void refresh();
        // 下单成功当场打开新任务工作台:比"弹窗一关、任务沉进列表中段"
        // 直接得多——人立刻看到"已创建,排队中"(2026-08-30 审计)。
        openArtifacts(created);
      }} onClose={() => setLaunchOpen(false)}
      onOpenKnowledgeAsset={(target) => {
        // 当前历史项记住打开全文前所在视图；返回根路径时 popstate 才能
        // 恢复“我的需求”，而不是只去掉高亮却仍滞留在团队资产。
        history.replaceState(appHistoryState(view,
          view === "knowledge" ? teamAssetTab : undefined), "",
          location.pathname + location.search);
        setLaunchOpen(false);
        setKnowledgeFocus(target);
        setTeamAssetTab(target.kind === "business" ? "modules" : "knowledge");
        setWorkflowFocusId("");
        setView("knowledge");
        const next = knowledgeAssetPath(target);
        if (location.pathname + location.search !== next) {
          history.pushState(appHistoryState("knowledge",
            target.kind === "business" ? "modules" : "knowledge"), "", next);
        }
      }}
      onOpenWorkflowAssets={(workflowId) => {
        setLaunchOpen(false);
        setKnowledgeFocus(undefined);
        setTeamAssetTab("workflows");
        // 从下单选择器带 id 直达该方案详情(复制/编辑都在那里),
        // 不再把人扔到资产库首页自己找(审计 P1-9)。
        setWorkflowFocusId(workflowId ?? "");
        setView("knowledge");
        if (location.pathname + location.search !== "/") {
          history.pushState(appHistoryState("knowledge", "workflows"), "", "/");
        } else {
          history.replaceState(appHistoryState("knowledge", "workflows"), "", "/");
        }
      }} />}
    {artifactTask && <TaskWorkspace
      task={artifactTask}
      viewerUsername={session.username}
      canOperate={canOperate(artifactTask)}
      canCollaborate={canCollaborate(artifactTask)}
      canRequestReview={responsibleOf(artifactTask) === session.username}
      reviewAssignment={myReviews.find((review) =>
        review.task_id === artifactTask.id && review.status === "pending")}
      onChanged={refresh}
      onClose={closeArtifacts}
      onOpenTask={(taskId) => {
        const related = tasks.find((task) => task.id === taskId);
        if (related) openArtifacts(related);
      }}
      onExecutionPlanFeedback={(draft) => {
        setWishDraft({
          key: `${artifactTask.id}:${artifactTask.execution_plan?.plan_revision ?? "plan"}:${Date.now()}`,
          kind: "wish",
          ...draft,
        });
        closeArtifacts();
        setView("wishes");
      }}
    />}
  </div>;
}

function PersonalActionInbox({
  waiting,
  intervention,
  merges,
  reviews,
  tasks,
  onOpen,
}: {
  waiting: TaskSummary[];
  intervention: TaskSummary[];
  /** await_merge:全链路最后一个必须人动手的动作(去 CodeHub 合入)。
   * 曾被归进绿色"完成堆"不进待办,任务从视野里消失、MR 躺到过期
   * (2026-08-30 审计)。 */
  merges: TaskSummary[];
  reviews: ReviewRequest[];
  tasks: TaskSummary[];
  onOpen: (task: TaskSummary) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const seen = new Set<string>();
  const items: Array<{
    key: string;
    task?: TaskSummary;
    kicker: string;
    title: string;
    detail: string;
    action: string;
  }> = [];
  for (const task of waiting) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `decision:${task.id}`,
      task,
      kicker: "等待你的决定",
      title: task.title ?? task.requirement,
      // 不拿原始步骤 id 当行动指引(cloud_push_confirm 对人是噪声)。
      detail: task.focus?.next_action ?? "查看材料并完成当前确认",
      action: "立即处理",
    });
  }
  for (const review of reviews) {
    const task = tasks.find((item) => item.id === review.task_id);
    if (!task) continue;
    items.push({
      key: `review:${review.id}`,
      task,
      kicker: "Committer 检视",
      title: review.task_title,
      detail: `${review.requester} 邀请你检视代码与交付材料`,
      action: "开始检视",
    });
  }
  for (const task of intervention) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `intervention:${task.id}`,
      task,
      kicker: task.status === "paused" ? "任务已暂停" : "需要人工介入",
      title: task.title ?? task.requirement,
      detail: task.focus?.next_action ?? task.detail ?? "查看现场并决定下一步",
      action: "查看现场",
    });
  }
  for (const task of merges) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `merge:${task.id}`,
      task,
      kicker: "等待你去合入",
      title: task.title ?? task.requirement,
      detail: task.delivery?.mr_url
        ? `验证已通过,请到 CodeHub 完成检视与合入:${task.delivery.mr_url}`
        : "验证已通过,请到 CodeHub 完成检视与合入",
      action: "查看合入请求",
    });
  }
  const shown = expanded ? items : items.slice(0, 3);
  return <section className="personal-action-inbox" aria-labelledby="personal-action-title">
    <div className="personal-action-head">
      <div><span className="section-kicker">NEXT ACTION</span>
        <h2 id="personal-action-title">我现在最应该做什么</h2></div>
      <span>{items.length ? `${items.length} 项待处理` : "当前已清空"}</span>
    </div>
    {shown.length ? <div className="personal-action-list">{shown.map((item, index) => (
      <article key={item.key} className={index === 0 ? "primary" : ""}>
        <span className="personal-action-rank">{String(index + 1).padStart(2, "0")}</span>
        <div><small>{item.kicker}</small><strong>{item.title}</strong><p>{item.detail}</p></div>
        <button type="button" disabled={!item.task}
          onClick={() => item.task && onOpen(item.task)}>{item.action}</button>
      </article>
    ))}</div> : <div className="personal-action-clear">
      <span aria-hidden>✓</span><div><strong>当前没有需要你处理的事项</strong>
        {/* 零任务的新用户看到"Agent 正在推进"会以为后台有活在跑,
            白等半天(2026-08-30 审计)。 */}
        <p>{tasks.length
          ? "Agent 正在继续推进；新的确认、检视或异常会优先出现在这里。"
          : "你还没有任务——点右上角「发起新任务」开始;需要人工处理的事项会优先出现在这里。"}</p></div>
    </div>}
    {items.length > 3 && <button type="button" className="personal-action-more"
      onClick={() => setExpanded((current) => !current)}>
      {expanded ? "收起" : `还有 ${items.length - 3} 项 →`}</button>}
  </section>;
}

function CommitterInbox({
  reviews,
  tasks,
  onOpen,
}: {
  reviews: ReviewRequest[];
  tasks: TaskSummary[];
  onOpen: (task: TaskSummary) => void;
}) {
  return <section className="review-inbox committer-inbox" aria-labelledby="committer-inbox-title">
    <div className="section-head">
      <div><span className="section-kicker">COMMITTER REVIEW</span><h2 id="committer-inbox-title">待我检视</h2></div>
      <span className="section-count attention">{reviews.length} 项</span>
    </div>
    {reviews.length === 0
      ? <div className="review-clear compact"><span aria-hidden>✓</span><div><strong>当前没有待检视任务</strong><p>责任人主动邀请后会出现在这里。</p></div></div>
      : <div className="committer-inbox-list">{reviews.map((review) => {
          const task = tasks.find((item) => item.id === review.task_id);
          return <button type="button" key={review.id} disabled={!task}
            onClick={() => task && onOpen(task)}>
            <span className="committer-inbox-mark" aria-hidden>审</span>
            <span className="committer-inbox-copy"><strong>{review.task_title}</strong><small>{review.requester} 邀请 · {formatLocalDateTime(review.created_at)}</small></span>
            <span className={`delivery-state${review.delivered ? " ok" : " warning"}`}>{review.delivered ? "通知已送达" : "通知未送达"}</span>
            <svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg>
          </button>;
        })}</div>}
  </section>;
}

function NavButton({ view, current, onSelect, label, badge = 0, personal = false }: { view: View; current: View; onSelect: (view: View) => void; label: string; badge?: number; personal?: boolean }) {
  return <button className={`nav-item ${current === view ? "on" : ""}`}
    aria-label={label} title={label} onClick={() => onSelect(view)}>
    <NavIcon name={view} /><span>{label}</span>{badge > 0
      && <span className={`nav-badge${personal ? " personal" : ""}`}>{badge}</span>}
  </button>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { onAuthenticated(await login(username.trim(), password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败，请重试"); }
    finally { setBusy(false); }
  }
  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title"><div className="login-brand"><span className="brand-symbol"><svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg></span><span><strong>Mae-Flow</strong><small>Cloud Console</small></span></div><div className="login-heading"><span className="section-kicker">TEAM WORKSPACE</span><h1 id="login-title">登录工作台</h1><p>管理员掌握团队全局，开发成员直达自己的任务与待核对事项。</p></div><form className="login-form" onSubmit={submit}><label><span>账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label><label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <div className="login-error" role="alert">{error}</div>}<button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录"}<svg viewBox="0 0 20 20"><path d="M4 10h11M11 6l4 4-4 4" /></svg></button></form><p className="login-note">账号由团队管理员在控制台内创建。</p></section><div className="login-aside" aria-hidden><span>01</span><strong>团队进度<br />一眼可见</strong><i /><span>02</span><strong>个人待办<br />集中处理</strong></div></main>;
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="brand-symbol"><svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg></span><span>正在进入工作台…</span></main>;
}

function UsersBoard({ me }: { me: string }) {
  const [users, setUsers] = useState<AuthUser[]>([]); const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); const [role, setRole] = useState<UserRole>("developer");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  // 行内操作(内部平台的管理员特权:重置密码不验旧密码,删号即物理
  // 删除)。resetFor=正在给谁改密码;deleteArm=删除按钮二次确认锁,
  // 点第一下只上膛,再点才执行——不用 window.confirm 打断浏览器。
  const [resetFor, setResetFor] = useState(""); const [resetPassword, setResetPassword] = useState("");
  const [deleteArm, setDeleteArm] = useState("");
  async function refreshUsers() { try { setUsers(await listUsers()); } catch (reason) { setError(reason instanceof Error ? reason.message : "账号列表加载失败"); } }
  useEffect(() => { void refreshUsers(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setMessage("");
    try { const created = await createUser(username.trim(), password, role); setUsername(""); setPassword(""); setMessage(`已创建账号 ${created.username}`); await refreshUsers(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "账号创建失败"); }
    finally { setBusy(false); }
  }
  async function toggleCommitter(user: AuthUser) {
    setError(""); setMessage("");
    try {
      await putCommitter(user.username, !user.committer);
      setMessage(`${user.username} 已${user.committer ? "移出" : "加入"} Committer 名单`);
      await refreshUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Committer 名单更新失败");
    }
  }
  async function submitReset(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await resetUserPassword(resetFor, resetPassword);
      // 重置会作废对方所有活会话;改的是自己则本会话也没了,页面下一次
      // 请求会 401 回登录页——这是诚实结果,不是故障。
      setMessage(`已重置 ${resetFor} 的密码,其登录会话已全部下线`
        + (resetFor === me ? "(包括当前会话,请重新登录)" : ""));
      setResetFor(""); setResetPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码重置失败");
    } finally { setBusy(false); }
  }
  async function removeUser(user: AuthUser) {
    if (deleteArm !== user.username) {
      setDeleteArm(user.username); setMessage(""); setError(""); return;
    }
    setDeleteArm(""); setError(""); setMessage("");
    try {
      await deleteUser(user.username);
      setMessage(`已删除账号 ${user.username}(历史任务记录保留)`);
      await refreshUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号删除失败");
    }
  }
  return <section className="user-admin">
    <div className="user-create-card">
      <div className="user-create-copy">
        <span className="section-kicker">CREATE ACCOUNT</span>
        <h2>添加团队成员</h2>
        <p>开发账号可以查看全部任务，但只能处理分配给自己的任务；管理员维护账号与系统配置，Committer 另行标记。</p>
      </div>
      <form className="user-create-form" onSubmit={submit}>
        <label><span>登录账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如 zhangsan" required /></label>
        <label><span>初始密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" minLength={10} autoComplete="new-password" required /></label>
        <label><span>账号角色</span><select value={role} onChange={(event) => setRole(event.target.value as UserRole)}><option value="developer">开发成员</option><option value="admin">管理员</option></select></label>
        <button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建账号"}</button>
        {message && <div className="form-message success">{message}</div>}
        {error && <div className="form-message error">{error}</div>}
      </form>
    </div>
    <section className="user-list-card" aria-labelledby="user-list-title">
      <div className="section-head">
        <div><span className="section-kicker">TEAM ACCOUNTS</span><h2 id="user-list-title">现有账号</h2><p className="section-note">Committer 只在开发主动邀请检视时收到通知。</p></div>
        <span className="section-count">{users.length} 人</span>
      </div>
      <div className="user-table">
        <div className="user-table-head"><span>成员</span><span>角色</span><span>默认入口</span><span>Committer</span><span>操作</span></div>
        {users.map((user) => <div className="user-block" key={user.username}>
          <div className="user-row">
            <span className="user-cell"><i>{user.username.slice(0, 1).toUpperCase()}</i><strong>{user.username}</strong></span>
            <span><em className={`role-chip ${user.role}`}>{user.role === "admin" ? "管理员" : "开发成员"}</em></span>
            <span className="user-entry">{user.role === "admin" ? "团队任务" : "我的需求"}</span>
            <span><button type="button" className={`committer-toggle${user.committer ? " on" : ""}`} aria-pressed={!!user.committer} onClick={() => void toggleCommitter(user)}><i aria-hidden />{user.committer ? "已加入" : "加入名单"}</button></span>
            <span className="user-actions">
              <button type="button" className="user-action" onClick={() => {
                setResetFor(resetFor === user.username ? "" : user.username);
                setResetPassword(""); setDeleteArm(""); setMessage(""); setError("");
              }}>{resetFor === user.username ? "收起" : "重置密码"}</button>
              {user.username === me
                ? <button type="button" className="user-action" disabled title="不能删除自己——请让另一位管理员操作">删除</button>
                : <button type="button" className={`user-action danger${deleteArm === user.username ? " armed" : ""}`} onClick={() => void removeUser(user)}>{deleteArm === user.username ? "确认删除?" : "删除"}</button>}
            </span>
          </div>
          {resetFor === user.username && <form className="user-reset-row" onSubmit={submitReset}>
            <input type="password" value={resetPassword} placeholder="新密码,至少 10 个字符" minLength={10} autoComplete="new-password" autoFocus required
              onChange={(event) => setResetPassword(event.target.value)} />
            <button type="submit" disabled={busy || resetPassword.length < 10}>{busy ? "重置中…" : "确认重置"}</button>
            <small>不需要旧密码;重置后该账号的登录会话全部下线。</small>
          </form>}
        </div>)}
      </div>
    </section>
  </section>;
}

function TeamDashboard({
  tasks,
  users,
  onChanged,
  onOpenArtifacts,
}: {
  tasks: TaskSummary[];
  users: AuthUser[];
  onChanged: () => void;
  onOpenArtifacts: (task: TaskSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TeamScope>("all");
  const [responsible, setResponsible] = useState("");
  const [phase, setPhase] = useState("");
  const queueRef = useRef<HTMLElement>(null);
  const now = Date.now();
  const currentTasks = useMemo(() => tasks.filter(isCurrentTeamTask), [tasks]);
  const actionable = currentTasks.filter((task) =>
    matchesTeamScope(task, "action", now));
  const stale = currentTasks.filter((task) =>
    matchesTeamScope(task, "stale", now));
  const inProgress = currentTasks.filter((task) =>
    matchesTeamScope(task, "wip", now));
  const waiting = currentTasks.filter((task) =>
    matchesTeamScope(task, "waiting", now));

  const visible = useMemo(() => currentTasks.filter((task) => {
    const words = `${task.id} ${task.title ?? ""} ${task.requirement} ${responsibleOf(task) ?? ""}`
      .toLowerCase();
    if (query.trim() && !words.includes(query.trim().toLowerCase())) return false;
    if (responsible === "__unassigned" && responsibleOf(task)) return false;
    if (responsible && responsible !== "__unassigned"
        && responsibleOf(task) !== responsible) return false;
    if (!matchesTeamScope(task, scope, now)) return false;
    if (phase && task.progress?.current_phase !== phase) return false;
    return true;
  }).sort(byTeamAttention), [currentTasks, query, scope, responsible, phase]);

  function openMetric(next: "action" | "stale" | "wip" | "waiting") {
    setScope((current) => current === next ? "all" : next);
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  function selectPhase(next: string) {
    setPhase((current) => current === next ? "" : next);
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  return <>
    <section className="team-overview" aria-label="当前现场概览">
      <div className="team-overview-metrics" aria-label="团队关键指标">
        <button type="button" className={`overview-metric attention${scope === "action" ? " selected" : ""}`} aria-pressed={scope === "action"} aria-controls="team-queue" onClick={() => openMetric("action")}><span><i aria-hidden />需要处理</span><strong>{actionable.length}</strong><small>决策、失败、暂停</small></button>
        <button type="button" className={`overview-metric danger${scope === "stale" ? " selected" : ""}`} aria-pressed={scope === "stale"} aria-controls="team-queue" onClick={() => openMetric("stale")}><span><i aria-hidden />停滞任务</span><strong>{stale.length}</strong><small>超过 2 小时未推进</small></button>
        <button type="button" className={`overview-metric active${scope === "wip" ? " selected" : ""}`} aria-pressed={scope === "wip"} aria-controls="team-queue" onClick={() => openMetric("wip")}><span><i aria-hidden />正在推进</span><strong>{inProgress.length}</strong><small>排队、执行或验证中</small></button>
        <button type="button" className={`overview-metric neutral${scope === "waiting" ? " selected" : ""}`} aria-pressed={scope === "waiting"} aria-controls="team-queue" onClick={() => openMetric("waiting")}><span><i aria-hidden />等待决策</span><strong>{waiting.length}</strong><small>需要责任人确认</small></button>
      </div>
      <PhaseFunnel tasks={currentTasks} selected={phase} onSelect={selectPhase} />
    </section>

    <section className="task-section" id="team-queue" ref={queueRef} aria-labelledby="team-queue-title">
      <div className="section-head"><div><span className="section-kicker">CURRENT TEAM WORK</span><h2 id="team-queue-title">{phase ? `${phase}阶段现场` : "当前现场"}</h2></div><span className={`section-count${phase ? " active-filter" : ""}`}>{phase ? `阶段 · ${phase}　` : ""}{visible.length} / {currentTasks.length} 项</span></div>
      <div className="task-filters" aria-label="筛选当前现场">
        <label className="task-search"><svg viewBox="0 0 18 18" aria-hidden><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、需求或负责人" /></label>
        <select aria-label="现场范围" value={scope} onChange={(event) => setScope(event.target.value as TeamScope)}><option value="all">全部现场</option><option value="action">需要处理</option><option value="stale">停滞任务</option><option value="wip">正在推进</option><option value="waiting">等待决策</option></select>
        <select aria-label="责任人" value={responsible} onChange={(event) => setResponsible(event.target.value)}><option value="">全部责任人</option><option value="__unassigned">未指定</option>{users.map((user) => <option value={user.username} key={user.username}>{user.username}</option>)}</select>
        {(query || scope !== "all" || responsible || phase) && <button type="button" className="filter-reset" onClick={() => { setQuery(""); setScope("all"); setResponsible(""); setPhase(""); }}>清除筛选</button>}
      </div>
      {visible.length === 0 && <TaskEmpty personal={false} />}
      <div className="task-list">{visible.map((task) => <TaskCard key={task.id} task={task} onChanged={onChanged} canOperate={false} decisionMode="signal" onOpenArtifacts={() => onOpenArtifacts(task)} />)}</div>
    </section>
  </>;
}

function TaskGroup({
  kicker,
  title,
  tasks,
  onChanged,
  onOpenArtifacts,
  targetTaskId,
  empty,
  tone,
}: {
  kicker: string;
  title: string;
  tasks: TaskSummary[];
  onChanged: () => void;
  onOpenArtifacts: (task: TaskSummary) => void;
  targetTaskId: string;
  empty?: string;
  tone?: string;
}) {
  return <section className={`task-section${tone ? ` ${tone}` : ""}`}>
    <div className="section-head"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><span className={`section-count ${tone ?? ""}`}>{tasks.length} 项</span></div>
    {tasks.length === 0 && <div className="review-clear compact"><span aria-hidden>✓</span><div><strong>{empty ?? "当前没有任务"}</strong></div></div>}
    <div className="task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} onChanged={onChanged} focused={task.id === targetTaskId} canOperate onOpenArtifacts={() => onOpenArtifacts(task)} />)}</div>
  </section>;
}

/** 阶段漏斗:状态计数答不了"队伍卡在哪个环节"。阶段与阶段顺序
 * 都来自任务卡同源的 progress(内核现场看板),Web 不复刻阶段表。 */
function PhaseFunnel({
  tasks,
  selected,
  onSelect,
}: {
  tasks: TaskSummary[];
  selected: string;
  onSelect: (phase: string) => void;
}) {
  const tracked = tasks.filter((task) => task.progress
    && !["completed", "canceled", "failed"].includes(task.status));
  if (tracked.length === 0) return <div className="phase-funnel empty">
    <div><strong>暂无流程中任务</strong><small>新任务进入流程后，可按阶段直接筛选。</small></div>
  </div>;
  // 阶段顺序取最长的一份(不同任务可能停在不同修订的看板上)。
  const longest = tracked.reduce<string[]>(
    (best, task) => (task.progress!.phases.length > best.length
      ? task.progress!.phases : best), []);
  const phases = [...new Set([
    ...longest,
    ...tracked.map((task) => task.progress!.current_phase),
  ])];
  const counts = phases.map((phase) => ({
    phase,
    count: tracked.filter((task) => task.progress!.current_phase === phase).length,
    waiting: tracked.filter((task) =>
      task.progress!.current_phase === phase
      && task.status === "waiting_for_human").length,
  }));
  return (
    <div className="phase-funnel" aria-labelledby="funnel-title">
      <div className="phase-funnel-head">
        <div><strong id="funnel-title">按阶段筛选</strong>
          <small>查看团队当前卡在哪一段</small></div>
        <span>{tracked.length} 项在流程中{selected ? ` · 已选“${selected}”` : ""}</span>
      </div>
      <div className="funnel-row">
        {counts.map((entry) => (
          <button type="button"
            className={"funnel-cell"
              + (entry.count > 0 ? " filled" : "")
              + (entry.waiting > 0 ? " attention" : "")
              + (selected === entry.phase ? " selected" : "")}
            key={entry.phase}
            disabled={entry.count === 0}
            aria-pressed={selected === entry.phase}
            aria-controls="team-queue"
            aria-label={`筛选${entry.phase}阶段，${entry.count} 项任务`}
            onClick={() => onSelect(entry.phase)}
          >
            <strong>{entry.count}</strong>
            <span>{entry.phase}</span>
            {entry.waiting > 0 && <i className="funnel-flag">{entry.waiting} 待决策</i>}
          </button>
        ))}
      </div>
    </div>
  );
}

function TaskEmpty({ personal }: { personal: boolean }) {
  return <div className="empty-state"><span className="empty-visual" aria-hidden><i /><i /><i /></span><strong>{personal ? "还没有分配给你的其他任务" : "还没有当前任务"}</strong><p>{personal ? "你发起的任务会自动归入这里，管理员也可以直接分配给你。" : "任务发起后，团队整体进展会出现在这里。"}</p></div>;
}
