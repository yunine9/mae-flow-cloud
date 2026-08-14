/**
 * 应用骨架:顶栏(品牌 + 分段导航)+ 两个视图。
 * 「任务」= 发起 + 活任务列表(1.5s 轮询,事件明细走 SSE);
 * 「历史看板」= PG 投影的跨生命周期回望(HistoryBoard)。
 * 无路由库:视图是 useState,刷新回到任务视图即可,不值得引依赖。
 */

import { useEffect, useState } from "react";
import { createTask, listTasks, type TaskSummary } from "./api";
import { TaskCard } from "./TaskCard";
import { HistoryBoard } from "./HistoryBoard";

export function App() {
  const [view, setView] = useState<"tasks" | "history">("tasks");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [requirement, setRequirement] = useState("");
  const [account, setAccount] = useState("");

  async function refresh() {
    setTasks(await listTasks().catch(() => []));
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!requirement.trim()) return;
    await createTask(requirement.trim(), account.trim() || undefined);
    setRequirement("");
    void refresh();
  }

  // 活任务里等人的数量:导航角标,人该被叫到的地方要有信号。
  const waitingCount =
    tasks.filter((task) => task.status === "waiting_for_human").length;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="brand-mark">◆</span> Mae-Flow 云端
          </span>
          <nav className="nav" aria-label="视图切换">
            <button
              className={view === "tasks" ? "on" : ""}
              onClick={() => setView("tasks")}
            >
              任务
              {waitingCount > 0 && (
                <span className="nav-badge">{waitingCount}</span>
              )}
            </button>
            <button
              className={view === "history" ? "on" : ""}
              onClick={() => setView("history")}
            >
              历史看板
            </button>
          </nav>
        </div>
      </header>
      <main>
        {view === "tasks" && (
          <>
            <form className="composer" onSubmit={submit}>
              <input
                type="text"
                className="requirement"
                value={requirement}
                onChange={(change) => setRequirement(change.target.value)}
                placeholder="用一句话描述需求,例如:交付 REQ2026xxxx …"
                required
              />
              <input
                type="text"
                className="account"
                value={account}
                onChange={(change) => setAccount(change.target.value)}
                placeholder="小鲁班账号(可选)"
              />
              <button type="submit">发起任务</button>
            </form>
            {tasks.length === 0 && (
              <div className="empty">
                <span className="glyph">◇</span>
                还没有任务——上面发起一个试试。
              </div>
            )}
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} onChanged={refresh} />
            ))}
          </>
        )}
        {view === "history" && <HistoryBoard />}
      </main>
    </>
  );
}
