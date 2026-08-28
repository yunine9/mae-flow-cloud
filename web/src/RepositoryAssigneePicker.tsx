import { useEffect, useMemo, useState } from "react";
import {
  listCollaborationAssignees,
  putRepositoryAssignees,
  type CollaborationAssignee,
} from "./api";

export interface RepositoryAssigneeSelection {
  assignments: Record<string, string>;
  ready: boolean;
  loading: boolean;
  error?: string;
}

export const EMPTY_REPOSITORY_ASSIGNEE_SELECTION: RepositoryAssigneeSelection = {
  assignments: {}, ready: false, loading: true,
};

export function RepositoryAssigneePicker({
  taskId,
  repositories,
  defaultAssignee,
  selection,
  onSelectionChange,
  onSaved,
}: {
  taskId: string;
  repositories: Array<{
    id: string; name: string; url: string; responsibility?: string;
    assignee?: string;
  }>;
  defaultAssignee?: string;
  selection: RepositoryAssigneeSelection;
  onSelectionChange: (selection: RepositoryAssigneeSelection) => void;
  onSaved?: () => void;
}) {
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const assignmentKey = repositories.map((item) =>
    `${item.id}:${item.assignee ?? ""}`).join("\0");
  const initialAssignments = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.assignee ?? defaultAssignee ?? "",
    ]),
  ), [taskId, assignmentKey, defaultAssignee]);

  useEffect(() => {
    let alive = true;
    onSelectionChange({ assignments: initialAssignments, ready: false, loading: true });
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      setPeople(candidates);
      const byName = new Map(candidates.map((candidate) =>
        [candidate.username, candidate]));
      const ready = repositories.every((repository) =>
        byName.get(initialAssignments[repository.id])?.ready === true);
      onSelectionChange({ assignments: initialAssignments, ready, loading: false });
    }).catch((cause) => {
      if (!alive) return;
      onSelectionChange({
        assignments: initialAssignments,
        ready: false,
        loading: false,
        error: cause instanceof Error ? cause.message : "责任人状态读取失败",
      });
    });
    return () => { alive = false; };
  }, [taskId, initialAssignments]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));

  function choose(repositoryId: string, account: string) {
    const assignments = { ...selection.assignments, [repositoryId]: account };
    const ready = repositories.every((repository) =>
      peopleByName.get(assignments[repository.id])?.ready === true);
    setSaved(false);
    setSaveError("");
    onSelectionChange({ assignments, ready, loading: false });
  }

  async function save() {
    if (!selection.ready || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await putRepositoryAssignees(taskId, selection.assignments);
      setSaved(true);
      onSaved?.();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "分工保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <section className="repository-assignees" aria-label="逐仓责任人">
    <header>
      <div><span>跨仓协作</span><strong>每个仓由谁负责</strong></div>
      <small>只有个人开发设置就绪的成员可以接活</small>
    </header>
    <div className="repository-assignee-list">
      {repositories.map((repository) => {
        const selected = selection.assignments[repository.id] ?? "";
        const person = peopleByName.get(selected);
        return <label key={repository.id}>
          <span><strong>{repository.name}</strong>
            <small>{repository.responsibility ?? repository.url}</small></span>
          <select value={selected} disabled={selection.loading || saving}
            onChange={(event) => choose(repository.id, event.target.value)}>
            <option value="">选择责任人</option>
            {people.map((candidate) => <option key={candidate.username}
              value={candidate.username} disabled={!candidate.ready}>
              {candidate.username}{candidate.ready
                ? " · 已就绪" : ` · 缺 ${candidate.missing.join("、")}`}
            </option>)}
          </select>
          <em className={person?.ready ? "ready" : "missing"}>
            {person?.ready ? "可委派"
              : person ? `未就绪：${person.missing.join("、")}` : "待选择"}
          </em>
        </label>;
      })}
    </div>
    {(selection.error || saveError) && <p className="repository-assignee-error">
      {selection.error || saveError}
    </p>}
    <footer>
      <p>先保存，责任人即可进入主任务一起补充意见；最终拆分仍由主责人确认。</p>
      <button type="button" disabled={!selection.ready || saving}
        onClick={() => void save()}>
        {saving ? "正在保存…" : saved ? "分工已保存" : "保存分工并邀请协作"}
      </button>
    </footer>
  </section>;
}
