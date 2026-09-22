import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

export function KnowledgeCleanupOptions({ job, target, endpoint, disabled, onChange, onBlockedChange }: {
  job: DomainKnowledgeJob; target: KnowledgeRepository; endpoint: string; disabled?: boolean;
  onChange: (job: DomainKnowledgeJob) => void; onBlockedChange: (blocked: boolean) => void;
}) {
  const plan = job.cleanup_plans?.find(p => p.target_id === target.id);
  const applied = !!plan && [...job.publications, ...(job.publication_history ?? [])].some(p => p.cleanup_id === plan.id);
  const planPaths = [...new Set([...(plan?.directories ?? []), ...(plan?.agent ? [plan.agent.path] : [])])];
  const [enabled, setEnabled] = useState(!!plan && !applied);
  const [pathText, setPathText] = useState(planPaths.join("\n")), [rules, setRules] = useState(plan?.agent?.content ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const paths = [...new Set(pathText.split("\n").map(p => p.trim().replace(/\/$/, "")).filter(Boolean))];
  const agentPath = paths.find(path => /(^|\/)agents?\.md$/i.test(path));
  const newAgent = agentPath && rules.trim() ? { path: agentPath, content: rules } : undefined;
  const same = !!plan && JSON.stringify(paths) === JSON.stringify(planPaths)
    && (newAgent ? plan.agent?.path === newAgent.path && plan.agent?.content === newAgent.content : !plan.agent);
  const versions = job.documents.filter(d => d.selected && d.target_id === target.id).map(d => `${d.id}:${d.revision}:${d.path}`).sort();
  const current = same && JSON.stringify(versions) === JSON.stringify(plan?.document_versions);
  useEffect(() => { if (applied) setEnabled(false); }, [applied, plan?.id]);
  const blocked = busy || (applied ? enabled : enabled ? !current || !plan?.confirmed : !!plan?.confirmed);
  useEffect(() => { onBlockedChange(blocked); }, [blocked, onBlockedChange]);
  async function request(action: string, input: unknown) {
    setBusy(true); setError("");
    try { onChange(await componentRequest<DomainKnowledgeJob>(`${endpoint}/${action}`, input)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function toggleEnabled(value: boolean) {
    setEnabled(value);
    if (!value && plan?.confirmed && !applied) void request("cleanup-confirm", { plan_id: plan.id, confirmed: false });
  }
  const files = [...new Set([...(plan?.target_entries ?? []), ...(plan?.branch_entries ?? [])].map(e => e.path))];
  const preserved = plan?.preserve_paths ?? [];
  const selectedDocuments = job.documents.filter(d => d.selected && d.target_id === target.id);
  return <section className="space-y-3 rounded border border-line p-4" aria-label={`可选清理旧知识 ${target.name}`}>
    <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={enabled} disabled={disabled || busy} onChange={e => toggleEnabled(e.target.checked)} />提交前清理旧知识（可选） · {target.name}</label>
    <p className="text-sm text-muted-foreground">先删除选定的旧目录或文件，再写入本次新增内容，最后统一提交到同一个 MR。默认不清理。</p>
    {applied && <p className="text-sm text-primary">上次清理已提交，不会在后续更新中重复执行。</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {enabled && <>
      <label className="grid gap-1 text-sm">待删除路径（仓内目录或文件，每行一个）<Textarea aria-label={`待删除路径 ${target.id}`} rows={4} disabled={disabled || busy} value={pathText} onChange={e => setPathText(e.target.value)} placeholder={"docs/old-knowledge\nAGENTS.md"} /></label>
      {agentPath && <details className="space-y-3"><summary className="cursor-pointer text-sm">本次新增内容：{agentPath}（可选）</summary>
        <p className="text-sm text-muted-foreground">旧规范与其他旧文件一起删除。需要写入新规范时，在这里准备正文；留空则只删除旧规范。</p>
        <Button variant="outline" disabled={disabled || busy} onClick={async () => { setBusy(true); setError(""); try { const result = await componentRequest<{ content: string }>(`${endpoint}/cleanup-template`, { target_id: target.id, path: agentPath }); setRules(result.content); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>按当前知识生成新规范草稿</Button>
        <label className="grid gap-1 text-sm">新增规范正文<Textarea aria-label={`新规范正文 ${target.id}`} disabled={disabled || busy} rows={10} value={rules} onChange={e => setRules(e.target.value)} /></label>
      </details>}
      <Button variant="outline" disabled={disabled || busy || !paths.length} onClick={() => void request("cleanup-preview", { target_id: target.id, paths, ...(newAgent ? { agent: newAgent } : {}) })}>预览统一提交清单</Button>
    </>}
    {plan && !applied && enabled && <div className="space-y-3">
      <p className="text-sm">目标版本 {plan.target_revision.slice(0, 12)}。取消勾选可保留旧文件；同路径的新文档会在删除后重新写入。</p>
      <div className="max-h-56 space-y-2 overflow-auto rounded border border-line p-3 text-sm">
        <h5 className="font-medium">删除旧内容</h5>
        {files.map(path => <label key={path} className="flex items-start gap-2 break-all"><input type="checkbox" checked={!preserved.includes(path)} disabled={disabled || busy || !current || selectedDocuments.some(d => d.path === path)} onChange={e => void request("cleanup-confirm", { plan_id: plan.id, confirmed: false, preserve_paths: e.target.checked ? preserved.filter(p => p !== path) : [...preserved, path] })} />{preserved.includes(path) ? "保留" : "删除"} · {path}</label>)}
        {!files.length && <p>指定路径中没有旧文件。</p>}
        <h5 className="pt-2 font-medium">写入本次新增内容</h5>
        {selectedDocuments.map(doc => <p key={doc.id}>写入 · {doc.path}</p>)}
        {plan.agent && !preserved.includes(plan.agent.path) && <p>写入 · {plan.agent.path}</p>}
      </div>
      {plan.agent && !preserved.includes(plan.agent.path) && <details><summary>新旧规范差异</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(plan.agent.target_content ?? "", plan.agent.content).map((part, i) => <span key={i} className={part.added ? "bg-success/15 text-success" : part.removed ? "bg-danger/15 text-danger" : ""}>{part.value}</span>)}</pre>{plan.agent.branch_content != null && <details><summary>当前 MR 中的规范原文</summary><pre className="whitespace-pre-wrap break-words">{plan.agent.branch_content}</pre></details>}</details>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={disabled || busy || !current} checked={plan.confirmed} onChange={e => void request("cleanup-confirm", { plan_id: plan.id, confirmed: e.target.checked })} />确认以上删除和新增内容统一提交</label>
      {!current && <p className="text-sm text-muted-foreground">内容已调整，请重新预览清单。</p>}
    </div>}
    {!enabled && plan?.confirmed && !applied && <Button variant="outline" disabled={disabled || busy} onClick={() => void request("cleanup-confirm", { plan_id: plan.id, confirmed: false })}>取消已确认的清理</Button>}
  </section>;
}
