/**
 * 管理员默认看团队全局，开发默认直达我的工作；
 * 登录身份决定任务归属与操作权限，任务事实仍来自服务端。
 */
import { useEffect, useState } from "react";
import {
  createUser, getSession, listTasks, listUsers, login, logout,
  type AuthUser, type TaskStatus, type TaskSummary, type UserRole,
} from "./api";
import { TaskCard } from "./TaskCard";
import { HistoryBoard } from "./HistoryBoard";
import { LaunchWorkspace } from "./LaunchWorkspace";
import { TaskWorkspace } from "./TaskWorkspace";
import { SettingsBoard } from "./SettingsView";
import { GitTokenCard } from "./GitTokenCard";
import { byUrgency } from "./taskTime";

type View = "team" | "mine" | "history" | "users" | "settings";

function initialView(user: AuthUser): View {
  return new URLSearchParams(location.search).has("task")
    ? "mine" : user.role === "admin" ? "team" : "mine";
}

function NavIcon({ name }: { name: View }) {
  if (name === "team") return <svg viewBox="0 0 24 24" aria-hidden><path d="M4.75 19.25V11.5h4v7.75h-4Zm5.75 0V4.75h4v14.5h-4Zm5.75 0V8h4v11.25h-4Z" /></svg>;
  if (name === "mine") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="8" r="3.25" /><path d="M5.5 19.25c.65-3.45 2.82-5.25 6.5-5.25s5.85 1.8 6.5 5.25" /></svg>;
  if (name === "users") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75M16.5 7.5h4M18.5 5.5v4" /></svg>;
  if (name === "settings") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4.75h14A1.25 1.25 0 0 1 20.25 6v12A1.25 1.25 0 0 1 19 19.25H5A1.25 1.25 0 0 1 3.75 18V6A1.25 1.25 0 0 1 5 4.75Z" /><path d="M8 9h8M8 13h5" /></svg>;
}

const PULSE_GROUPS: Array<{ label: string; tone: string; statuses?: TaskStatus[] }> = [
  { label: "全部任务", tone: "neutral" },
  { label: "推进中", tone: "active", statuses: ["queued", "running", "verifying"] },
  { label: "待决策", tone: "attention", statuses: ["waiting_for_human"] },
  { label: "待合入 / 完成", tone: "success", statuses: ["await_merge", "completed"] },
  { label: "异常", tone: "danger", statuses: ["failed"] },
];
const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "verifying"];
const DELIVERED_STATUSES: TaskStatus[] = ["await_merge", "completed"];

export function App() {
  const [session, setSession] = useState<AuthUser | null>();
  const [view, setView] = useState<View>("team");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [artifactTaskId, setArtifactTaskId] = useState("");
  const [artifactTaskSnapshot, setArtifactTaskSnapshot] = useState<TaskSummary>();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [targetTaskId] = useState(() => new URLSearchParams(location.search).get("task")?.trim() ?? "");

  useEffect(() => {
    void getSession().then((user) => {
      setSession(user);
      if (user) setView(initialView(user));
    }).catch(() => setSession(null));
  }, []);

  async function refresh() {
    // 等人的排最前、等最久的第一:这块屏幕先回答"谁在等我"。
    try { setTasks((await listTasks()).sort(byUrgency)); }
    catch {
      const current = await getSession().catch(() => null);
      if (!current) setSession(null);
    }
  }

  useEffect(() => {
    if (!session) return;
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [session?.username]);

  useEffect(() => {
    if (view !== "mine" || !targetTaskId || tasks.length === 0) return;
    const timer = window.setTimeout(() => document.getElementById(`task-${targetTaskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    return () => clearTimeout(timer);
  }, [view, targetTaskId, tasks.length]);

  // 打开的工作台必须跨轮询稳定存在。任务在状态切换时可能有一拍没出现在
  // 列表响应里；若直接用 tasks.find 渲染,组件会被卸载再挂载,表现为
  // “一点专注审阅就闪退”,同时丢掉当前文件和展开状态。
  useEffect(() => {
    if (!artifactTaskId) return;
    const latest = tasks.find((task) => task.id === artifactTaskId);
    if (latest) setArtifactTaskSnapshot(latest);
  }, [tasks, artifactTaskId]);

  const assignedToMe = session
    ? tasks.filter((task) => task.luban_account === session.username)
    : [];
  const adminFallbackWaiting = session?.role === "admin"
    ? tasks.filter((task) => !task.luban_account && task.status === "waiting_for_human")
    : [];

  if (session === undefined) return <LoadingScreen />;
  if (session === null) return <LoginScreen onAuthenticated={(user) => {
    setSession(user); setView(initialView(user));
  }} />;

  async function signOut() {
    await logout().catch(() => undefined); setTasks([]); setSession(null);
  }

  const waitingCount = tasks.filter((task) => task.status === "waiting_for_human").length;
  const myTasks = [...assignedToMe, ...adminFallbackWaiting];
  const myWaiting = myTasks.filter((task) => task.status === "waiting_for_human");
  const myOtherTasks = myTasks.filter((task) => task.status !== "waiting_for_human");
  const artifactTask = artifactTaskId
    ? tasks.find((task) => task.id === artifactTaskId)
      ?? (artifactTaskSnapshot?.id === artifactTaskId
        ? artifactTaskSnapshot : undefined)
    : undefined;
  const openArtifacts = (task: TaskSummary) => {
    setArtifactTaskSnapshot(task);
    setArtifactTaskId(task.id);
  };
  const closeArtifacts = () => {
    setArtifactTaskId("");
    setArtifactTaskSnapshot(undefined);
  };
  // 谁能提交决定:管理员或任务归属人。工作台与列表共用这一个口径。
  const canOperate = (task: TaskSummary) =>
    session.role === "admin" || task.luban_account === session.username;
  const header = {
    team: session.role === "admin"
      ? { title: "团队总览", description: "只看团队推进、负责人和阻塞风险；具体操作统一回到个人工作台。" }
      : { title: "团队动态", description: "只读了解团队正在推进什么；你的待办与操作始终留在个人工作台。" },
    mine: { title: "我的工作", description: "集中处理分配给我的需求、待确认事项和后续交付动作。" },
    history: { title: "交付历史", description: "从投影读侧回看跨生命周期的任务与交付记录。" },
    users: { title: "账号管理", description: "创建本地账号并分配管理员或开发权限。" },
    settings: { title: "服务设置", description: "运行参数、通知投递与模型网关；改了即刻安全生效，密钥只写不读。" },
  }[view];
  const relevantWaiting = view === "mine" ? myWaiting.length : waitingCount;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-lockup"><span className="brand-symbol" aria-hidden><svg viewBox="0 0 28 28"><path d="M5.5 20.5 10.7 7l3.3 7.15L17.3 7l5.2 13.5" /><path d="M8.1 16.1h11.8" /></svg></span><span className="brand-copy"><strong>Mae-Flow</strong><small>{session.role === "admin" ? "Management Console" : "Developer Workspace"}</small></span></div>
      <nav className="sidebar-nav" aria-label="视图切换">
        {session.role === "admin" ? <>
          <span className="nav-section-label">管理视角</span>
          <NavButton view="team" current={view} onSelect={setView} label="团队总览" badge={waitingCount} />
          <NavButton view="mine" current={view} onSelect={setView} label="我的待办" badge={myWaiting.length} personal />
          <NavButton view="history" current={view} onSelect={setView} label="交付历史" />
          <span className="nav-section-label admin-tools">系统管理</span>
          <NavButton view="users" current={view} onSelect={setView} label="账号管理" />
          <NavButton view="settings" current={view} onSelect={setView} label="服务设置" />
        </> : <>
          <span className="nav-section-label">个人工作台</span>
          <NavButton view="mine" current={view} onSelect={setView} label="我的工作" badge={myWaiting.length} personal />
          <span className="nav-section-label team-context">团队信息</span>
          <NavButton view="team" current={view} onSelect={setView} label="团队动态" badge={waitingCount} />
          <NavButton view="history" current={view} onSelect={setView} label="交付历史" />
        </>}
      </nav>
      <div className="sidebar-foot session-foot"><span className="account-avatar" aria-hidden>{session.username.slice(0, 1).toUpperCase()}</span><span className="sidebar-account"><strong>{session.username}</strong><small>{session.role === "admin" ? "管理员" : "开发成员"}</small></span><button type="button" className="logout-button" onClick={signOut} title="退出登录" aria-label="退出登录"><svg viewBox="0 0 20 20"><path d="M8 4H4.75A1.25 1.25 0 0 0 3.5 5.25v9.5A1.25 1.25 0 0 0 4.75 16H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" /></svg></button></div>
    </aside>

    <div className="workspace">
      <header className="workspace-header"><div><div className="eyebrow">MAE-FLOW CLOUD</div><h1>{header.title}</h1><p>{header.description}</p></div><div className="workspace-header-actions">{relevantWaiting > 0 && view !== "history" && view !== "users" && view !== "settings" && <div className="header-attention"><span className="attention-pulse" aria-hidden /><span><strong>{relevantWaiting}</strong>{view === "mine" ? " 项需要我核对" : " 项工作等待决策"}</span></div>}{view === "mine" && <button type="button" className="header-launch" onClick={() => setLaunchOpen(true)}><svg viewBox="0 0 20 20" aria-hidden><path d="M10 4v12M4 10h12" /></svg><span>发起新任务</span></button>}</div></header>
      <main className="workspace-main">
        {view === "team" && <>
          <section className="team-pulse" aria-labelledby="pulse-title"><div className="section-head pulse-head"><div><span className="section-kicker">TEAM PULSE</span><h2 id="pulse-title">团队任务态势</h2></div><span className="live-label"><i aria-hidden /> 实时更新</span></div><div className="pulse-grid">{PULSE_GROUPS.map((group) => { const count = group.statuses ? tasks.filter((task) => group.statuses!.includes(task.status)).length : tasks.length; return <div className={`pulse-card ${group.tone}`} key={group.label}><span className="pulse-card-label"><i aria-hidden />{group.label}</span><strong>{count}</strong></div>; })}</div></section>
          <PhaseFunnel tasks={tasks} />
          <section className="task-section" aria-labelledby="team-queue-title"><div className="section-head"><div><span className="section-kicker">TEAM QUEUE</span><h2 id="team-queue-title">团队任务明细</h2></div><span className="section-count">{tasks.length} 项</span></div>{tasks.length === 0 && <TaskEmpty personal={false} />}<div className="task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} onChanged={refresh} canOperate={false} decisionMode="signal" onOpenArtifacts={() => openArtifacts(task)} />)}</div></section>
        </>}

        {view === "mine" && <>
          <section className="identity-bar session-bar"><div className="identity-copy"><span className="section-kicker">PERSONAL INBOX</span><strong>{session.username} 的专属工作台</strong><small>{session.role === "admin" ? "显示分配给你的工作，并兜底承接尚未分配负责人的待确认事项。" : "登录身份已和任务归属绑定；这里始终只显示分配给你的工作。"}</small></div><span className={`role-chip ${session.role}`}>{session.role === "admin" ? "管理员身份" : "开发身份"}</span></section>
          <GitTokenCard initialHint={session.git_token_hint} />
          <section className="personal-pulse" aria-label="我的任务摘要"><div className="personal-stat attention"><span>待我核对</span><strong>{myWaiting.length}</strong></div><div className="personal-stat active"><span>执行中</span><strong>{myTasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length}</strong></div><div className="personal-stat success"><span>待合入 / 完成</span><strong>{myTasks.filter((task) => DELIVERED_STATUSES.includes(task.status)).length}</strong></div></section>
          <section className="review-inbox" aria-labelledby="review-title"><div className="section-head"><div><span className="section-kicker">REVIEW INBOX</span><h2 id="review-title">待我核对</h2></div><span className="section-count attention">{myWaiting.length} 项</span></div>{myWaiting.length === 0 ? <div className="review-clear"><span aria-hidden>✓</span><div><strong>当前没有需要你核对的事项</strong><p>新的人工节点会通过小鲁班提醒，并自动出现在这里。</p></div></div> : <div className="task-list review-list">{myWaiting.map((task) => <TaskCard key={task.id} task={task} onChanged={refresh} focused={task.id === targetTaskId} canOperate onOpenArtifacts={() => openArtifacts(task)} />)}</div>}</section>
          <section className="task-section" aria-labelledby="my-queue-title"><div className="section-head"><div><span className="section-kicker">MY TASKS</span><h2 id="my-queue-title">我的其他任务</h2></div><span className="section-count">{myOtherTasks.length} 项</span></div>{myOtherTasks.length === 0 && <TaskEmpty personal />}<div className="task-list">{myOtherTasks.map((task) => <TaskCard key={task.id} task={task} onChanged={refresh} focused={task.id === targetTaskId} canOperate onOpenArtifacts={() => openArtifacts(task)} />)}</div></section>
        </>}
        {view === "history" && <HistoryBoard />}
        {view === "users" && session.role === "admin" && <UsersBoard />}
        {view === "settings" && session.role === "admin" && <SettingsBoard />}
      </main>
    </div>
    {launchOpen && <LaunchWorkspace session={session} onCreated={refresh} onClose={() => setLaunchOpen(false)} />}
    {artifactTask && <TaskWorkspace task={artifactTask} canOperate={canOperate(artifactTask)} onChanged={refresh} onClose={closeArtifacts} />}
  </div>;
}

function NavButton({ view, current, onSelect, label, badge = 0, personal = false }: { view: View; current: View; onSelect: (view: View) => void; label: string; badge?: number; personal?: boolean }) {
  return <button className={`nav-item ${current === view ? "on" : ""}`} onClick={() => onSelect(view)}><NavIcon name={view} /><span>{label}</span>{badge > 0 && <span className={`nav-badge${personal ? " personal" : ""}`}>{badge}</span>}</button>;
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

function UsersBoard() {
  const [users, setUsers] = useState<AuthUser[]>([]); const [username, setUsername] = useState("");
  const [password, setPassword] = useState(""); const [role, setRole] = useState<UserRole>("developer");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  async function refreshUsers() { try { setUsers(await listUsers()); } catch (reason) { setError(reason instanceof Error ? reason.message : "账号列表加载失败"); } }
  useEffect(() => { void refreshUsers(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setMessage("");
    try { const created = await createUser(username.trim(), password, role); setUsername(""); setPassword(""); setMessage(`已创建账号 ${created.username}`); await refreshUsers(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "账号创建失败"); }
    finally { setBusy(false); }
  }
  return <section className="user-admin"><div className="user-create-card"><div className="user-create-copy"><span className="section-kicker">CREATE ACCOUNT</span><h2>添加团队成员</h2><p>开发账号可以查看全部任务，但只能处理分配给自己的任务；管理员拥有全部操作权限。</p></div><form className="user-create-form" onSubmit={submit}><label><span>登录账号</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如 zhangsan" required /></label><label><span>初始密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" minLength={10} autoComplete="new-password" required /></label><label><span>账号角色</span><select value={role} onChange={(event) => setRole(event.target.value as UserRole)}><option value="developer">开发成员</option><option value="admin">管理员</option></select></label><button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建账号"}</button>{message && <div className="form-message success">{message}</div>}{error && <div className="form-message error">{error}</div>}</form></div><section className="user-list-card" aria-labelledby="user-list-title"><div className="section-head"><div><span className="section-kicker">TEAM ACCOUNTS</span><h2 id="user-list-title">现有账号</h2></div><span className="section-count">{users.length} 人</span></div><div className="user-table"><div className="user-table-head"><span>成员</span><span>角色</span><span>默认入口</span></div>{users.map((user) => <div className="user-row" key={user.username}><span className="user-cell"><i>{user.username.slice(0, 1).toUpperCase()}</i><strong>{user.username}</strong></span><span><em className={`role-chip ${user.role}`}>{user.role === "admin" ? "管理员" : "开发成员"}</em></span><span className="user-entry">{user.role === "admin" ? "团队总览" : "我的工作"}</span></div>)}</div></section></section>;
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
