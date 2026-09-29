import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { componentRequest } from "./componentResearchApi";

type Artifacts = { document_id: string; document_revision: string; source_digest: string; files: Record<string, string> };
export function ComponentKnowledgeArtifacts({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<Artifacts>(), [file, setFile] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let live = true; setData(undefined); setError("");
    if (id) void componentRequest<Artifacts>(`/component-knowledge/${encodeURIComponent(id)}/artifacts`).then(result => {
      if (live) { setData(result); setFile(Object.keys(result.files).find(p => p.includes("/rules/")) ?? "source.md"); }
    }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id]);
  function download() {
    if (!data || !file) return;
    const url = URL.createObjectURL(new Blob([data.files[file]], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = file.split("/").at(-1)!; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <Dialog open={!!id} onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="tw-root w-[90vw] sm:max-w-[1280px] max-h-[88vh] overflow-auto">
    <DialogHeader><DialogTitle>程序化产物</DialogTitle></DialogHeader>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!data && !error && <p>正在从当前知识生成产物…</p>}
    {data && <><div className="grid min-h-[440px] grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-lg border border-line">
      <nav className="max-h-[60vh] overflow-auto border-r border-line p-2" aria-label="产物文件">{Object.keys(data.files).sort().map(path => <button key={path} className={`block w-full break-all rounded-md p-3 text-left text-sm ${file === path ? "bg-primary/10 text-primary" : "hover:bg-surface-2"}`} onClick={() => setFile(path)}>{path}</button>)}</nav>
      <section className="min-w-0"><h3 className="break-all border-b border-line p-4 font-mono text-sm">{file}</h3><pre aria-label="产物内容" className="max-h-[55vh] overflow-auto whitespace-pre p-4 text-sm leading-relaxed">{data.files[file]}</pre></section>
    </div><footer className="flex items-center justify-between gap-4"><details className="min-w-0 text-sm"><summary className="cursor-pointer">来源版本</summary><p className="break-all">{data.document_id}<br />{data.document_revision}<br />{data.source_digest}</p></details><Button onClick={download}>下载当前文件</Button></footer></>}
  </DialogContent></Dialog>;
}
