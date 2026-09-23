import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";
import { componentRequest } from "./componentResearchApi";

export type PlatformSkillKind = "component" | "domain";
export const platformSkillLabels = { component: "基础组件萃取", domain: "领域知识萃取" };
export interface PlatformSkill {
  name: string; digest: string; files: Record<string, string>; can_manage: boolean;
  versions: Array<{ version_id: string; archived_at: string; operator: string }>;
}
export const platformSkillRequest = (kind: PlatformSkillKind, body?: unknown) =>
  componentRequest<PlatformSkill>(`/knowledge-extraction/skills/${kind}`, body);

/** 使用现有的萃取方法存储，不加入开发任务的 Skill 列表或知识索引。 */
export function PlatformSkillPane({ kind, upload = false, onSaved }: {
  kind: PlatformSkillKind; upload?: boolean; onSaved: () => void;
}) {
  const [skill, setSkill] = useState<PlatformSkill>(), [pending, setPending] = useState<Record<string, string>>();
  const [showUpload, setShowUpload] = useState(upload);
  const [path, setPath] = useState("SKILL.md"), [source, setSource] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const directory = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    platformSkillRequest(kind).then(value => { if (live) setSkill(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [kind]);
  async function pick(list: FileList | null) {
    if (!list?.length) return;
    setError(""); setNotice(""); setPending(undefined); setBusy(true);
    try {
      const files: Record<string, string> = {};
      for (const entry of Array.from(list)) {
        const relative = entry.webkitRelativePath;
        const name = relative ? relative.split("/").slice(1).join("/") : entry.name;
        if (name.split("/").some(part => part.startsWith("."))) continue;
        files[name] = new TextDecoder("utf-8", { fatal: true }).decode(await entry.arrayBuffer());
      }
      if (!files["SKILL.md"]) throw new Error("请选择包含 SKILL.md 的 Skill 根目录，或单独上传 SKILL.md");
      setPending(files); setPath("SKILL.md");
    } catch (e) { setError(e instanceof TypeError ? "Skill 附件需为 UTF-8 文本文件" : (e as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!skill || !pending) return;
    setBusy(true); setError("");
    try {
      setSkill(await platformSkillRequest(kind, { files: pending, expected_digest: skill.digest }));
      setPending(undefined); setShowUpload(false); setNotice("已更新，新萃取任务会使用此 Skill；正在运行的任务继续使用原版本。"); onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const files = pending ?? skill?.files;
  return <div className="tw-root space-y-5 p-6" aria-label="平台 Skill 详情">
    <header className="flex items-start justify-between gap-4"><div>
      <p className="mb-2 text-sm text-muted-foreground">平台使用 · {platformSkillLabels[kind]}</p>
      <h2 className="text-2xl font-semibold">{showUpload ? "上传平台 Skill" : skill?.name ?? platformSkillLabels[kind]}</h2>
      <p className="mt-2 text-sm text-muted-foreground">用于平台的{platformSkillLabels[kind]}，不加载到需求或问题任务。</p>
    </div>{skill?.can_manage && !showUpload && <Button variant="outline" onClick={() => setShowUpload(true)}>上传新版本</Button>}</header>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {notice && <p role="status" className="text-primary">{notice}</p>}
    {skill?.can_manage && showUpload && <div className="rounded-xl border border-line bg-muted/30 p-4 space-y-3">
      <p className="text-sm">上传包含 SKILL.md 的标准 Skill 目录；只有一个文件时可直接上传 SKILL.md。上传前可预览内容。</p>
      <input ref={directory} hidden type="file" multiple {...{ webkitdirectory: "" }} aria-label="上传平台 Skill 目录" onChange={e => { void pick(e.target.files); e.target.value = ""; }} />
      <input ref={file} hidden type="file" accept=".md" aria-label="上传平台 SKILL.md" onChange={e => { void pick(e.target.files); e.target.value = ""; }} />
      <div className="flex items-center gap-3">
        <Button variant="outline" disabled={busy} onClick={() => directory.current?.click()}>选择 Skill 目录</Button>
        <Button variant="outline" disabled={busy} onClick={() => file.current?.click()}>选择 SKILL.md</Button>
        {pending && <><span className="text-sm text-muted-foreground">已选 {Object.keys(pending).length} 个文件</span><Button disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存并用于新任务"}</Button><Button variant="ghost" disabled={busy} onClick={() => { setPending(undefined); setPath("SKILL.md"); }}>取消上传</Button></>}
      </div>
    </div>}
    {skill && !skill.can_manage && <p className="text-sm text-muted-foreground">可在线查看；更新平台 Skill 请联系管理员。</p>}
    {files ? <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-5">
      <nav aria-label="平台 Skill 文件" className="space-y-1">{Object.keys(files).sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)).map(name => <button key={name} type="button" aria-pressed={path === name} onClick={() => setPath(name)} className={`block w-full rounded-lg px-3 py-2 text-left text-sm break-all ${path === name ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"}`}>{name}</button>)}</nav>
      <section className="min-w-0 rounded-xl border border-line"><div className="flex items-center justify-between gap-3 border-b border-line p-3"><strong className="break-all text-sm">{path}</strong><Button variant="ghost" size="sm" onClick={() => setSource(!source)}>{source ? "阅读" : "查看源码"}</Button></div><div className="max-h-[560px] overflow-auto p-5">{source || !path.endsWith(".md") ? <pre className="whitespace-pre-wrap break-words text-sm">{files[path]}</pre> : <Markdown text={path === "SKILL.md" ? (files[path] ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "") : files[path] ?? ""} />}</div></section>
    </div> : !error && <p>正在读取 Skill…</p>}
    {!!skill?.versions.length && <details className="border-t border-line pt-4 text-sm"><summary className="cursor-pointer">更新记录 · {skill.versions.length}</summary><ul className="mt-3 space-y-2 text-muted-foreground">{skill.versions.map(v => <li key={v.version_id}>{new Date(v.archived_at).toLocaleString()} · {v.operator} 更新了 Skill</li>)}</ul></details>}
  </div>;
}
