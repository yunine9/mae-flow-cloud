/**
 * 任务看板:顶栏 + 发起 + 列表。1.5s 轮询任务列表(与演示页同款
 * 节奏);事件明细走 SSE(TaskCard 里按需建流)。
 */

import { useEffect, useState } from "react";
import { createTask, listTasks, type TaskSummary } from "./api";
import { TaskCard } from "./TaskCard";
import { HistoryPanel } from "./HistoryPanel";

export function App() {
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

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="brand-mark">◆</span> Mae-Flow 云端
          </span>
          <span className="brand-sub">发任务 · 看进度 · 点审批</span>
        </div>
      </header>
      <main>
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
        <HistoryPanel />
      </main>
    </>
  );
}
