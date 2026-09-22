import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";

type Evidence = Record<string, unknown>;
const actions: Record<string, string> = { list: "浏览目录", tree: "浏览目录", read: "读取文件", search: "搜索源码", kw: "搜索跨仓调用", nls: "查找相关代码", knowledge_search: "检索业务知识", ar_fur_info: "查询功能信息", ar_idp_docs: "查询设计文档", ar_mr_diff: "查询代码变更", ar_history_similar: "查询相似历史" };
const failed = (event: Evidence) => !!event.error || ["failed", "error"].includes(String(event.status));
const text = (value: unknown) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
function summary(event: Evidence) {
  const query = event.query && typeof event.query === "object" ? (event.query as Evidence).question ?? (event.query as Evidence).ar_code : event.query;
  const context = text(query || (Array.isArray(event.keywords) ? event.keywords.join("、") : "") || event.path || (event.action === "list" ? "仓库根目录" : event.preview));
  return text(event.error || context || "查看详细记录").replace(/[#*`]/g, "").replace(/\s+/g, " ").slice(0, 180);
}

export function KnowledgeResearchProgress({ evidence }: { evidence: Evidence[] }) {
  const root = useRef<HTMLElement>(null);
  const [limit, setLimit] = useState(40);
  // 后台按发生顺序追加；无时间戳的旧记录也保留在原来的位置。
  const entries = evidence.map((event, index) => ({ event, index }));
  const visible = entries.slice(-limit), errors = evidence.filter(failed).length;
  return <section ref={root} className="knowledge-progress" aria-label="研究过程记录">
    <header className="knowledge-progress-toolbar"><div><strong>研究动态 <span className="text-muted-foreground font-normal">· {evidence.length} 条</span></strong><p className="mt-1 text-sm text-muted-foreground">按时间顺序展示，展开查看详情{errors > 0 && <span className="knowledge-progress-error"> · {errors} 条异常</span>}</p></div>
      <Button variant="ghost" size="sm" onClick={() => root.current?.querySelectorAll("details[open]").forEach(node => { (node as HTMLDetailsElement).open = false; })}>全部折叠</Button>
    </header>
    {!evidence.length ? <p className="knowledge-progress-empty">研究开始后，Agent 的工作进展会显示在这里。</p> : <div className="knowledge-progress-entries">
      {entries.length > limit && <Button variant="ghost" size="sm" className="m-3" onClick={() => setLimit(current => current + 40)}>查看更早的 {Math.min(40, entries.length - limit)} 条动态</Button>}
      <ol>{visible.map(({ event, index }) => {
        const error = failed(event), timestamp = typeof event.at === "string" ? new Date(event.at) : undefined;
        const action = event.tool === "research_note" ? "分析与整理" : event.tool === "knowledge_source_changes" ? "核对来源变化" : actions[String(event.action)] ?? "研究进展";
        return <li key={index}><details className="knowledge-progress-entry"><summary>
          {timestamp && !Number.isNaN(timestamp.getTime()) && <time dateTime={String(event.at)}>{timestamp.toLocaleTimeString("zh-CN", { hour12: false })}</time>}
          <span className={`knowledge-progress-dot${error ? " is-error" : ""}`} /><span className="knowledge-progress-action">{action}</span><span className="knowledge-progress-summary" title={summary(event)}>{summary(event)}</span>
          {error ? <span className="knowledge-progress-error">异常</span> : event.status === "empty" ? <span className="text-muted-foreground">无结果</span> : null}
        </summary><div className="knowledge-progress-detail">
          {event.path != null && <p className="break-all text-muted-foreground">文件：{text(event.path)}</p>}{event.repository != null && <p className="break-all text-muted-foreground">仓库：{text(event.repository)}</p>}{event.error != null && <p className="text-danger whitespace-pre-wrap">{text(event.error)}</p>}
          {event.preview != null && (event.tool === "research_note" ? <Markdown text={text(event.preview)} /> : <pre>{text(event.preview)}</pre>)}
          {event.result != null && <pre>{text(event.result)}</pre>}
          <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer">完整记录</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
        </div></details></li>;
      })}</ol>
    </div>}
  </section>;
}
