import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, FileText, Folder, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Node { name: string; path: string; children: Map<string, Node>; file: boolean; count: number }
const PAGE_SIZE = 80;
export function KnowledgeRepositoryTree({paths,selected,onChange}:{paths:string[];selected:string[];onChange:(paths:string[])=>void}) {
  const [folder,setFolder] = useState(""), [query,setQuery] = useState(""), [limit,setLimit] = useState(PAGE_SIZE);
  const crumbs = useRef<HTMLDivElement>(null);
  const {root,all} = useMemo(() => {
    const root:Node = {name:"仓库根目录",path:"",children:new Map(),file:false,count:paths.length};
    const all = new Map<string,Node>(); all.set("",root);
    for (const path of paths) {
      let parent = root;
      const parts = path.split("/");
      parts.forEach((name,index) => {
        const fullPath=parts.slice(0,index+1).join("/");
        if (!parent.children.has(name)) {
          const node={name,path:fullPath,children:new Map(),file:index===parts.length-1,count:0};
          parent.children.set(name,node);all.set(fullPath,node);
        }
        parent = parent.children.get(name)!; parent.count++;
      });
    }
    return {root,all};
  },[paths]);
  const selectedCounts = useMemo(() => {
    const counts = new Map<string,number>();
    for(const path of selected) {
      const parts=path.split("/");
      parts.forEach((_,index)=>{const key=parts.slice(0,index+1).join("/");counts.set(key,(counts.get(key)??0)+1);});
    }
    counts.set("",selected.length);return counts;
  },[selected]);
  useEffect(()=>{setFolder("");setQuery("");},[paths]);
  useEffect(()=>{setLimit(PAGE_SIZE);if(crumbs.current)crumbs.current.scrollLeft=crumbs.current.scrollWidth;},[folder,query]);
  const current = all.get(folder) ?? root, term=query.trim().toLowerCase();
  const rows = useMemo(()=> (term ? [...all.values()].filter(n=>n.path && n.path.toLowerCase().includes(term)) : [...current.children.values()])
    .sort((a,b)=>Number(a.file)-Number(b.file)||a.name.localeCompare(b.name)),[all,current,term]);
  function toggleFiles(files:string[],checked:boolean) {
    const next = new Set(selected);
    for(const file of files) checked ? next.add(file) : next.delete(file);
    onChange([...next]);
  }
  function open(path:string){setFolder(path);setQuery("");}
  function check(node:Node) {
    const count=selectedCounts.get(node.path)??0;
    return <Checkbox aria-label={`选择 ${node.path || "仓库全部文档"}`} checked={!!node.count && count===node.count}
      indeterminate={count>0 && count<node.count} onCheckedChange={value=>toggleFiles(node.file ? [node.path] : paths.filter(p=>!node.path || p.startsWith(node.path+"/")),value)} />;
  }
  const matchedFiles = term ? paths.filter(p=>p.toLowerCase().includes(term)) : [];
  const matchedSelected = matchedFiles.filter(p=>selected.includes(p)).length;
  const parts=folder ? folder.split("/") : [];
  return <div className="kd-repository-tree">
    <div className="kd-tree-search"><Search size={17}/><Input aria-label="搜索仓内文档路径" placeholder="搜索文件名或完整路径（整个仓库）" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="kd-tree-navigation"><Button type="button" size="sm" variant="ghost" aria-label="返回上级目录" disabled={!folder} onClick={()=>open(parts.slice(0,-1).join("/"))}><ArrowLeft size={16}/></Button><div className="kd-tree-breadcrumbs" ref={crumbs}><button type="button" onClick={()=>open("")}>根目录</button>{parts.map((name,index)=><span key={index}><ChevronRight size={14}/><button type="button" title={parts.slice(0,index+1).join("/")} onClick={()=>open(parts.slice(0,index+1).join("/"))}>{name}</button></span>)}</div></div>
    <div className="kd-tree-total">{term ? <Checkbox aria-label="选择全部搜索结果" checked={!!matchedFiles.length && matchedSelected===matchedFiles.length} indeterminate={matchedSelected>0 && matchedSelected<matchedFiles.length} onCheckedChange={value=>toggleFiles(matchedFiles,value)}/> : check(current)}<span>{term ? "全选搜索结果" : "全选当前目录"} · {term ? matchedFiles.length : current.count} 篇</span><strong>已选 {selected.length} 篇</strong>{!!selected.length && <button type="button" onClick={()=>onChange([])}>清空</button>}</div>
    <div className="kd-tree-scroll">{rows.slice(0,limit).map(node=><div className="kd-tree-row" key={node.path}>
      {check(node)}{node.file ? <FileText size={18}/> : <Folder size={18}/>}
      {node.file ? <span className="kd-tree-name" title={node.path}>{term ? node.path : node.name}</span> : <button type="button" className="kd-tree-name" title={node.path} onClick={()=>open(node.path)}>{term ? node.path : node.name}</button>}
      {!node.file && <><small>{node.count} 篇</small><Button type="button" variant="ghost" size="sm" aria-label={`打开 ${node.path}`} onClick={()=>open(node.path)}><ChevronRight size={16}/></Button></>}
    </div>)}{!rows.length && <p className="p-3 text-muted-foreground">没有匹配的文档或目录</p>}{rows.length>limit && <Button type="button" variant="ghost" className="w-full" onClick={()=>setLimit(limit+PAGE_SIZE)}>显示更多（已显示 {limit} / {rows.length} 项）</Button>}</div>
    <div className="kd-tree-hint">{term ? `搜索结果 ${rows.length} 项` : `${rows.length} 个直接子项`} · 勾选文件夹包含其所有下级文档</div>
  </div>;
}
