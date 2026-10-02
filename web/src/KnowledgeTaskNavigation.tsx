import { CheckCircle2, ChevronRight, FileText, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** 同一任务内切换过程和文稿；研究结束后提示，不打断正在阅读的内容。 */
export function KnowledgeTaskNavigation({ value, onChange, documentCount, working, status, modifying = false, published = false, disabled = false }: {
  value: string; onChange: (value: "progress" | "review") => void; documentCount: number;
  working: boolean; status: string; modifying?: boolean; published?: boolean; disabled?: boolean;
}) {
  const ready = !working && status === "done" && documentCount > 0;
  return <div className="knowledge-task-navigation">
    <nav aria-label="研究过程与文稿" className="knowledge-task-view-tabs">
      <Button size="sm" variant={value === "progress" ? "secondary" : "ghost"} aria-pressed={value === "progress"} disabled={disabled} onClick={() => onChange("progress")}><History size={16} />研究过程</Button>
      <Button size="sm" variant={value === "review" ? "secondary" : "ghost"} aria-pressed={value === "review"} disabled={disabled || !documentCount} onClick={() => onChange("review")}><FileText size={16} />文稿<span className="knowledge-task-document-count">{documentCount}</span></Button>
      {working && <span className="knowledge-task-working" role="status"><LoaderCircle size={14} className="animate-spin" />{modifying ? "修改中" : "研究中"}</span>}
    </nav>
    {value === "progress" && ready && <div className="knowledge-task-ready" role="status">
      <CheckCircle2 size={18} /><span>{published ? "知识已发布，可继续阅读文稿和查看研究记录。" : modifying ? "修改完成，新稿待你检视。" : `研究完成，${documentCount} 份文稿待你检视。`}</span>
      <Button size="sm" disabled={disabled} onClick={() => onChange("review")}>{published ? "查看文稿" : modifying ? "查看修改" : "检视文稿"}<ChevronRight size={15} /></Button>
    </div>}
  </div>;
}
