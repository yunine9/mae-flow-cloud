import { useEffect, useMemo, useState } from "react";
import {
  listCollaborationAssignees,
  putTaskCollaborators,
  type CollaborationAssignee,
} from "./api";
import { userLabel } from "./UserPicker";

export function RequirementTeamPicker({
  taskId,
  owner,
  collaborators = [],
  onSaved,
}: {
  taskId: string;
  owner?: string;
  collaborators?: string[];
  onSaved?: () => void;
}) {
  const initial = useMemo(() => [...new Set(collaborators)],
    [taskId, collaborators.join("\0")]);
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const [selected, setSelected] = useState<string[]>(initial);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    setSelected(initial);
    setLoading(true);
    setError("");
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      const available = candidates.filter((candidate) =>
        candidate.username !== owner);
      const known = new Set(available.map((candidate) => candidate.username));
      // 账号后来被停用/删除时仍要让主责任人看见并移除，不能因为候选
      // 接口不再返回它，就把整个协作成员表永久锁死。
      for (const username of initial) {
        if (!known.has(username) && username !== owner) {
          available.push({
            username, ready: false, missing: ["账号已不可用"],
          });
        }
      }
      setPeople(available);
      setLoading(false);
    }).catch((cause) => {
      if (!alive) return;
      setError(cause instanceof Error ? cause.message : "协作成员读取失败");
      setLoading(false);
    });
    return () => { alive = false; };
  }, [taskId, owner, initial]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));
  const allReady = selected.every((username) =>
    peopleByName.get(username)?.ready === true);
  const shownPeople = people.filter((person) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${person.display_name ?? ""}\n${person.username}`
      .toLocaleLowerCase().includes(needle);
  });

  function toggle(username: string) {
    setSaved(false);
    setError("");
    setSelected((current) => current.includes(username)
      ? current.filter((account) => account !== username)
      : [...current, username]);
  }

  async function save() {
    if (loading || saving || !allReady) return;
    setSaving(true);
    setError("");
    try {
      await putTaskCollaborators(taskId, selected);
      setSaved(true);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "协作成员保存失败");
    } finally {
      setSaving(false);
    }
  }

  return <section className="requirement-team-picker" aria-label="主任务协作成员">
    <header>
      <div><span>MAIN TASK TEAM</span><strong>谁一起参与主任务</strong></div>
      <small>一位主责任人拍板，多位开发者共同澄清</small>
    </header>
    <div className="requirement-team-owner">
      <i aria-hidden>主</i>
      <span><strong>{owner ?? "本地主责任人"}</strong>
        <small>主责任人 · 最终确认、拆单和任务控制</small></span>
    </div>
    {!loading && people.length > 6 && <label className="requirement-team-search">
      <span>搜索成员</span>
      <input value={query} placeholder="输入姓名或工号"
        onChange={(event) => setQuery(event.target.value)} />
    </label>}
    <div className="requirement-team-members">
      {loading && <p>正在读取可邀请成员…</p>}
      {!loading && people.length === 0 && <p>当前没有其他可邀请的开发者。</p>}
      {shownPeople.map((person) => {
        const checked = selected.includes(person.username);
        return <label key={person.username}
          className={`${checked ? "selected" : ""}${person.ready ? "" : " unready"}`}>
          <input type="checkbox" checked={checked}
            disabled={saving || (!person.ready && !checked)}
            onChange={() => toggle(person.username)} />
          <span><strong>{userLabel(person)}</strong>
            <small>{person.ready ? "设置已就绪，可参与讨论"
              : `暂不可邀请 · 缺 ${person.missing.join("、")}`}</small></span>
        </label>;
      })}
    </div>
    {error && <p className="requirement-team-error" role="alert">{error}</p>}
    <footer>
      <p>共同开发者可送批注、补充材料并和 AI 讨论，但不能代替主责任人拍板。</p>
      <button type="button" disabled={loading || saving || !allReady}
        onClick={() => void save()}>
        {saving ? "正在保存…" : saved ? "协作成员已保存" : "保存并邀请参与"}
      </button>
    </footer>
  </section>;
}
