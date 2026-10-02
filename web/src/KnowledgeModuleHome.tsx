import { useEffect, useState } from "react";
import { Building2, SlidersHorizontal, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, Code2, FolderOpen, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { knowledgeFileName, loadKnowledgeModules, type KnowledgeModule, type KnowledgeModuleCategory, type KnowledgeModuleData } from "./knowledgeModules";

export interface KnowledgeModuleHomeProps {
  onOpenModule: (key: string) => void;
  onOpenDocument?: (id: string, moduleKey: string) => void;
}

function maintenance(module: KnowledgeModule) {
  if (!module.documentCount && !module.skillCount) return { label: "待建设", color: "bg-muted-foreground", note: "暂无启用的知识；数量不代表质量。" };
  if (module.recentlyMaintained) return { label: "近期维护", color: "bg-success", note: `近 30 天维护 ${module.recentlyMaintained} 份。仅反映维护记录，不代表内容已核对。` };
  return { label: "已有积累", color: "bg-primary", note: "已有启用的知识。维护时间缺失时不推断内容新旧。" };
}

export function KnowledgeModuleHome({ onOpenModule, onOpenDocument }: KnowledgeModuleHomeProps) {
  const [filterOpen,setFilterOpen] = useState(false);
  const [data, setData] = useState<KnowledgeModuleData>(), [error, setError] = useState("");
  const [category, setCategory] = useState<"all" | KnowledgeModuleCategory>("all"), [query, setQuery] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true; setError("");
    void loadKnowledgeModules().then(value => { if (live) setData(value); }).catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [reload]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = (data?.modules ?? []).filter(m => (category === "all" || m.category === category)
    && (!needle || `${m.name} ${m.description}`.toLocaleLowerCase().includes(needle) || m.documents.some(d => `${d.title} ${knowledgeFileName(d)}`.toLocaleLowerCase().includes(needle))));
  return <section className="tw-root km-home grid gap-6" aria-label="知识目录">
    <label className="km-home-search"><Search size={20} /><Input type="search" aria-label="搜索目录或文稿" placeholder="搜索目录、知识名称或文件名" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <header className="km-home-heading">
      <h2>{{all:"知识目录",business:"业务知识",engineering:"工程知识",unassigned:"待整理"}[category]}</h2>
      <div className="km-home-filterbar">
        {data && <span className="km-home-count">{visible.length} {category === "business" ? "个模块" : category === "engineering" ? "个语言目录" : "个目录"}</span>}
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger render={<Button variant="outline" className="km-category-trigger" />}><SlidersHorizontal size={18}/><span>知识分类</span><strong>{{all:"全部",business:"业务",engineering:"工程",unassigned:"待整理"}[category]}</strong><ChevronDown size={15}/></PopoverTrigger>
          <PopoverContent align="end" sideOffset={10} className="tw-root km-category-panel" aria-label="按知识分类筛选"><div className="km-category-disc" role="group" aria-label="知识分类">{([["business","业务",Building2],["engineering","工程",Code2],["all","全部",null]] as const).map(([value,label,Icon])=><button type="button" key={value} data-category={value} aria-pressed={category===value} onClick={()=>{setCategory(value);}}>{Icon&&<Icon size={21}/>}<span>{label}</span></button>)}<div className="km-category-indicator" style={{transform:`rotate(${category==="business"?-90:category==="engineering"?90:0}deg)`}}/></div><p className="text-center text-xs text-muted-foreground">业务按模块，工程按语言</p><Button size="sm" variant="ghost" className="text-primary" onClick={()=>setFilterOpen(false)}>收起</Button></PopoverContent>
        </Popover>
      </div>
    </header>
    {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm"><span>知识目录读取失败：{error}</span><Button variant="outline" onClick={() => setReload(n => n + 1)}>重试</Button></div>}
    {!data && !error && <p role="status" className="py-12 text-center text-muted-foreground">正在读取知识目录…</p>}
    {data?.warnings.map(warning => <p key={warning} role="status" className="text-sm text-attention">{warning}</p>)}
    {([['business', '业务模块'], ['engineering', '工程语言'], ['unassigned', '待整理']] as const).map(([group, label]) => {
      const modules = visible.filter(m => m.category === group);
      if (!modules.length) return null;
      return <section key={group} className="grid gap-3" aria-label={label}>
        <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">{group === "business" ? <BookOpen size={16} /> : group === "engineering" ? <Code2 size={16} /> : <FolderOpen size={16} />}{label}<span className="ml-1 tabular-nums">{modules.length}</span></h3>
        <div className="km-module-grid">{modules.map(module => {
          const state = maintenance(module), hits = needle ? module.documents.filter(d => `${d.title} ${knowledgeFileName(d)}`.toLocaleLowerCase().includes(needle)).slice(0, 3) : [];
          return <Card key={module.key} className="group border-line transition-colors hover:border-line-strong">
            <Button variant="ghost" className="h-auto w-full items-start justify-start whitespace-normal p-5 text-left" onClick={() => onOpenModule(module.key)} aria-label={`打开${module.name}知识目录`}>
              <div className="grid min-w-0 flex-1 gap-4"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-lg font-semibold leading-snug">{module.name}</h3><p className="mt-1 line-clamp-2 text-sm font-normal text-muted-foreground">{module.description || (module.category === "business" ? "模块整体规则、关联仓知识与 Skill" : "基础组件知识与 Skill")}</p></div><ChevronRight size={18} className="mt-1 text-muted-foreground" /></div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-normal"><span>文档 <strong className="font-medium tabular-nums">{module.documentCount}</strong></span><span>Skill <strong className="font-medium tabular-nums">{module.skillCount}</strong></span>{module.inactiveCount > 0 && <span className="text-muted-foreground">已停用 {module.inactiveCount}</span>}</div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs font-normal text-muted-foreground"><span className="inline-flex items-center gap-1.5" title={state.note}><span className={`size-2 rounded-full ${state.color}`} />{state.label}</span><span>{module.maintainedAt ? `最近维护 ${new Date(module.maintainedAt).toLocaleDateString("zh-CN")}` : "维护时间未知"}</span></div>
              </div>
            </Button>
            {hits.length > 0 && onOpenDocument && <div className="grid gap-1 border-t border-line px-4 py-2">{hits.map(doc => <Button key={doc.id} variant="ghost" size="sm" className="justify-start" onClick={() => onOpenDocument(doc.id, module.key)}><ArrowUpRight size={14} /><span className="truncate">{knowledgeFileName(doc)}</span></Button>)}</div>}
          </Card>;
        })}</div>
      </section>;
    })}
    {data && !visible.length && <div className="grid justify-items-center gap-3 py-16 text-muted-foreground"><FolderOpen size={30} /><p>{needle ? "没有匹配的目录或文稿" : "当前分类还没有知识目录"}</p>{needle && <Button variant="outline" onClick={() => setQuery("")}>清空搜索</Button>}</div>}
  </section>;
}
