import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { diffLines } from "diff";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { componentRequest } from "./componentResearchApi";

interface Skill { name: string; digest: string; files: Record<string, string>; can_manage: boolean; versions: Array<{ version_id: string; digest: string; archived_at: string; operator: string }> }
export function ExtractionSkillEditor({ kind }: { kind: "component" | "domain" }) {
  const [open, setOpen] = useState(false), [skill, setSkill] = useState<Skill>(), [files, setFiles] = useState<Record<string, string>>({}), [path, setPath] = useState("SKILL.md"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState(""), [diff, setDiff] = useState(false);
  useEffect(() => { if (open) { setError(""); void componentRequest<Skill>(`/knowledge-extraction/skills/${kind}`).then(value => { setSkill(value); setFiles(value.files); setPath("SKILL.md"); }).catch(e => setError(e.message)); } }, [open, kind]);
  async function save(version?: string) {
    if (!skill) return; setBusy(true); setError("");
    try {
      const value = await componentRequest<Skill>(`/knowledge-extraction/skills/${kind}${version ? "/rollback" : ""}`, { expected_digest: skill.digest, files, version_id: version });
      setSkill(value); setFiles(value.files); if (!value.files[path]) setPath("SKILL.md");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <><Button variant="outline" onClick={() => setOpen(true)}>维护萃取 Skill</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root max-w-[1100px] sm:max-w-[1100px] max-h-[90vh] overflow-auto">
    <DialogHeader><DialogTitle>{kind === "component" ? "基础组件" : "领域知识"}萃取 Skill</DialogTitle></DialogHeader>
    <p className="text-sm text-muted-foreground">此包独立维护。发布后新任务立即使用；已有任务保留原版本，可在下一轮选择最新版本。</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {skill ? <><p className="text-xs font-mono">{skill.name} · {skill.digest.slice(0, 12)}</p><div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
      <nav aria-label="Skill 文件" className="space-y-1">{[...new Set([...Object.keys(files), ...Object.keys(skill.files)])].map(file => <button key={file} className={`block w-full break-all rounded p-2 text-left text-sm ${path === file ? "bg-primary/10 text-primary" : ""}`} onClick={() => setPath(file)}>{file}{files[file] === undefined ? " · 待删除" : skill.files[file] === undefined ? " · 新增" : files[file] !== skill.files[file] ? " · 已修改" : ""}</button>)}
        {skill.can_manage && <div className="space-y-2 border-t border-line pt-3"><Input aria-label="新 Skill 文件路径" placeholder="references/example.md" value={newPath} onChange={e => setNewPath(e.target.value)} /><Button size="sm" variant="outline" disabled={busy || !newPath.trim()} onClick={() => { const name = newPath.trim(); if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]*\.md$/u.test(name) || name.split("/").some(p => !p || p.startsWith(".")) || Object.hasOwn(files, name)) { setError("请使用未占用的 Markdown 相对路径"); return; } setFiles({ ...files, [name]: "" }); setPath(name); setNewPath(""); setError(""); }}>添加引用文件</Button></div>}
      </nav>
      <div className="min-w-0 space-y-3"><div className="flex gap-2"><Button size="sm" variant={diff ? "outline" : "default"} onClick={() => setDiff(false)}>编辑文件</Button><Button size="sm" variant={diff ? "default" : "outline"} onClick={() => setDiff(true)}>发布前差异</Button>{skill.can_manage && path !== "SKILL.md" && <Button size="sm" variant="outline" disabled={busy} onClick={() => { const next = { ...files }; if (next[path] === undefined) next[path] = skill.files[path]; else delete next[path]; setFiles(next); }}>{files[path] === undefined ? "撤销删除" : "移除此文件"}</Button>}</div>
      {diff ? <pre aria-label="Skill 文件差异" className="h-[420px] overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(skill.files[path] ?? "", files[path] ?? "").map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre> : files[path] === undefined ? <p>发布时将移除此文件；请同步调整引用链接。</p> : <Textarea aria-label="Skill 文件内容" className="h-[420px] font-mono text-sm" value={files[path]} disabled={!skill.can_manage || busy} onChange={e => setFiles({ ...files, [path]: e.target.value })} />}</div>
    </div><div className="flex justify-end"><Button disabled={!skill.can_manage || busy || JSON.stringify(files) === JSON.stringify(skill.files)} onClick={() => void save()}>发布此 Skill 新版本</Button></div>
    <details><summary className="cursor-pointer">版本历史 · {skill.versions.length}</summary><div className="mt-3 space-y-2">{skill.versions.map(version => <div key={version.version_id} className="flex items-center gap-3 text-sm"><span>{new Date(version.archived_at).toLocaleString()} · {version.operator} · {version.digest.slice(0, 12)}</span><Button size="sm" variant="outline" disabled={!skill.can_manage || busy} onClick={() => void save(version.version_id)}>回退到此版本</Button></div>)}</div></details></> : <p>正在读取 Skill…</p>}
  </DialogContent></Dialog></>;
}
