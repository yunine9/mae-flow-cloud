import { useState } from "react";
import { componentRequest } from "./componentResearchApi";
import { Input } from "@/components/ui/input";

export interface MaterialSummary { id: string; name: string; version: string; scope: string; state: "ready" | "failed"; error?: string; sections: number; images?: Array<{ path: string }>; warnings?: string[] }
export function KnowledgeMaterialUpload({ materials, onChange, onBusy }: { materials: MaterialSummary[]; onChange: (materials: MaterialSummary[]) => void; onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [version, setVersion] = useState("");
  async function upload(files: File[]) {
    setBusy(true); onBusy?.(true); setError(""); const next = [...materials];
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB`);
        const content_base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
        next.push(await componentRequest<MaterialSummary>("/knowledge-materials", { name: file.name, content_base64, version })); onChange([...next]);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); onBusy?.(false); }
  }
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="业务资料上传">
    <strong>补充资料</strong><p className="text-sm text-muted-foreground">支持 MD、TXT、DOCX、PDF、XLSX、PPTX，也可上传包含 Markdown 和图片的 ZIP。单份最多 20 MiB；ZIP 解压后最多 100 MiB、1000 个条目，单个文件最多 10 MiB。资料自动用于本次萃取，原文件保留。PDF 扫描件请先识别为文字。</p>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">填写资料版本（可选）</summary><label className="mt-2 grid gap-1">资料版本<Input aria-label="资料版本（可选）" value={version} onChange={e => setVersion(e.target.value)} placeholder="如 v2.1 或文档发布日期；不知道可留空" /><span className="text-muted-foreground">用于区分不同版本的业务规则，无固定格式；仅应用于接下来上传的文件。系统自动记录上传时间和文件指纹。</span></label></details>
    <input aria-label="上传业务资料" type="file" multiple disabled={busy} accept=".md,.txt,.docx,.pdf,.xlsx,.pptx,.zip" onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    {busy && <p role="status">正在上传并解析资料…</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    {materials.map(material => <div key={material.id} className="flex items-start gap-2 border-t border-line pt-2 text-sm"><span className="flex-1">{material.name} · {material.version ? `${material.version} · ` : ""}{material.state === "ready" ? `${material.sections} 个文本片段${material.images?.length ? ` · ${material.images.length} 张图片` : ""}` : material.error}{!!material.warnings?.length && <details className="mt-1 text-amber-700"><summary>有 {material.warnings.length} 个附件未解析</summary><ul>{material.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</span><button type="button" className="text-primary" disabled={busy} onClick={() => onChange(materials.filter(m => m.id !== material.id))}>移除</button></div>)}
  </section>;
}
