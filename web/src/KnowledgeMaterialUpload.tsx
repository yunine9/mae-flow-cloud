import { useRef, useState } from "react";
import { componentRequest } from "./componentResearchApi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface MaterialSummary { id: string; name: string; version: string; scope: string; state: "ready" | "failed"; error?: string; sections: number; images?: Array<{ path: string }>; warnings?: string[] }
export function KnowledgeMaterialUpload({ materials, onChange, onBusy, purpose = "extraction", disabled = false }: { materials: MaterialSummary[]; onChange: (materials: MaterialSummary[]) => void; onBusy?: (busy: boolean) => void; purpose?: "extraction" | "question"; disabled?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [version, setVersion] = useState("");
  const question = purpose === "question", atLimit = question && materials.length >= 10;
  async function upload(files: File[]) {
    if (busy || disabled) return;
    setBusy(true); onBusy?.(true); setError(""); const next = [...materials];
    try {
      if (question && materials.length + files.length > 10) throw new Error("每个问题最多关联 10 份资料，请减少所选文件或移除已有附件。");
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB`);
        const content_base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
        next.push(await componentRequest<MaterialSummary>("/knowledge-materials", { name: file.name, content_base64, version, ...(question ? { scope: "本次知识问答" } : {}) })); onChange([...next]);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); onBusy?.(false); }
  }
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label={question ? "知识问答资料上传" : "业务资料上传"}>
    <strong>{question ? "本次问题的原始资料" : "补充资料"}</strong><p className="text-sm text-muted-foreground">支持 MD、TXT、DOCX、PDF、XLSX、PPTX，也可上传包含 Markdown 和图片的 ZIP。单份最多 20 MiB；ZIP 解压后最多 100 MiB、1000 个条目，单个文件最多 10 MiB。{question ? "每个问题最多 10 份。问答读取解析后的文字，尚未核验图片内容；PDF 扫描件请先识别为文字。" : "资料自动用于本次萃取，原文件保留。PDF 扫描件请先识别为文字。"}</p>
    {question && <p className="text-xs text-muted-foreground">资料仅作为本次问题的参考。移除只解除本问题的关联，原文件仍保留。</p>}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">填写资料版本（可选）</summary><label className="mt-2 grid gap-1">资料版本<Input aria-label="资料版本（可选）" value={version} onChange={e => setVersion(e.target.value)} placeholder="如 v2.1 或文档发布日期；不知道可留空" disabled={busy || disabled} /><span className="text-muted-foreground">{question ? "注明资料适用的版本；不知道可留空，上传时间不代表资料版本。" : "用于区分不同版本的业务规则，无固定格式；仅应用于接下来上传的文件。系统自动记录上传时间和文件指纹。"}</span></label></details>
    <div className="flex items-center gap-3"><Button type="button" variant="outline" disabled={busy || disabled || atLimit} onClick={() => fileInput.current?.click()}>{busy ? "上传中…" : "选择文件"}</Button><span className="text-sm text-muted-foreground">{atLimit ? "已关联 10 份资料" : "可多选文档或 ZIP，选择后自动上传"}</span></div>
    <input ref={fileInput} hidden aria-label={question ? "上传问答资料" : "上传业务资料"} type="file" multiple disabled={busy || disabled || atLimit} accept=".md,.txt,.docx,.pdf,.xlsx,.pptx,.zip" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void upload(files); e.target.value = ""; }} />
    {busy && <p role="status">正在上传并解析资料…</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    {materials.map(material => <div key={material.id} className="flex items-start gap-2 border-t border-line pt-2 text-sm"><span className="min-w-0 flex-1 break-words">{material.name} · {material.version ? `${material.version} · ` : ""}{material.state === "ready" ? `${material.sections} 个文本片段${material.images?.length ? ` · ${material.images.length} 张图片` : ""}` : material.error}{!!material.warnings?.length && <details className="mt-1 text-amber-700"><summary>有 {material.warnings.length} 条解析提醒</summary><ul>{material.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</span><button type="button" className="shrink-0 text-primary" aria-label={question ? `移除 ${material.name}` : undefined} disabled={busy || disabled} onClick={() => onChange(materials.filter(m => m.id !== material.id))}>移除</button></div>)}
  </section>;
}
