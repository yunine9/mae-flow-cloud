import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeSourceCleanupState, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

export function KnowledgeSourceCleanup<T extends { source_cleanup?: KnowledgeSourceCleanupState }>({ task, endpoint, onChange, onStarted }: {
  task: T; endpoint: string; onChange: (task: T) => void; onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const guidanceId = useId();
  const state = task.source_cleanup;
  if (!state) return <p className="rounded border border-line p-4 text-sm">此历史任务没有萃取前清理记录。需要重新研究时，请新建任务，避免沿用旧草稿。</p>;
  async function request(action: string, body: unknown = {}) {
    setBusy(true); setError("");
    try { onChange(await componentRequest<T>(`${endpoint}/source-cleanup/${action}`, body)); if (action === "start") onStarted(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const unsubmitted = state.plans.filter(p => !state.publications.some(pub => pub.target_id === p.target_id && (pub.url || pub.state === "unchanged")));
  const pending = unsubmitted.filter(p => p.confirmed);
  const changed = pending.filter(p => blocked[p.target_id]);
  const canPublish = !busy && pending.length > 0 && !changed.length;
  const guidance = busy ? "正在处理当前操作，请稍候。"
    : changed.length ? `${changed.map(p => state.repositories.find(r => r.id === p.target_id)?.name ?? p.target_id).join("、")}的路径已修改，请重新预览并确认删除清单。`
    : pending.length ? `已确认 ${pending.length} 个仓的清理清单，可以创建清理 MR；其他仓不受影响。`
    : unsubmitted.length ? "已生成预览，请在需要清理的仓库下勾选「确认删除以上文件，其余文件保留」，即可创建清理 MR。"
    : state.publications.length ? "已有清理范围已处理，可展开仓库查看结果；清理其他仓时，请先预览并确认删除清单。"
    : "先展开需要清理的仓库，填写路径并点击「预览将删除的文件」，再核对并勾选确认删除，即可创建清理 MR。";
  return <section className="space-y-4" aria-label="萃取前清理旧知识">
    <div className="rounded-lg border border-line bg-surface-2 p-4"><h3 className="font-semibold">清理旧知识</h3><p className="mt-2 text-sm text-muted-foreground">有旧知识时，先按仓选择目录或文件，创建清理 MR。请在仓库中完成审查和合入，再手动开始萃取；无需清理时可直接开始。新知识在萃取完成后另建归档 MR。</p></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {state.repositories.map(repo => <RepositoryCleanup key={repo.id} repo={repo} state={state} busy={busy} request={request} onBlocked={value => setBlocked(old => old[repo.id] === value ? old : { ...old, [repo.id]: value })} />)}
    {state.started ? <p className="text-sm text-primary">已手动启动研究，将读取基准分支最新代码。需要重新清理和萃取时，请新建任务。</p> : <div className="flex flex-wrap gap-3">
      <Button variant="outline" aria-describedby={guidanceId} disabled={!canPublish} onClick={() => void request("publish")}>创建清理 MR</Button>
      <Button disabled={busy} onClick={() => void request("start")}>{busy ? "处理中…" : "开始萃取"}</Button>
    </div>}
    {!state.started && <p id={guidanceId} role="status" className="text-sm text-muted-foreground">{guidance}</p>}
    {!state.started && <p className="text-sm text-muted-foreground">开始时重新拉取基准分支，不校验 MR 状态，不自动合并或等待流水线。</p>}
  </section>;
}
function RepositoryCleanup({ repo, state, busy, request, onBlocked }: { onBlocked: (blocked: boolean) => void; repo: KnowledgeRepository; state: KnowledgeSourceCleanupState; busy: boolean; request: (action: string, body: unknown) => Promise<void> }) {
  const plan = state.plans.find(p => p.target_id === repo.id), publication = state.publications.find(p => p.target_id === repo.id);
  const [paths, setPaths] = useState(plan?.directories.join("\n") ?? `${repo.docs_path}\nAGENTS.md`);
  const selectedPaths = [...new Set(paths.split("\n").map(p => p.trim().replace(/\/$/, "")).filter(Boolean))];
  const same = !!plan && JSON.stringify(plan.directories) === JSON.stringify(selectedPaths);
  useEffect(() => { onBlocked(!same); }, [same, onBlocked]);
  const locked = busy || state.started || !!publication?.mr_attempted || !!publication?.url;
  const preserved = plan?.preserve_paths ?? [];
  return <details open={repo.id === state.repositories[0]?.id && !state.started && !publication?.url} className="rounded-lg border border-line p-4">
    <summary className="cursor-pointer font-medium">{repo.name} · {publication?.url ? "清理 MR 已创建" : publication?.state === "unchanged" ? "没有待删除文件" : publication?.state === "failed" ? "提交失败，可重试" : plan && !same ? "路径已修改，需重新预览" : plan?.confirmed ? "清单已确认" : plan ? "待确认删除清单" : "可选清理"}</summary>
    <p className="my-3 break-all text-sm text-muted-foreground">{repo.repository} · {repo.branch}</p>
    {publication?.url && <a className="text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看清理 MR ↗</a>}
    {publication?.error && <p role="alert" className="my-2 text-danger">{publication.error}</p>}
    {!state.started && <div className="mt-3 space-y-3">
      <label className="grid gap-2 text-sm">待删除路径（目录或文件，每行一个）<Textarea aria-label={`萃取前待删除路径 ${repo.id}`} rows={3} disabled={locked} value={paths} onChange={e => setPaths(e.target.value)} /><span className="text-muted-foreground">以上仅为建议，请改成仓内实际的旧知识目录；可包含 AGENTS.md、agent.md。</span></label>
      <Button variant="outline" disabled={locked || !selectedPaths.length} onClick={() => void request("preview", { target_id: repo.id, paths: selectedPaths })}>预览将删除的文件</Button>
    </div>}
    {plan && <div className="mt-3 space-y-3 text-sm">
      <p>预览版本 {plan.target_revision.slice(0, 12)} · 删除 {plan.target_entries.length - preserved.length} 个文件 · 保留 {preserved.length} 个文件</p>
      <details><summary className="cursor-pointer">展开清理文件清单（{plan.target_entries.length}）</summary><div className="mt-2 max-h-56 space-y-2 overflow-auto rounded border border-line p-3">{plan.target_entries.map(file => <label key={file.path} className="flex items-start gap-2 break-all"><input type="checkbox" checked={!preserved.includes(file.path)} disabled={locked || !same} onChange={e => void request("confirm", { plan_id: plan.id, confirmed: false, preserve_paths: e.target.checked ? preserved.filter(p => p !== file.path) : [...preserved, file.path] })} />{preserved.includes(file.path) ? "保留" : "删除"} · {file.path}</label>)}{!plan.target_entries.length && <p>本次没有待删除文件。</p>}</div></details>
      {!state.started && <label className="flex items-center gap-2"><input type="checkbox" checked={plan.confirmed && same} disabled={locked || !same} onChange={e => void request("confirm", { plan_id: plan.id, confirmed: e.target.checked })} />确认删除以上文件，其余文件保留</label>}
      {!same && !state.started && <p className="text-muted-foreground">路径已修改，请重新预览并确认。</p>}
    </div>}
  </details>;
}
