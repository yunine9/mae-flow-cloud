import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function KnowledgeExtractionStages({ value, onChange, label, cleanup = false, draftOnly = false, codeOnly = false }: { value: string; onChange: (value: string) => void; label: string; cleanup?: boolean; draftOnly?: boolean; codeOnly?: boolean }) {
  return <nav className="mb-4 flex gap-2" aria-label={label}>{[...(cleanup ? [["cleanup", "清理旧知识"]] : []), ["inputs", codeOnly ? "范围与来源" : "范围与资料"], ["progress", "研究过程"], ["review", draftOnly ? "查看验证草稿" : "审查与修订"], ...(!draftOnly ? [["publish", "入库与更新"]] : [])].map(([key, title]) => <Button key={key} size="sm" variant={value === key ? "default" : "outline"} onClick={() => onChange(key)}>{title}</Button>)}</nav>;
}

export function KnowledgeExtractionWorkspace({ title, sidebar, children, onNew, onClose, actions, cleanup = false, draftOnly = false, codeOnly = false }: {
  codeOnly?: boolean; draftOnly?: boolean; cleanup?: boolean; title: string; sidebar?: ReactNode; children: ReactNode; onNew?: () => void; onClose?: () => void; actions?: ReactNode;
}) {
  return <section className="tw-root knowledge-extraction-workspace" aria-label={`${title}工作区`}>
    <header className="knowledge-extraction-header">
      {onClose && <Button variant="outline" onClick={onClose}>← 返回知识文档</Button>}
      <div className="mr-auto"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{codeOnly ? "基础仓与 everycode → 分项研究与评审 → 人工修订 → 入库与更新" : draftOnly ? "指定模块与资料 → 后台研究 → 查看验证草稿" : cleanup ? "范围与资料 → 清理旧知识 → 后台研究 → 人工审查 → 入库与更新" : "范围与资料 → 后台研究 → 人工审查与修订 → 入库与更新"}</p></div>
      {actions}{onNew && <Button onClick={onNew}>＋ 新建萃取任务</Button>}
    </header>
    <div className={`knowledge-extraction-body${sidebar ? " has-sidebar" : ""}`}>
      {sidebar && <aside className="knowledge-extraction-jobs" aria-label="萃取任务列表">{sidebar}</aside>}
      <div className="knowledge-extraction-content">{children}</div>
    </div>
  </section>;
}
