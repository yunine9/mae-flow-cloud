import { useState } from "react";
import { componentRequest } from "./componentResearchApi";
import { Input } from "@/components/ui/input";

export interface MaterialSummary { id: string; name: string; version: string; scope: string; state: "ready" | "failed"; error?: string; sections: number }
export function KnowledgeMaterialUpload({ materials, onChange, onBusy }: { materials: MaterialSummary[]; onChange: (materials: MaterialSummary[]) => void; onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [scope, setScope] = useState("本次业务域"), [version, setVersion] = useState("");
  async function upload(files: File[]) {
    setBusy(true); onBusy?.(true); setError(""); const next = [...materials];
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB`);
        const content_base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
        next.push(await componentRequest<MaterialSummary>("/knowledge-materials", { name: file.name, content_base64, scope, version })); onChange([...next]);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); onBusy?.(false); }
  }
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="业务资料上传">
    <strong>补充资料</strong><p className="text-sm text-muted-foreground">支持 MD、TXT、DOCX、PDF、XLSX、PPTX，单份最多 20 MiB。原文件保留在任务资料区。PDF 需有可提取文本，扫描件请先识别为文字。</p>
    <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-sm">适用范围<Input value={scope} onChange={e => setScope(e.target.value)} /></label><label className="grid gap-1 text-sm">资料版本<Input value={version} onChange={e => setVersion(e.target.value)} placeholder="如：2026.09" /></label></div>
    <input aria-label="上传业务资料" type="file" multiple disabled={busy} accept=".md,.txt,.docx,.pdf,.xlsx,.pptx" onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    {busy && <p role="status">正在上传并解析资料…</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    {materials.map(material => <div key={material.id} className="flex items-start gap-2 border-t border-line pt-2 text-sm"><span className="flex-1">{material.name} · {material.version || "未标版本"} · {material.state === "ready" ? `${material.sections} 个文本片段` : material.error}</span><button type="button" className="text-primary" disabled={busy} onClick={() => onChange(materials.filter(m => m.id !== material.id))}>移除</button></div>)}
  </section>;
}
