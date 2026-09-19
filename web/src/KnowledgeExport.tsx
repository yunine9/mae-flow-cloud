import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { KnowledgeDocument } from "./knowledgeDocumentsApi";

export function KnowledgeExport({documents}: {documents: KnowledgeDocument[]}) {
  const [open,setOpen] = useState(false), [selected,setSelected] = useState<string[]>([]);
  const [query,setQuery] = useState(""), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const available = documents.filter(d => d.active && d.form !== "skill");
  const shown = available.filter(d => `${d.title} ${d.source?.path ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  async function download() {
    setBusy(true);setError("");
    try {
      const response = await fetch("/knowledge-documents/export", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:selected})});
      if (!response.ok) throw new Error((await response.json()).error || "导出失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");link.href=url;link.download="mae-knowledge.zip";
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setOpen(false);
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  return <>
    <Button variant="outline" onClick={() => {setSelected(available.map(d=>d.id));setQuery("");setError("");setOpen(true);}}><Download size={18}/>导出知识</Button>
    <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v);}}><DialogContent className="tw-root sm:max-w-[680px] max-h-[85vh] flex flex-col"><DialogHeader><DialogTitle>导出知识</DialogTitle></DialogHeader>
      <p className="text-muted-foreground">下载 Markdown ZIP，包含正文、适用范围和来源。仅列出已启用文档，不包含萃取草稿和 Skill。</p>
      <Input aria-label="筛选导出文档" placeholder="搜索文档名称或来源路径" value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={busy} onClick={()=>setSelected(available.map(d=>d.id))}>全选已启用文档</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>setSelected([])}>清空</Button><span>已选 {selected.length} 篇</span></div>
      <div className="min-h-0 overflow-auto max-h-[42vh] divide-y divide-border rounded-lg border border-line">
        {shown.map(d=><label key={d.id} className="flex items-start gap-3 p-3 cursor-pointer"><input type="checkbox" className="mt-1 size-4 shrink-0" disabled={busy} checked={selected.includes(d.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id))}/><span className="min-w-0"><strong className="block break-words">{d.title}</strong><span className="block break-all text-sm text-muted-foreground">{d.source ? `${d.source.repository} · ${d.source.path}` : d.scope_label || ({platform:"平台通用",module:"业务模块",repository:"代码仓"}[d.scope])}</span></span></label>)}
        {!shown.length && <p className="p-5 text-muted-foreground">没有匹配的已启用文档</p>}
      </div>
      {error && <p role="alert" className="text-danger">{error}</p>}
      <div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={()=>setOpen(false)}>取消</Button><Button disabled={busy||!selected.length} onClick={()=>void download()}>{busy?"正在导出…":`下载 ZIP（${selected.length} 篇）`}</Button></div>
    </DialogContent></Dialog>
  </>;
}
