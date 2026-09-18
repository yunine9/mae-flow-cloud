import { useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";

interface Node { name: string; path: string; children: Map<string, Node>; file: boolean }
export function KnowledgeRepositoryTree({paths,selected,onChange}:{paths:string[];selected:string[];onChange:(paths:string[])=>void}) {
  const nodes = useMemo(() => {
    const root = new Map<string,Node>();
    for (const path of paths) {
      let children = root;
      const parts = path.split("/");
      parts.forEach((name,index) => {
        if (!children.has(name)) children.set(name,{name,path:parts.slice(0,index+1).join("/"),children:new Map(),file:index===parts.length-1});
        children = children.get(name)!.children;
      });
    }
    return root;
  },[paths]);
  const set = new Set(selected);
  function toggle(files:string[],checked:boolean) {
    const next = new Set(selected);
    for(const file of files) checked ? next.add(file) : next.delete(file);
    onChange([...next]);
  }
  function render(node:Node) {
    const files = node.file ? [node.path] : paths.filter(p=>p.startsWith(node.path+"/"));
    const count = files.filter(p=>set.has(p)).length;
    const check = <TreeCheck label={node.path} checked={count===files.length} partial={count>0 && count<files.length} onChange={checked=>toggle(files,checked)} />;
    return node.file ? <div className="kd-tree-file" key={node.path}>{check}<span title={node.path}>{node.name}</span></div>
      : <details key={node.path} open><summary>{check}<span>{node.name}</span><small>{files.length} 篇</small></summary><div className="kd-tree-children">{[...node.children.values()].map(render)}</div></details>;
  }
  return <div className="kd-repository-tree"><div className="kd-tree-total"><TreeCheck label="选择全部文档" checked={selected.length===paths.length && !!paths.length} partial={!!selected.length && selected.length<paths.length} onChange={checked=>onChange(checked ? paths : [])}/><span>已选 {selected.length} / {paths.length} 篇</span></div><div className="kd-tree-scroll">{[...nodes.values()].map(render)}</div></div>;
}
function TreeCheck({label,checked,partial,onChange}:{label:string;checked:boolean;partial:boolean;onChange:(checked:boolean)=>void}) {
  return <Checkbox aria-label={label} checked={checked} indeterminate={partial} onCheckedChange={value=>onChange(value)} onClick={e=>e.stopPropagation()} />;
}
