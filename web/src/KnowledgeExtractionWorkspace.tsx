import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function KnowledgeExtractionStages({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <nav className="mb-4 flex gap-2" aria-label={label}>{[["inputs", "范围与资料"], ["progress", "研究过程"], ["review", "审查与修订"], ["publish", "入库与更新"]].map(([key, title]) => <Button key={key} size="sm" variant={value === key ? "default" : "outline"} onClick={() => onChange(key)}>{title}</Button>)}</nav>;
}

export function KnowledgeExtractionWorkspace({ title, sidebar, children, onNew, onClose, actions }: {
  title: string; sidebar?: ReactNode; children: ReactNode; onNew?: () => void; onClose?: () => void; actions?: ReactNode;
}) {
  return <section className="tw-root knowledge-extraction-workspace" aria-label={`${title}工作区`}>
    <header className="knowledge-extraction-header">
      {onClose && <Button variant="outline" onClick={onClose}>← 返回知识文档</Button>}
      <div className="mr-auto"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">范围与资料 → 后台研究 → 人工审查与修订 → 入库与更新</p></div>
      {actions}{onNew && <Button onClick={onNew}>＋ 新建萃取任务</Button>}
    </header>
    <div className={`knowledge-extraction-body${sidebar ? " has-sidebar" : ""}`}>
      {sidebar && <aside className="knowledge-extraction-jobs" aria-label="萃取任务列表">{sidebar}</aside>}
      <div className="knowledge-extraction-content">{children}</div>
    </div>
  </section>;
}
