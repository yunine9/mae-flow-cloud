import { useEffect, useMemo, useState } from "react";
import {
  listCollaborationAssignees,
  type CollaborationAssignee,
} from "./api";

export interface RepositoryAssigneeSelection {
  assignments: Record<string, string>;
  tickets: Record<string, string>;
  ready: boolean;
  loading: boolean;
  error?: string;
}

export const EMPTY_REPOSITORY_ASSIGNEE_SELECTION: RepositoryAssigneeSelection = {
  assignments: {}, tickets: {}, ready: false, loading: true,
};

export function RepositoryAssigneePicker({
  taskId,
  repositories,
  defaultAssignee,
  defaultTicket,
  selection,
  onSelectionChange,
}: {
  taskId: string;
  repositories: Array<{
    id: string; name: string; url: string; responsibility?: string;
    assignee?: string; ticket?: string;
  }>;
  defaultAssignee?: string;
  defaultTicket?: string;
  selection: RepositoryAssigneeSelection;
  onSelectionChange: (selection: RepositoryAssigneeSelection) => void;
}) {
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const assignmentKey = repositories.map((item) =>
    `${item.id}:${item.assignee ?? ""}:${item.ticket ?? ""}`).join("\0");
  const initialAssignments = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.assignee ?? defaultAssignee ?? "",
    ]),
  ), [taskId, assignmentKey, defaultAssignee]);
  const initialTickets = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.ticket ?? defaultTicket ?? "",
    ]),
  ), [taskId, assignmentKey, defaultTicket]);

  const ticketsReady = (tickets: Record<string, string>) =>
    repositories.every((repository) => {
      const value = tickets[repository.id]?.trim() ?? "";
      return Boolean(value) && !/\s/.test(value);
    });

  useEffect(() => {
    let alive = true;
    onSelectionChange({ assignments: initialAssignments, tickets: initialTickets,
      ready: false, loading: true });
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      setPeople(candidates);
      const byName = new Map(candidates.map((candidate) =>
        [candidate.username, candidate]));
      const ready = repositories.every((repository) =>
        byName.get(initialAssignments[repository.id])?.ready === true)
        && ticketsReady(initialTickets);
      onSelectionChange({ assignments: initialAssignments, tickets: initialTickets,
        ready, loading: false });
    }).catch((cause) => {
      if (!alive) return;
      onSelectionChange({
        assignments: initialAssignments,
        tickets: initialTickets,
        ready: false,
        loading: false,
        error: cause instanceof Error ? cause.message : "责任人状态读取失败",
      });
    });
    return () => { alive = false; };
  }, [taskId, initialAssignments, initialTickets]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));

  return <section className="repository-assignees" aria-label="逐仓交付信息">
    <header>
      <div><span>跨仓协作</span><strong>逐仓分工</strong></div>
      <small>责任人与 AR 单号均已在发起任务时确定</small>
    </header>
    <div className="repository-assignee-list">
      {repositories.map((repository) => {
        const selected = selection.assignments[repository.id] ?? "";
        const person = peopleByName.get(selected);
        const ticket = selection.tickets[repository.id] ?? "";
        const ticketProblem = !ticket.trim() ? "缺少 AR 单号"
          : /\s/.test(ticket.trim()) ? "AR 单号无效" : "";
        return <label key={repository.id}>
          <span><strong>{repository.name}</strong>
            <small>{repository.responsibility ?? repository.url}</small></span>
          <span className="repository-assignee-readonly">
            <small>责任人</small><strong>{selected || "未指定"}</strong>
          </span>
          <span className="repository-ticket-readonly"
            title="AR 单号来自发起任务时填写的逐仓信息">
            <small>AR 单号</small><strong>{ticket || "未填写"}</strong>
          </span>
          <em className={person?.ready && !ticketProblem ? "ready" : "missing"}>
            {ticketProblem || (person?.ready ? "可委派"
              : person ? `未就绪：${person.missing.join("、")}` : "待选择")}
          </em>
        </label>;
      })}
    </div>
    {selection.error && <p className="repository-assignee-error">
      {selection.error}
    </p>}
    <footer>
      <p>确认方案后，系统会按上面的责任人、单号和依赖关系直接生成各仓子任务。</p>
    </footer>
  </section>;
}
