import { CheckCircle2, ChevronRight, FileText, History, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** 同一任务内切换过程和文稿；研究结束后提示，不打断正在阅读的内容。 */
export function KnowledgeTaskNavigation({ value, onChange, documentCount, view, disabled = false }: {
  value: string; onChange: (value: "progress" | "review") => void; documentCount: number;
  view?: import("../../src/knowledgeProductionTypes").KnowledgeProductionView; disabled?: boolean;
}) {
  return <div className="knowledge-task-navigation">
    <nav aria-label="研究过程与文稿" className="knowledge-task-view-tabs">
      <Button size="sm" variant={value === "progress" ? "secondary" : "ghost"} aria-pressed={value === "progress"} disabled={disabled} onClick={() => onChange("progress")}><History size={16} />研究过程</Button>
      <Button size="sm" variant={value === "review" ? "secondary" : "ghost"} aria-pressed={value === "review"} disabled={disabled || !documentCount} onClick={() => onChange("review")}><FileText size={16} />文稿<span className="knowledge-task-document-count">{documentCount}</span></Button>
      {view?.navigation.working_label && <span className="knowledge-task-working" role="status"><LoaderCircle size={14} className="animate-spin" />{view.navigation.working_label}</span>}
    </nav>
    {value === "progress" && view?.navigation.ready_message && <div className="knowledge-task-ready" role="status">
      <CheckCircle2 size={18} /><span>{view.navigation.ready_message}</span>
      <Button size="sm" disabled={disabled} onClick={() => onChange("review")}>{view.navigation.ready_action_label}<ChevronRight size={15} /></Button>
    </div>}
  </div>;
}
