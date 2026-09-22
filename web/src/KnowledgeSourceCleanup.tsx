import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeSourceCleanupState, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

export function KnowledgeSourceCleanup<T extends { source_cleanup?: KnowledgeSourceCleanupState }>({ task, endpoint, onChange, onStarted }: {
  task: T; endpoint: string; onChange: (task: T) => void; onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const state = task.source_cleanup;
  const [paths, setPaths] = useState<Record<string, string>>(() => Object.fromEntries((state?.repositories ?? []).map(repo => [repo.id, `${repo.docs_path}\nAGENTS.md`])));
  if (!state) return <p className="rounded border border-line p-4 text-sm">此历史任务没有萃取前清理记录。需要重新研究时，请新建任务，避免沿用旧草稿。</p>;
  async function request(action: string, body: unknown = {}) {
    setBusy(true); setError("");
    try { onChange(await componentRequest<T>(`${endpoint}/source-cleanup/${action}`, body)); if (action === "start") onStarted(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const pathsByTarget = Object.fromEntries(state.repositories.map(repo => [repo.id, paths[repo.id]?.split("\n").map(path => path.trim().replace(/\/$/, "")).filter(Boolean) ?? []]));
  const hasPendingRepository = state.repositories.some(repo => !state.publications.some(publication => publication.target_id === repo.id && (publication.url || publication.state === "unchanged")));
  const ready = !busy && hasPendingRepository && Object.values(pathsByTarget).every(paths => paths.length > 0);
  return <section className="space-y-4" aria-label="萃取前清理旧知识">
    <div className="rounded-lg border border-line bg-surface-2 p-4"><h3 className="font-semibold">清理旧知识</h3><p className="mt-2 text-sm text-muted-foreground">填写各仓需要删除的目录或文件后，一次创建所有清理 MR。MR 合入由仓库流程处理；完成后手动开始萃取。新知识在萃取完成后另建归档 MR。</p></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {state.repositories.map(repo => <RepositoryCleanup key={repo.id} repo={repo} publication={state.publications.find(p => p.target_id === repo.id)} disabled={busy || state.started || !!state.publications.find(p => p.target_id === repo.id)?.url} paths={paths[repo.id] ?? ""} onPathsChange={value => setPaths(current => ({ ...current, [repo.id]: value }))} />)}
    {state.started ? <p className="text-sm text-primary">已手动启动研究，将读取基准分支最新代码。需要重新清理和萃取时，请新建任务。</p> : <div className="flex flex-wrap gap-3">
      <Button variant="outline" disabled={!ready} onClick={() => void request("publish", { paths_by_target: pathsByTarget })}>{busy ? "正在创建…" : "一键创建所有清理 MR"}</Button>
      <Button disabled={busy} onClick={() => void request("start")}>{busy ? "处理中…" : "开始萃取"}</Button>
    </div>}
    {!state.started && !ready && <p role="status" className="text-sm text-muted-foreground">请为每个仓填写至少一条清理路径。</p>}
    {!state.started && <p className="text-sm text-muted-foreground">开始时重新拉取基准分支，不校验 MR 状态，不自动合并或等待流水线。</p>}
  </section>;
}
function RepositoryCleanup({ repo, publication, disabled, paths, onPathsChange }: { repo: KnowledgeRepository; publication?: KnowledgeSourceCleanupState["publications"][number]; disabled: boolean; paths: string; onPathsChange: (value: string) => void }) {
  return <details open={!publication?.url} className="rounded-lg border border-line p-4">
    <summary className="cursor-pointer font-medium">{repo.name} · {publication?.url ? "清理 MR 已创建" : publication?.state === "unchanged" ? "没有匹配的旧文件" : publication?.state === "failed" ? "创建失败，可再次一键创建" : "待创建"}</summary>
    <p className="my-3 break-all text-sm text-muted-foreground">{repo.repository} · {repo.branch}</p>
    {publication?.url && <a className="text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看清理 MR ↗</a>}
    {publication?.error && <p role="alert" className="my-2 text-danger">{publication.error}</p>}
    <label className="mt-3 grid gap-2 text-sm">待删除路径（目录或文件，每行一个）<Textarea aria-label={`萃取前待删除路径 ${repo.id}`} rows={3} disabled={disabled} value={paths} onChange={e => onPathsChange(e.target.value)} /><span className="text-muted-foreground">默认包含知识目录和 AGENTS.md；按仓内实际旧知识调整。</span></label>
  </details>;
}
