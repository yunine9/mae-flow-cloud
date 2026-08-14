/**
 * 任务看板:列表 + 发起。1.5s 轮询任务列表(与演示页同款节奏);
 * 事件明细走 SSE(TaskCard 里按需建流)。
 */

import { useEffect, useState } from "react";
import { createTask, listTasks, type TaskSummary } from "./api";
import { TaskCard } from "./TaskCard";

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
    <main>
      <h1>Mae-Flow 云端任务</h1>
      <form onSubmit={submit}>
        <input
          type="text"
          value={requirement}
          onChange={(change) => setRequirement(change.target.value)}
          placeholder="用一句话描述需求,例如:交付 REQ2026xxxx …"
          required
        />
        <input
          type="text"
          value={account}
          onChange={(change) => setAccount(change.target.value)}
          placeholder="小鲁班账号(可选)"
          className="account"
        />
        <button type="submit">发起任务</button>
      </form>
      {tasks.length === 0 && (
        <p className="muted">还没有任务。上面发起一个试试。</p>
      )}
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} onChanged={refresh} />
      ))}
    </main>
  );
}
