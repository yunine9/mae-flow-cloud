import { useEffect, useMemo, useState } from "react";
import {
  listCollaborationAssignees,
  type CollaborationAssignee,
} from "./api";
import { UserPicker } from "./UserPicker";

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
    scope?: { name: string; paths: string[] };
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
  // 同一个 url 出现多行 = 该仓拆成了多个交付单元。这用于判断旧任务
  // 的单号是否也必须逐行补录；执行人无论几仓都只在最终单元形成后选。
  const urlRowCounts = new Map<string, number>();
  for (const repository of repositories) {
    urlRowCounts.set(repository.url,
      (urlRowCounts.get(repository.url) ?? 0) + 1);
  }
  const isUnitRow = (repository: { url: string }) =>
    (urlRowCounts.get(repository.url) ?? 0) > 1;
  const hasDeliveryUnits = repositories.some(isUnitRow);
  // 下单免了单号的分析单(或旧图缺单号):节点没有可继承的单号,
  // 只读展示会把人永远卡在"缺少 AR 单号"上,必须给输入框。
  const needsTicketEntry = hasDeliveryUnits || repositories.some(
    (repository) => !(selection.tickets[repository.id] ?? "").trim());

  function chooseAssignee(repositoryId: string, value: string) {
    const nextAssignments = { ...selection.assignments, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(nextAssignments[repository.id])?.ready === true)
      && ticketsReady(selection.tickets);
    onSelectionChange({ ...selection, assignments: nextAssignments, ready });
  }

  function chooseTicket(repositoryId: string, value: string) {
    const nextTickets = { ...selection.tickets, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(selection.assignments[repository.id])?.ready === true)
      && ticketsReady(nextTickets);
    onSelectionChange({ ...selection, tickets: nextTickets, ready });
  }

  return <section className="repository-assignees" aria-label="交付单元安排">
    <header>
      <div><span>DELIVERY UNITS</span><strong>拆分后怎么执行</strong></div>
      <small>{needsTicketEntry
        ? "按最终交付单元选择执行人并补齐 AR 单号"
        : "按最终交付单元选择执行人；AR 单号沿用已有信息"}</small>
    </header>
    <div className="repository-assignee-list">
      {repositories.map((repository) => {
        const selected = selection.assignments[repository.id] ?? "";
        const person = peopleByName.get(selected);
        const ticket = selection.tickets[repository.id] ?? "";
        const ticketProblem = !ticket.trim() ? "缺少 AR 单号"
          : /\s/.test(ticket.trim()) ? "AR 单号无效" : "";
        const rowLabel = repository.scope?.name
          ? `${repository.name} · ${repository.scope.name}` : repository.name;
        return <label key={repository.id}>
          <span><strong>{rowLabel}</strong>
            <small>{repository.responsibility ?? repository.url}</small></span>
          <span className="repository-assignee-editable">
            <small>该单元的执行人</small>
            <UserPicker value={selected}
              ariaLabel={`${rowLabel}的执行人`}
              emptyLabel="请选择执行人"
              onChange={(username) => chooseAssignee(repository.id, username)}
              options={[...new Set([selected,
                ...people.map((person) => person.username)])]
                .filter(Boolean).map((name) => {
                  const candidate = peopleByName.get(name);
                  return {
                    username: name,
                    display_name: candidate?.display_name,
                    disabled: candidate ? !candidate.ready : false,
                    detail: candidate && !candidate.ready
                      ? `未就绪：${candidate.missing.join("、")}` : undefined,
                  };
                })} />
          </span>
          {(isUnitRow(repository) || !ticket.trim())
            ? <span className="repository-ticket-editable">
            <small>该单元的 AR 单号</small>
            <input value={ticket}
              aria-label={`${rowLabel}的 AR 单号`}
              placeholder="例如：REQ2026xxxx"
              onChange={(event) => chooseTicket(repository.id, event.target.value)} />
          </span> : <span className="repository-ticket-readonly"
            title="AR 单号来自发起任务时填写的逐仓信息">
            <small>AR 单号</small><strong>{ticket || "未填写"}</strong>
          </span>}
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
      <p>{hasDeliveryUnits
        ? "为每个单元选定执行人并填写 AR 单号（同仓同执行人的单元不能同号）；确认后将按依赖顺序生成子任务。"
        : needsTicketEntry
          ? "为每个单元选定执行人并填写各自的 AR 单号；确认后将按依赖顺序生成子任务。"
          : "确认方案后，系统会按上面的执行人、单号和依赖关系生成交付任务。"}</p>
    </footer>
  </section>;
}
