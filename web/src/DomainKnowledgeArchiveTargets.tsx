import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";
import { readableDomainKnowledgeDirectory, repositoryKnowledgeDirectory, repairModuleKnowledgePath, hasOpaqueModuleDirectory } from "../../src/domainKnowledgeLayout";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const confirmedDeletion = (document: DomainKnowledgeJob["documents"][number]) => !!document.deleted && !!document.knowledge_document_id && document.published_document_revision === document.revision;
function initialTargets(job: DomainKnowledgeJob) {
  const title = job.module_name || job.title;
  return targetsOf(job).map(target => {
    if (job.component_research_id) return { ...target };
    if (target.id !== job.knowledge_target.id) return { ...target, docs_path: job.knowledge_layout === "repository-v1" && !hasOpaqueModuleDirectory(target.docs_path) ? target.docs_path : "." };
    const old = target.docs_path.replace(/\/$/, "");
    const cleaned = readableDomainKnowledgeDirectory(old, job.module_id, title);
    return { ...target, docs_path: cleaned !== old || job.knowledge_layout ? cleaned
      : `${old && old !== "." ? `${old}/` : ""}${repositoryKnowledgeDirectory(title)}` };
  });
}
function suggestedPath(job: DomainKnowledgeJob, target: KnowledgeRepository, document: DomainKnowledgeJob["documents"][number]) {
  if (confirmedDeletion(document)) return document.archive_path ?? document.path;
  const before = targetsOf(job).find(item => item.id === target.id)!;
  const names = job.knowledge_layout === "repository-v1" && !hasOpaqueModuleDirectory(document.archive_path ?? document.path) || target.id === job.knowledge_target.id
    ? [] : [before.name, before.repository.split("/").at(-1)?.replace(/\.git$/, "") ?? ""];
  return repairModuleKnowledgePath(before.docs_path, target.docs_path, document.archive_path ?? document.path, names,
    job.knowledge_layout === "module-v1" || (job.knowledge_layout === "repository-v1" || target.id === job.knowledge_target.id) && before.docs_path !== target.docs_path);
}
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void;
}) {
  const [targets, setTargets] = useState(() => initialTargets(job));
  const [customPaths, setCustomPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTargets(initialTargets(job)); setCustomPaths({}); setError(""); }, [job.id, job.archive_revision]);
  const usedTargets = targets.filter(target => job.documents.some(document => document.target_id === target.id));
  const invalid = usedTargets.some(target => !target.repository.trim() || !target.branch.trim() || !target.docs_path.trim())
    || Object.values(customPaths).some(path => !path.trim());
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(previous => previous.map(target => target.id === id ? { ...target, ...patch } : target)); }
  async function save() {
    setBusy(true); setError("");
    try {
      onChange(await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, {
        targets: usedTargets, documents: Object.entries(customPaths).map(([id, path]) => ({ id, path })),
        use_repository_layout: !job.component_research_id, base_revision: job.archive_revision ?? 0,
      }, AbortSignal.timeout(30_000)));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-line p-4" aria-label="领域知识归档位置">
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>归档目录以仓库根目录为起点，填写的就是最终目录，不追加模块编号或仓库名。领域知识可指定业务目录；仓内知识填写「.」保留原相对路径，例如 docs/module-map.md。</p>
      <p>已发布旧稿的编号目录会在点击「归档」时自动整理，无需在此手工修改，也不重新萃取。下方用于自定义目录：保存时自动避让重名并更新链接，保留每篇文稿；自定义变化需回到「文稿」确认并发布。新 MR 创建成功后，平台自动撤销本任务被替换的旧 MR。</p>
      <p>归档时，平台用统一入口完整替换每个目标仓根 AGENTS.md，旧正文保留在 Git 历史中。业务文稿使用 README.md 或普通索引，不生成子目录 AGENTS.md。</p>
    </div>
    {usedTargets.map(target => <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled}>
      <legend className="px-1 font-medium">{target.name}</legend>
      <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={event => change(target.id, { repository: event.target.value })} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={event => change(target.id, { branch: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">仓内归档目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={event => change(target.id, { docs_path: event.target.value })} placeholder=". 或 docs/业务目录" /></label>
      <div className="col-span-2 space-y-2">{job.documents.filter(document => document.target_id === target.id).map(document => <label key={document.id} className="grid gap-1 text-sm">{document.title}{confirmedDeletion(document) && <span className="text-muted-foreground">已发布删除，保留历史路径</span>}
        <Input aria-label={`${document.id} 文件归档路径`} disabled={confirmedDeletion(document)} value={customPaths[document.id] ?? suggestedPath(job, target, document)} onChange={event => setCustomPaths(previous => ({ ...previous, [document.id]: event.target.value }))} />
      </label>)}</div>
    </fieldset>)}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    <Button variant="outline" disabled={busy || disabled || invalid || !usedTargets.length} onClick={() => void save()}>{busy ? "正在保存…" : "保存 Git 归档设置"}</Button>
  </section>;
}
