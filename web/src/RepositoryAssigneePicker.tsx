import { useEffect, useMemo, useRef, useState } from "react";
import {
  listCollaborationAssignees,
  type CollaborationAssignee,
} from "./api";
import { UserPicker } from "./UserPicker";
import { chainStages } from "./RequirementGraph";
import { Input } from "@/components/ui/input";
import "./module-assignment.css";

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

/** 无依赖不等于同时执行：展示必须尊重平台当前的同仓串行规则。 */
export function assignmentStageLabel(stage: ReadonlyArray<{ url: string }>, index: number): string {
  if (stage.length <= 1) return `第 ${index + 1} 步 · ${index === 0 ? "先做" : "接着做"}`;
  const repositories = new Set(stage.map((item) => item.url));
  return `第 ${index + 1} 组 · ${repositories.size === 1 ? "同仓依次执行"
    : repositories.size < stage.length ? "不同仓可并行" : "可并行"}`;
}

export function RepositoryAssigneePicker({
  taskId,
  repositories,
  defaultAssignee,
  defaultTicket,
  selection,
  onSelectionChange,
  saveState = "idle",
  dependencies = [],
  onOpenStory,
  onOpenModule,
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
  saveState?: "idle" | "saving" | "saved" | "error";
  dependencies?: Array<{ from: string; to: string; reason?: string }>;
  onOpenStory?: () => void;
  onOpenModule?: (id: string) => void;
}) {
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const draftKey = JSON.stringify([taskId, repositories.map((item) => [item.id, item.url])]);
  const edits = useRef({ key: draftKey, assignments: {} as Record<string, string>, tickets: {} as Record<string, string> });
  const assignmentKey = repositories.map((item) =>
    `${item.id}:${item.assignee ?? ""}:${item.ticket ?? ""}`).join("\0");
  const initialAssignments = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.assignee ?? defaultAssignee ?? "",
    ]),
  ), [taskId, assignmentKey, defaultAssignee]);
  // 一仓拆成多单元时仍在这张卡上逐单元确认 AR；多个串行单元可以
  // 共用同一 AR。只有一仓一单元的老路才沿用下单时填的单号。
  const splitUrls = new Set(repositories.map((item) => item.url)
    .filter((url, index, urls) => urls.indexOf(url) !== index));
  const initialTickets = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.ticket ?? (splitUrls.has(repository.url) ? "" : defaultTicket ?? ""),
    ]),
  ), [taskId, assignmentKey, defaultTicket]);

  type Unit = typeof repositories[number];
  const unitLabel = (unit: Unit) => unit.scope?.name
    ? `${unit.name} · ${unit.scope.name}` : unit.name;
  const ticketsReady = (
    tickets: Record<string, string>,
  ) => repositories.every((repository) => {
      const value = tickets[repository.id]?.trim() ?? "";
      return Boolean(value) && !/\s/.test(value);
    });

  useEffect(() => {
    let alive = true;
    if (edits.current.key !== draftKey) edits.current = { key: draftKey, assignments: {}, tickets: {} };
    // Polling can echo an earlier autosave while typing. Keep local edits, including
    // an intentionally empty field, and also merge edits made while people load.
    const currentDraft = () => ({
      assignments: { ...initialAssignments, ...edits.current.assignments },
      tickets: { ...initialTickets, ...edits.current.tickets },
    });
    onSelectionChange({ ...currentDraft(),
      ready: false, loading: true });
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      setPeople(candidates);
      const byName = new Map(candidates.map((candidate) =>
        [candidate.username, candidate]));
      const draft = currentDraft();
      const ready = repositories.every((repository) =>
        byName.get(draft.assignments[repository.id])?.ready === true)
        && ticketsReady(draft.tickets);
      onSelectionChange({ ...draft,
        ready, loading: false });
    }).catch((cause) => {
      if (!alive) return;
      onSelectionChange({
        ...currentDraft(),
        ready: false,
        loading: false,
        error: cause instanceof Error ? cause.message : "责任人状态读取失败",
      });
    });
    return () => { alive = false; };
  }, [draftKey, initialAssignments, initialTickets]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));
  function chooseAssignee(repositoryId: string, value: string) {
    edits.current.assignments[repositoryId] = value;
    const nextAssignments = { ...selection.assignments, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(nextAssignments[repository.id])?.ready === true)
      && ticketsReady(selection.tickets);
    onSelectionChange({ ...selection, assignments: nextAssignments, ready,
      error: undefined });
  }

  function chooseTicket(repositoryId: string, value: string) {
    edits.current.tickets[repositoryId] = value;
    const nextTickets = { ...selection.tickets, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(selection.assignments[repository.id])?.ready === true)
      && ticketsReady(nextTickets);
    onSelectionChange({ ...selection, tickets: nextTickets, ready,
      error: undefined });
  }

  const stages = chainStages({ repositories, dependencies });
  return <section className="repository-assignees module-assignment" aria-label="任务分工">
    <header>
      <div><strong>任务分工</strong></div>
      {onOpenStory && <button type="button" onClick={onOpenStory}>查看完整方案</button>}
    </header>
    <div className="module-assignment-stages">
      {stages.map((stage, stageIndex) => <section key={stageIndex} className="module-assignment-stage">
        <h4>{assignmentStageLabel(stage, stageIndex)}</h4>
      {stage.map((repository) => {
        const selected = selection.assignments[repository.id] ?? "";
        const person = peopleByName.get(selected);
        const ticket = selection.tickets[repository.id] ?? "";
        const ticketProblem = !ticket.trim() ? "缺少 AR 单号"
          : /\s/.test(ticket.trim()) ? "AR 单号无效" : "";
        const rowLabel = unitLabel(repository);
        const prerequisites = dependencies.filter((edge) => edge.from === repository.id);
        // 兼容旧的三项摘要，只取完整“做什么”一句；冗长技术原文留在 Story，
        // 不截出半句话冒充摘要，也不在决策卡再次展开整段实现说明。
        const brief = repository.responsibility?.split(/\r?\n/).find((line) => line.trim())
          ?.replace(/^\s*[-*]\s*(?:做什么[：:]\s*)?/, "").trim();
        return <article key={repository.id} className="module-assignment-unit">
          <header><div className="module-assignment-title"><strong>{repository.scope?.name ?? repository.name}</strong>
            {onOpenModule && <button type="button" aria-label={`查看${repository.scope?.name ?? repository.name}详情`}
              onClick={() => onOpenModule(repository.id)}>查看详情 ↗</button>}
          </div><small>仓库：{repository.name}</small></header>
          {brief && brief.length <= 160 && <p className="module-assignment-brief">{brief}</p>}
          {prerequisites.length > 0 && <div className="module-assignment-dependency">
            {prerequisites.map((edge) => {
              const prerequisite = repositories.find((item) => item.id === edge.to);
              return <p key={edge.to}>等待「{prerequisite?.scope?.name ?? prerequisite?.name ?? edge.to}」
                完成</p>;
            })}
          </div>}
          <div className="module-assignment-fields">
          <div className="repository-assignee-editable">
            <small>负责人</small>
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
          </div>
          <label className="repository-ticket-editable">
            <small>任务单号</small>
            <Input type="text" className="min-h-[34px] font-mono text-xs font-semibold" value={ticket}
              aria-label={`${rowLabel}的 AR 单号`}
              aria-invalid={Boolean(ticketProblem)}
              placeholder="例如：REQ2026xxxx"
              onChange={(event) => chooseTicket(repository.id, event.target.value)} />
          </label>
          </div>
          <em className={person?.ready && !ticketProblem ? "ready" : "missing"}>
            {ticketProblem || (person?.ready ? "可委派"
              : person ? `未就绪：${person.missing.join("、")}` : "待选择")}
          </em>
        </article>;
      })}</section>)}
    </div>
    {selection.error && <p className="repository-assignee-error">
      {selection.error}
    </p>}
    <footer>
      <p>负责人和单号的修改会自动保存。</p>
      <small className={`repository-assignee-save ${saveState}`}>
        {saveState === "saving" ? "正在保存…"
          : saveState === "saved" ? "已自动保存"
          : saveState === "error" ? "保存失败，请继续编辑后重试" : ""}
      </small>
    </footer>
  </section>;
}
