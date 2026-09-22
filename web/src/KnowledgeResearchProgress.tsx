import { useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";

type Evidence = Record<string, unknown>;
const categories = [
  { id: "browse", title: "浏览目录", description: "定位仓库范围与相关文件" },
  { id: "read", title: "读取源码", description: "核对实现、配置与测试" },
  { id: "search", title: "检索资料", description: "查找跨仓代码与业务依据" },
  { id: "changes", title: "核对变化", description: "比较来源版本与变更" },
  { id: "notes", title: "研究说明", description: "查看分析过程与阶段结论" },
  { id: "other", title: "其他记录", description: "补充研究依据" },
];
const actions: Record<string, string> = { list: "浏览目录", tree: "浏览目录", read: "读取文件", search: "搜索", knowledge_search: "检索业务知识", ar_fur_info: "查询功能信息", ar_idp_docs: "查询设计文档", ar_mr_diff: "查询代码变更", ar_history_similar: "查询相似历史" };
function category(event: Evidence) {
  if (event.tool === "research_note") return "notes";
  if (event.tool === "knowledge_source_changes") return "changes";
  if (event.tool === "business_knowledge" || event.tool === "code_search") return "search";
  if (event.tool === "component_source") return event.action === "read" ? "read" : event.action === "search" ? "search" : "browse";
  return "other";
}
const failed = (event: Evidence) => !!event.error || ["failed", "error"].includes(String(event.status));
const text = (value: unknown) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
function summary(event: Evidence) {
  const query = event.query && typeof event.query === "object" ? (event.query as Evidence).question ?? (event.query as Evidence).ar_code : event.query;
  return text(event.error ?? query ?? event.path ?? event.preview).replace(/\s+/g, " ").slice(0, 180) || "展开查看详细记录";
}

export function KnowledgeResearchProgress({ evidence }: { evidence: Evidence[] }) {
  const id = useId();
  const [opened, setOpened] = useState<string[]>([]), [onlyErrors, setOnlyErrors] = useState(false);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const errors = evidence.filter(failed).length;
  return <section className="knowledge-progress" aria-label="研究过程记录">
    <header className="knowledge-progress-toolbar"><div><strong>研究记录 <span className="text-muted-foreground font-normal">· {evidence.length} 条</span></strong><p className="mt-1 text-sm text-muted-foreground">按活动分组，展开查看文件和依据；最新记录在前</p></div>
      <div className="flex items-center gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyErrors} onChange={event => setOnlyErrors(event.target.checked)} />仅看异常{errors > 0 && `（${errors}）`}</label><Button variant="ghost" size="sm" disabled={!opened.length} onClick={() => setOpened([])}>全部折叠</Button></div>
    </header>
    {!evidence.length ? <p className="knowledge-progress-empty">研究开始后，进度和来源记录会显示在这里。</p> : onlyErrors && !errors ? <p className="knowledge-progress-empty">当前没有异常记录。</p> : categories.map(group => {
      const entries = evidence.map((event, index) => ({ event, index })).filter(({ event }) => category(event) === group.id && (!onlyErrors || failed(event))).reverse();
      if (!entries.length) return null;
      const open = opened.includes(group.id), limit = limits[group.id] ?? 20, errors = entries.filter(({ event }) => failed(event)).length;
      return <div key={group.id} className="knowledge-progress-group">
        <button type="button" className="knowledge-progress-heading" aria-expanded={open} aria-controls={`${id}-${group.id}`} onClick={() => setOpened(current => open ? current.filter(key => key !== group.id) : [...current, group.id])}>
          {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}<strong>{group.title}</strong><span className="knowledge-progress-count">{entries.length}</span><span className="knowledge-progress-description">{group.description}</span>{errors > 0 && <span className="knowledge-progress-error">{errors} 条异常</span>}
        </button>
        {open && <div id={`${id}-${group.id}`} className="knowledge-progress-entries"><ol>{entries.slice(0, limit).map(({ event, index }) => {
          const error = failed(event), timestamp = typeof event.at === "string" ? new Date(event.at) : undefined;
          return <li key={index}><details className="knowledge-progress-entry"><summary><span className={`knowledge-progress-dot${error ? " is-error" : ""}`} /><span className="knowledge-progress-action">{actions[String(event.action)] ?? group.title}</span><span className="knowledge-progress-summary" title={summary(event)}>{summary(event)}</span><span className={error ? "knowledge-progress-error" : "text-muted-foreground"}>{error ? "异常" : event.status === "empty" ? "无结果" : "已记录"}</span>{timestamp && !Number.isNaN(timestamp.getTime()) && <time dateTime={String(event.at)}>{timestamp.toLocaleTimeString("zh-CN", { hour12: false })}</time>}</summary>
            <div className="knowledge-progress-detail">{event.path != null && <p className="break-all text-muted-foreground">文件：{text(event.path)}</p>}{event.repository != null && <p className="break-all text-muted-foreground">仓库：{text(event.repository)}</p>}{event.error != null && <p className="text-danger whitespace-pre-wrap">{text(event.error)}</p>}
              {event.preview != null && (event.tool === "research_note" ? <Markdown text={text(event.preview)} /> : <pre>{text(event.preview)}</pre>)}
              {event.result != null && <pre>{text(event.result)}</pre>}
              <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer">完整记录</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
            </div>
          </details></li>;
        })}</ol>{entries.length > limit && <Button variant="ghost" size="sm" className="m-3" onClick={() => setLimits(current => ({ ...current, [group.id]: limit + 20 }))}>再显示 {Math.min(20, entries.length - limit)} 条（剩余 {entries.length - limit} 条）</Button>}</div>}
      </div>;
    })}
  </section>;
}
