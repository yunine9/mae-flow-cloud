/**
 * 管理员默认看团队全局，开发默认直达我的工作；
 * 登录身份决定任务归属与操作权限，任务事实仍来自服务端。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUser, deleteUser, getLaunchOptions, getSession, listMyReviews, listTasks, listUsers,
  login, logout, putCommitter, resetUserPassword,
  type AuthUser, type TaskStatus, type TaskSummary,
  type ReviewRequest, type UserRole,
} from "./api";
import { TaskCard } from "./TaskCard";
import { HistoryBoard } from "./HistoryBoard";
import { LaunchWorkspace } from "./LaunchWorkspace";
import { TaskWorkspace } from "./TaskWorkspace";
import { SettingsBoard } from "./SettingsView";
import { GitTokenCard } from "./GitTokenCard";
import { LubanTokenCard } from "./LubanTokenCard";
import { putMoonlight } from "./api";
import { byUrgency } from "./taskTime";
import {
  byTeamAttention,
  cycleTimeMs,
  isBlocked,
  isStale,
  matchesTeamScope,
  median,
  responsibleOf,
  progressAgeMs,
  type TeamScope,
} from "./teamOps";
import { formatLocalDateTime } from "./time";
import { taskSyncCopy, type TaskSyncState } from "./taskSync";
import {
  launchGateCopy,
  type LaunchGateState,
} from "./launchGate";

type View = "team" | "mine" | "profile" | "history" | "users" | "settings";
type Theme = "light" | "dark";
type MineScope = "all" | "waiting" | "intervention" | "active" | "delivered";

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
  // 管理员没有"我的待办"(不下单的角色没有个人任务收件箱,用户拍板):
  // 深链也一律落到团队总览,从那里打开任意任务行使兜底控制。
  if (user.role === "admin") return "team";
  if (readWorkspaceRoute().reviewId) return "mine";
  return "mine";
}

/** 月光模式(免审批)开关:默认关;开=本人任务的人工节点自动放行
 * (已在等的卡立刻清场),关=之后恢复审批。状态是服务端事实,
 * 界面只呈现与切换。 */
function MoonlightToggle({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (moonlight: boolean) => Promise<void>;
}) {
  const [on, setOn] = useState(!!session.moonlight);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  async function select(next: boolean) {
    if (next === on || busy) return;
    setBusy(true);
    try {
      const result = await putMoonlight(next);
      setOn(result.moonlight);
      setNote(result.moonlight
        ? (result.swept > 0
            ? `已自动放行 ${result.swept} 项正在等待的确认`
            : "已启用自动放行，执行过程不再等待逐项确认")
        : "已恢复逐步确认，后续人工节点会等待你拍板");
      await onChanged(result.moonlight);
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className={`approval-setting${on ? " is-auto" : ""}`} aria-labelledby="approval-setting-title">
    <header className="approval-setting-head">
      <span className="approval-setting-icon" aria-hidden><svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg></span>
      <div><span className="section-kicker">APPROVAL MODE</span><h2 id="approval-setting-title">任务审批方式</h2></div>
      <span className="approval-setting-state">当前：{on ? "自动放行" : "逐步确认"}</span>
    </header>
    <p className="approval-setting-summary">决定 Agent 遇到人工节点时，是停下来等你确认，还是继续执行并在事后复盘。</p>
    <div className="approval-options" role="group" aria-label="任务审批方式">
      <button type="button" className={!on ? "on" : ""} disabled={busy}
        onClick={() => void select(false)}>
        <i aria-hidden>✓</i><span><strong>逐步确认</strong><small>关键节点等待你拍板，控制更稳妥</small></span>
      </button>
      <button type="button" className={on ? "on" : ""} disabled={busy}
        onClick={() => void select(true)}>
        <i aria-hidden><svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg></i><span><strong>月光模式 · 自动放行</strong><small>不中断执行，完成后统一复盘</small></span>
      </button>
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
    <MoonlightToggle session={session} onChanged={async (moonlight) => {
      onSessionPatch({ moonlight });
      await onTasksChanged();
    }} />
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
  if (name === "profile") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75" /><circle cx="17.5" cy="15.5" r="2.25" /><path d="M17.5 11.75v1.5M17.5 17.75v1.5M13.75 15.5h1.5M19.75 15.5h1.5" /></svg>;
  if (name === "users") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75M16.5 7.5h4M18.5 5.5v4" /></svg>;
  if (name === "settings") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4.75h14A1.25 1.25 0 0 1 20.25 6v12A1.25 1.25 0 0 1 19 19.25H5A1.25 1.25 0 0 1 3.75 18V6A1.25 1.25 0 0 1 5 4.75Z" /><path d="M8 9h8M8 13h5" /></svg>;
}

const DELIVERED_STATUSES: TaskStatus[] = ["await_merge", "completed"];

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [session, setSession] = useState<AuthUser | null>();
  const [view, setView] = useState<View>("team");
  const [mineScope, setMineScope] = useState<MineScope>("all");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [teamUsers, setTeamUsers] = useState<AuthUser[]>([]);
  const [myReviews, setMyReviews] = useState<ReviewRequest[]>([]);
  const [artifactTaskId, setArtifactTaskId] = useState("");
  const [artifactTaskSnapshot, setArtifactTaskSnapshot] = useState<TaskSummary>();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchGate, setLaunchGate] = useState<LaunchGateState>({ kind: "checking" });
  const launchGateRequest = useRef(0);
  const [taskSync, setTaskSync] = useState<TaskSyncState>({ kind: "loading" });
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
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [session?.username]);

  useEffect(() => {
    if (session?.role !== "admin" || view !== "team") return;
    void listUsers().then(setTeamUsers).catch(() => setTeamUsers([]));
  }, [session?.username, session?.role, view]);

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
    if (!target) return;
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
    if (latest) setArtifactTaskSnapshot(latest);
  }, [tasks, artifactTaskId]);

  const assignedToMe = session
    ? tasks.filter((task) => responsibleOf(task) === session.username)
    : [];
  // 管理员不再有个人待办:归属人=下单人是硬规则,无主任务只可能来自
  // 无鉴权的老现场,团队总览里照常可见、可打开兜底处置。

  if (session === undefined) return <LoadingScreen />;
  if (session === null) return <LoginScreen onAuthenticated={(user) => {
    launchGateRequest.current += 1;
    setLaunchGate({ kind: "checking" });
    setSession(user); setMineScope("all"); setView(initialView(user));
  }} />;

  async function signOut() {
    await logout().catch(() => undefined);
    setTasks([]);
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
  const visibleMyWork = mineScope === "waiting" ? myWaiting
    : mineScope === "intervention" ? myIntervention
      : mineScope === "active" ? myActive
        : mineScope === "delivered" ? myDelivered : myCurrent;
  const myWorkTitle = mineScope === "waiting" ? "待我核对"
    : mineScope === "intervention" ? "需要介入 / 已暂停"
      : mineScope === "active" ? "自动推进中"
        : mineScope === "delivered" ? "等待合入与最近完成" : "当前任务";
  const artifactTask = artifactTaskId
    ? tasks.find((task) => task.id === artifactTaskId)
      ?? (artifactTaskSnapshot?.id === artifactTaskId
        ? artifactTaskSnapshot : undefined)
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
  const header = {
    team: session.role === "admin"
      ? { title: "团队总览", description: "看团队推进、负责人和阻塞风险；需要兜底时打开任务的过程工作台处置(暂停/恢复/决定)。" }
      : { title: "团队动态", description: "只读了解团队正在推进什么；你的待办与操作始终留在个人工作台。" },
    mine: { title: "我的工作", description: "从发起到交付，集中推进你的每一项任务。" },
    profile: { title: "个人设置", description: "集中管理任务审批方式、CodeHub 提交身份和小鲁班通知。" },
    history: { title: "交付历史", description: "回看任务与交付记录；未启用历史投影时仍可浏览当前任务现场。" },
    users: { title: "账号管理", description: "创建本地账号并分配管理员或开发权限。" },
    settings: { title: "服务设置", description: "集中管理模型网关和团队运行策略；部署链路在此只读自检。" },
  }[view];
  const relevantWaiting = view === "mine"
    ? myWaiting.length + pendingReviews.length
    : view === "team" ? waitingCount : 0;
  const launchEntry = launchGateCopy(launchGate);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><span className="brand-symbol" aria-hidden><svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg></span><span className="brand-copy"><strong>Mae-Flow</strong><small>{session.role === "admin" ? "Management Console" : "Developer Workspace"}</small></span></div>
      <nav className="sidebar-nav" aria-label="视图切换">
        {session.role === "admin" ? <>
          <span className="nav-section-label">管理视角</span>
          <NavButton view="team" current={view} onSelect={setView} label="团队总览" badge={waitingCount} />
          <NavButton view="history" current={view} onSelect={setView} label="交付历史" />
          <span className="nav-section-label admin-tools">系统管理</span>
          <NavButton view="users" current={view} onSelect={setView} label="账号管理" />
          <NavButton view="settings" current={view} onSelect={setView} label="服务设置" />
        </> : <>
          <span className="nav-section-label">个人工作台</span>
          <NavButton view="mine" current={view} onSelect={setView} label="我的工作" badge={myWaiting.length + pendingReviews.length} personal />
          <NavButton view="profile" current={view} onSelect={setView} label="个人设置" />
          <span className="nav-section-label team-context">团队信息</span>
          <NavButton view="team" current={view} onSelect={setView} label="团队动态" badge={waitingCount} />
          <NavButton view="history" current={view} onSelect={setView} label="交付历史" />
        </>}
      </nav>
      <div className="sidebar-bottom">
        <ThemeSwitch theme={theme} onChange={changeTheme} />
        <div className="sidebar-foot session-foot"><span className="account-avatar" aria-hidden>{session.username.slice(0, 1).toUpperCase()}</span><span className="sidebar-account"><strong>{session.username}</strong><small>{session.role === "admin" ? "管理员" : "开发成员"}</small></span><button type="button" className="logout-button" onClick={signOut} title="退出登录" aria-label="退出登录"><svg viewBox="0 0 20 20"><path d="M8 4H4.75A1.25 1.25 0 0 0 3.5 5.25v9.5A1.25 1.25 0 0 0 4.75 16H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" /></svg></button></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="workspace-header"><div><div className="eyebrow">MAE-FLOW CLOUD</div><h1>{header.title}</h1><p className={view === "mine" ? "header-context-line" : undefined}>{view === "mine" && <span className="header-user-context">{session.username}</span>}<span>{header.description}</span></p></div><div className="workspace-header-actions"><TaskSyncIndicator state={taskSync} onRetry={refresh} />{relevantWaiting > 0 && view !== "history" && view !== "users" && view !== "settings" && <div className="header-attention"><span className="attention-pulse" aria-hidden /><span><strong>{relevantWaiting}</strong>{view === "mine" ? " 项需要我处理" : " 项工作等待决策"}</span></div>}{view === "mine" && session.role !== "admin" && <div className="header-launch-gate"><button type="button" className="header-launch" disabled={!launchEntry.enabled} title={launchEntry.title} aria-label={launchEntry.ariaLabel} onClick={() => launchEntry.enabled && setLaunchOpen(true)}><svg viewBox="0 0 20 20" aria-hidden>{launchEntry.enabled ? <path d="M10 4v12M4 10h12" /> : <><rect x="5" y="8.5" width="10" height="8" rx="1.5" /><path d="M7.5 8.5V6.75a2.5 2.5 0 0 1 5 0V8.5" /></>}</svg><span>发起新任务</span></button>{launchEntry.helper && (launchEntry.action ? <button type="button" className="header-unlock" title={launchEntry.title} onClick={() => launchEntry.action === "profile" ? setView("profile") : void refreshLaunchGate(true)}>{launchEntry.helper}<svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg></button> : <span className="header-unlock is-status" title={launchEntry.title}>{launchEntry.helper}</span>)}</div>}</div></header>
      <main className="workspace-main">
        {view === "team" && <TeamDashboard
          tasks={tasks}
          users={teamUsers}
          onChanged={refresh}
          onOpenArtifacts={openArtifacts}
        />}

        {view === "mine" && <>
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
        {view === "profile" && session.role !== "admin" && <PersonalSettingsPage
          session={session}
          onSessionPatch={patchSession}
          onTasksChanged={refresh}
        />}
        {view === "history" && <HistoryBoard tasks={tasks} onOpenTask={openArtifacts} />}
        {view === "users" && session.role === "admin"
          && <UsersBoard me={session.username} />}
        {view === "settings" && session.role === "admin" && <SettingsBoard />}
      </main>
    </div>
    {launchOpen && <LaunchWorkspace session={session} onCreated={refresh} onClose={() => setLaunchOpen(false)} />}
    {artifactTask && <TaskWorkspace
      task={artifactTask}
      viewerUsername={session.username}
      canOperate={canOperate(artifactTask)}
      canRequestReview={responsibleOf(artifactTask) === session.username}
      reviewAssignment={myReviews.find((review) =>
        review.task_id === artifactTask.id && review.status === "pending")}
      onChanged={refresh}
      onClose={closeArtifacts}
      onOpenTask={(taskId) => {
        const related = tasks.find((task) => task.id === taskId);
        if (related) openArtifacts(related);
      }}
    />}
  </div>;
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
            <span className="user-entry">{user.role === "admin" ? "团队总览" : "我的工作"}</span>
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

function formatOpsDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "<1 小时";
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

function riskReason(task: TaskSummary): string {
  if (task.focus) return `${task.focus.headline} · ${task.focus.next_action}`;
  if (task.status === "waiting_for_human") return "等待负责人决策";
  if (task.status === "paused") return "任务已暂停，等待恢复";
  if (task.status === "failed") return task.detail ?? "任务执行失败";
  if (isBlocked(task)) return "自动修复已停，需要人工介入";
  if (isStale(task)) return "超过 2 小时没有有效推进";
  return "需要关注";
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
  const queueRef = useRef<HTMLElement>(null);
  const now = Date.now();
  const actionable = tasks.filter((task) =>
    matchesTeamScope(task, "action", now));
  const stale = tasks.filter((task) =>
    matchesTeamScope(task, "stale", now));
  const wip = tasks.filter((task) => matchesTeamScope(task, "wip", now));
  const deliveredWeek = tasks.filter((task) =>
    matchesTeamScope(task, "week", now));
  const medianCycle = median(tasks.map(cycleTimeMs)
    .filter((value): value is number => value !== undefined));
  const risks = [...new Map(
    [...actionable, ...stale].map((task) => [task.id, task]),
  ).values()].sort(byTeamAttention).slice(0, 6);

  const visible = useMemo(() => tasks.filter((task) => {
    const words = `${task.id} ${task.title ?? ""} ${task.requirement} ${responsibleOf(task) ?? ""}`
      .toLowerCase();
    if (query.trim() && !words.includes(query.trim().toLowerCase())) return false;
    if (responsible === "__unassigned" && responsibleOf(task)) return false;
    if (responsible && responsible !== "__unassigned"
        && responsibleOf(task) !== responsible) return false;
    if (!matchesTeamScope(task, scope, now)) return false;
    return true;
  }).sort(byTeamAttention), [tasks, query, scope, responsible]);

  function openMetric(next: Exclude<TeamScope, "all" | "waiting" | "delivered">) {
    setScope((current) => current === next ? "all" : next);
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  return <>
    <section className="team-pulse ops-pulse" aria-labelledby="pulse-title">
      <div className="section-head pulse-head"><div><span className="section-kicker">TEAM OPERATIONS</span><h2 id="pulse-title">团队行动态势</h2></div><span className="section-count">行动项优先</span></div>
      <div className="pulse-grid ops-grid">
        <button type="button" className={`pulse-card metric-action attention${scope === "action" ? " selected" : ""}`} aria-pressed={scope === "action"} aria-controls="team-queue" onClick={() => openMetric("action")}><span className="pulse-card-label"><i aria-hidden />需要处理</span><strong>{actionable.length}</strong><small>决策、失败与人工阻塞</small><span className="metric-action-hint">查看明细 <i aria-hidden>→</i></span></button>
        <button type="button" className={`pulse-card metric-action danger${scope === "stale" ? " selected" : ""}`} aria-pressed={scope === "stale"} aria-controls="team-queue" onClick={() => openMetric("stale")}><span className="pulse-card-label"><i aria-hidden />停滞任务</span><strong>{stale.length}</strong><small>2 小时没有有效推进</small><span className="metric-action-hint">查看明细 <i aria-hidden>→</i></span></button>
        <button type="button" className={`pulse-card metric-action active${scope === "wip" ? " selected" : ""}`} aria-pressed={scope === "wip"} aria-controls="team-queue" onClick={() => openMetric("wip")}><span className="pulse-card-label"><i aria-hidden />当前在制</span><strong>{wip.length}</strong><small>机器与人工正在推进</small><span className="metric-action-hint">查看明细 <i aria-hidden>→</i></span></button>
        <button type="button" className={`pulse-card metric-action success${scope === "week" ? " selected" : ""}`} aria-pressed={scope === "week"} aria-controls="team-queue" onClick={() => openMetric("week")}><span className="pulse-card-label"><i aria-hidden />近 7 天交付</span><strong>{deliveredWeek.length}</strong><small>进入完成或等待合入</small><span className="metric-action-hint">查看明细 <i aria-hidden>→</i></span></button>
        <div className="pulse-card neutral"><span className="pulse-card-label"><i aria-hidden />典型交付周期</span><strong className="duration">{formatOpsDuration(medianCycle)}</strong><small>当前历史中位数</small></div>
      </div>
    </section>

    {risks.length > 0 && <section className="risk-radar" aria-labelledby="risk-title">
      <div className="section-head"><div><span className="section-kicker">ATTENTION QUEUE</span><h2 id="risk-title">需要关注</h2></div><span className="section-count attention">{risks.length} 项优先展示</span></div>
      <div className="risk-list">{risks.map((task) => <button type="button" key={task.id} onClick={() => onOpenArtifacts(task)}><span className="risk-dot" aria-hidden /><span className="risk-main"><strong>{task.title ?? task.requirement}</strong><small>{riskReason(task)}</small></span><span className="risk-owner">{responsibleOf(task) ?? "未指定"}</span><span className="risk-age">{formatOpsDuration(progressAgeMs(task, now))}</span><svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg></button>)}</div>
    </section>}

    <PhaseFunnel tasks={tasks} />

    <section className="task-section" id="team-queue" ref={queueRef} aria-labelledby="team-queue-title">
      <div className="section-head"><div><span className="section-kicker">TEAM QUEUE</span><h2 id="team-queue-title">团队任务明细</h2></div><span className="section-count">{visible.length} / {tasks.length} 项</span></div>
      <div className="task-filters" aria-label="筛选团队任务">
        <label className="task-search"><svg viewBox="0 0 18 18" aria-hidden><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、需求或负责人" /></label>
        <select aria-label="任务范围" value={scope} onChange={(event) => setScope(event.target.value as TeamScope)}><option value="all">全部范围</option><option value="action">需要处理</option><option value="stale">停滞任务</option><option value="wip">当前在制</option><option value="waiting">等待决策</option><option value="week">近 7 天交付</option><option value="delivered">全部已交付</option></select>
        <select aria-label="责任人" value={responsible} onChange={(event) => setResponsible(event.target.value)}><option value="">全部责任人</option><option value="__unassigned">未指定</option>{users.map((user) => <option value={user.username} key={user.username}>{user.username}</option>)}</select>
        {(query || scope !== "all" || responsible) && <button type="button" className="filter-reset" onClick={() => { setQuery(""); setScope("all"); setResponsible(""); }}>清除筛选</button>}
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
function PhaseFunnel({ tasks }: { tasks: TaskSummary[] }) {
  const tracked = tasks.filter((task) => task.progress);
  if (tracked.length === 0) return null;
  // 阶段顺序取最长的一份(不同任务可能停在不同修订的看板上)。
  const phases = tracked.reduce<string[]>(
    (best, task) => (task.progress!.phases.length > best.length
      ? task.progress!.phases : best), []);
  const counts = phases.map((phase) => ({
    phase,
    count: tracked.filter((task) => task.progress!.current_phase === phase).length,
    waiting: tracked.filter((task) =>
      task.progress!.current_phase === phase
      && task.status === "waiting_for_human").length,
  }));
  return (
    <section className="phase-funnel" aria-labelledby="funnel-title">
      <div className="section-head">
        <div>
          <span className="section-kicker">PIPELINE</span>
          <h2 id="funnel-title">阶段分布</h2>
        </div>
        <span className="section-count">{tracked.length} 项在流程中</span>
      </div>
      <div className="funnel-row">
        {counts.map((entry) => (
          <div
            className={"funnel-cell"
              + (entry.count > 0 ? " filled" : "")
              + (entry.waiting > 0 ? " attention" : "")}
            key={entry.phase}
          >
            <strong>{entry.count}</strong>
            <span>{entry.phase}</span>
            {entry.waiting > 0 && <i className="funnel-flag">待决策</i>}
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskEmpty({ personal }: { personal: boolean }) {
  return <div className="empty-state"><span className="empty-visual" aria-hidden><i /><i /><i /></span><strong>{personal ? "还没有分配给你的其他任务" : "还没有当前任务"}</strong><p>{personal ? "你发起的任务会自动归入这里，管理员也可以直接分配给你。" : "任务发起后，团队整体进展会出现在这里。"}</p></div>;
}
