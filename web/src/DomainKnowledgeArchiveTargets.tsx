import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";
import { moduleKnowledgeDirectory, moduleKnowledgePath, moduleKnowledgePaths } from "../../src/domainKnowledgeLayout";
import { repositoryIdentity } from "../../src/knowledgeAssetModel";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const pathsOf = (job: DomainKnowledgeJob) => Object.fromEntries(job.documents.map(document => [document.id, document.archive_path ?? document.path]));
const confirmedDeletion = (document: DomainKnowledgeJob["documents"][number]) => !!document.deleted && !!document.knowledge_document_id && document.published_document_revision === document.revision;
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void;
}) {
  const [targets, setTargets] = useState(() => structuredClone(targetsOf(job))), [paths, setPaths] = useState(() => pathsOf(job));
  const [customPaths, setCustomPaths] = useState<string[]>([]);
  const [moduleLayout, setModuleLayout] = useState(job.knowledge_layout === "module-v1");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTargets(structuredClone(targetsOf(job))); setPaths(pathsOf(job)); setCustomPaths([]); setModuleLayout(job.knowledge_layout === "module-v1"); setError(""); }, [job.id, job.archive_revision]);
  const usedTargets = targets.filter(target => job.documents.some(document => document.target_id === target.id));
  const invalid = usedTargets.some(target => !target.repository.trim() || !target.branch.trim() || !target.docs_path.trim())
    || job.documents.some(document => !paths[document.id]?.trim());
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(previous => previous.map(target => target.id === id ? { ...target, ...patch } : target)); }
  function changeDirectory(id: string, directory: string) {
    change(id, { docs_path: directory });
    const before = targets.find(target => target.id === id)!;
    const previousDirectory = before.docs_path.replace(/\/$/, "");
    setPaths(previous => ({ ...previous, ...Object.fromEntries(job.documents.filter(document => document.target_id === id && (!moduleLayout || !confirmedDeletion(document))
      && !customPaths.includes(document.id) && (moduleLayout || !/^agents\.md$/i.test(document.path)))
      .flatMap(document => {
        const path = previous[document.id] ?? document.path;
        if (!path.startsWith(`${previousDirectory}/`)) return [];
        return [[document.id, `${directory.replace(/\/$/, "")}/${path.slice(previousDirectory.length + 1)}`]];
      })) }));
  }
  function organizeByModule() {
    if (!job.module_id) return;
    try {
      const nextTargets = targets.map(target => ({ ...target, docs_path: moduleKnowledgeDirectory(target.docs_path, job.module_id!) }));
      const layout = moduleKnowledgePaths(job.documents.filter(document => !confirmedDeletion(document)).map(document => ({
        id: document.id, target_id: document.target_id, path: document.path, desired_path: paths[document.id],
      })), nextTargets.map(target => ({ id: target.id, old_directory: targets.find(previous => previous.id === target.id)!.docs_path,
        new_directory: target.docs_path, collision_group: JSON.stringify([target.repository ? repositoryIdentity(target.repository) : target.id, target.branch]),
      })));
      setPaths(Object.fromEntries(job.documents.map(document => {
        if (confirmedDeletion(document)) return [document.id, document.archive_path ?? document.path];
        return [document.id, layout.paths.get(document.id)!];
      })));
      setTargets(nextTargets); setCustomPaths([]); setModuleLayout(true); setError("");
    } catch (reason) { setError((reason as Error).message); }
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const normalized = usedTargets.map(target => moduleLayout && job.module_id
        ? { ...target, docs_path: moduleKnowledgeDirectory(target.docs_path, job.module_id) } : target);
      const documents = job.documents.map(document => {
        if (moduleLayout && confirmedDeletion(document)) return { id: document.id, path: document.archive_path ?? document.path };
        const before = usedTargets.find(target => target.id === document.target_id)!;
        const after = normalized.find(target => target.id === document.target_id)!;
        const path = paths[document.id];
        return { id: document.id, path: !path.startsWith(`${after.docs_path}/`) && path.startsWith(`${before.docs_path.replace(/\/$/, "")}/`) && after.docs_path !== before.docs_path
          ? moduleKnowledgePath(before.docs_path, after.docs_path, path) : path };
      });
      onChange(await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, { targets: normalized,
        documents, use_module_layout: moduleLayout && job.knowledge_layout !== "module-v1", base_revision: job.archive_revision ?? 0 }, AbortSignal.timeout(30_000)));
    }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-line p-4" aria-label="领域知识归档位置">
    {job.module_id && !moduleLayout && <div className="space-y-2"><p className="text-sm text-muted-foreground">确认并发布时，平台会自动按业务模块整理目录：原 AGENTS.md 内容移入 README.md 或 index.md；重名时自动分配文件名、更新链接和索引，保留每篇文稿。只发布本次勾选的文稿，不重新萃取，无需提前设置。这里可预览或自定义归档位置。</p><Button variant="outline" disabled={busy || disabled} onClick={organizeByModule}>预览模块目录</Button></div>}
    {moduleLayout && <div className="space-y-2 text-sm text-muted-foreground"><p>归档时，平台用统一入口完整替换每个目标仓根 AGENTS.md，旧正文保留在 Git 历史中。业务文稿分别保存在带模块标识的目录内，以 README.md 和普通索引说明范围，不生成子目录 AGENTS.md。</p><p>保存目录调整后，回到「文稿」确认并发布本次变化，再创建归档 MR；这些操作不重新调用模型研究。其他模块的文稿保持原样。</p></div>}
    {usedTargets.map(target => <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled}>
      <legend className="px-1 font-medium">{target.name}</legend>
      <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={event => change(target.id, { repository: event.target.value })} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={event => change(target.id, { branch: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">文档目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={event => changeDirectory(target.id, event.target.value)} /></label>
      <div className="col-span-2 space-y-2">{job.documents.filter(document => document.target_id === target.id).map(document => <label key={document.id} className="grid gap-1 text-sm">{document.title}{moduleLayout && confirmedDeletion(document) && <span className="text-muted-foreground">已发布删除，保留历史路径</span>}
        <Input aria-label={`${document.id} 文件归档路径`} disabled={moduleLayout && confirmedDeletion(document)} value={paths[document.id] ?? document.path} onChange={event => { setCustomPaths(previous => [...new Set([...previous, document.id])]); setPaths(previous => ({ ...previous, [document.id]: event.target.value })); }} />
      </label>)}</div>
    </fieldset>)}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    <Button variant="outline" disabled={busy || disabled || invalid || !usedTargets.length} onClick={() => void save()}>{busy ? "正在保存…" : "保存 Git 归档设置"}</Button>
  </section>;
}
