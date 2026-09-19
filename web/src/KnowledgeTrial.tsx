import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "./markdown";
import { documentRequest, type KnowledgeDocument, type ChapterHit } from "./knowledgeDocumentsApi";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
interface Hit extends ChapterHit { title:string;scope:string;whenToUse:string;technologies:string[];source?:KnowledgeDocument["source"] }
interface Result { available:boolean;warnings:string[];hits:Hit[] }
export function KnowledgeTrial({open,onClose,onOpenDocument}:{open:boolean;onClose:()=>void;onOpenDocument:(id:string)=>void}) {
  const [query,setQuery]=useState(""),[result,setResult]=useState<Result>(),[hit,setHit]=useState<Hit>();
  const [doc,setDoc]=useState<KnowledgeDocument>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const searching=useRef(0),reading=useRef(0);
  useEffect(()=>{if(!open){searching.current++;reading.current++;setBusy(false);}else if(hit&&!doc){void read(hit);}},[open]);
  async function read(item:Hit) {
    const version=++reading.current;setHit(item);setDoc(undefined);setError("");
    try {const value=await documentRequest<KnowledgeDocument>(`/${encodeURIComponent(item.id)}`);if(version===reading.current)setDoc(value);}
    catch(e){if(version===reading.current)setError((e as Error).message);}
  }
  async function search() {
    const version=++searching.current;reading.current++;setBusy(true);setError("");setResult(undefined);setHit(undefined);setDoc(undefined);
    try {const value=await documentRequest<Result>("/search",{query});if(version!==searching.current)return;setResult(value);if(value.hits[0])void read(value.hits[0]);}
    catch(e){if(version===searching.current)setError((e as Error).message);}
    finally{if(version===searching.current)setBusy(false);}
  }
  const valid=doc && doc.active && hit && doc.revision===hit.revision;
  const lines=doc?.content?.split("\n")??[];
  return <Dialog open={open} onOpenChange={value=>{if(!value)onClose();}}><DialogContent className="kd-global-trial">
    <DialogHeader><DialogTitle>试搜知识</DialogTitle><p>检索全部已启用文档、模块知识与已采纳经验；Skill 使用原生加载。</p></DialogHeader>
    <form className="kd-trial-query" onSubmit={e=>{e.preventDefault();void search();}}><div className="kd-search-input"><Search size={20}/><Input aria-label="全局试搜问题" value={query} onChange={e=>setQuery(e.target.value)} placeholder="描述准备解决的问题，如：文件句柄应该由谁关闭？"/></div><Button type="submit" disabled={busy||!query.trim()}>{busy?"检索中…":"试搜"}</Button></form>
    {error && <p role="alert" className="kd-error">{error}</p>}
    {!!result?.warnings.length && <p role="status" className="kd-warning">{result.warnings.join("；")}</p>}
    <div className="kd-results kd-global-results"><aside><strong>{result?result.available?`找到 ${result.hits.length} 个相关章节`:"检索暂不可用":"全库检索结果"}</strong>{result?.hits.map((item,i)=><button key={`${item.id}-${i}`} className={hit===item?"active":""} onClick={()=>void read(item)}><span><b>{item.title}</b><small>{item.scope} {item.technologies.map(knowledgeLanguageLabel).join("、")}</small>{item.source && <small>{item.source.repository} · {item.source.branch} · {item.source.path}</small>}<small>{item.heading} · 第 {item.start_line??1}–{item.end_line??"?"} 行</small></span></button>)}{result?.available&&!result.hits.length&&<p className="kd-empty">没有找到相关知识，试试更具体的问题。</p>}</aside>
    <article className="kd-reader">{valid?<><header><div><strong>{doc.title}</strong><small>{hit.whenToUse}</small><small>原文第 {hit.start_line??1}–{hit.end_line??lines.length} 行</small></div><Button variant="ghost" onClick={()=>onOpenDocument(hit.id)}>打开原文 ↗</Button></header><Markdown text={lines.slice((hit.start_line??1)-1,hit.end_line).join("\n")}/></>:<div className="kd-empty">{doc?doc.active?"文档已更新，请重新试搜":"知识已停用，请重新试搜":hit?"正在读取原文…":"输入问题，跨文档查看相关知识及其来源。"}</div>}</article></div>
  </DialogContent></Dialog>;
}
