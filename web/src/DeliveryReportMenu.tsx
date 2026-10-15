import { useState } from "react";
import { generateDeliveryReport, type TaskSummary } from "./api";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu";

export function DeliveryReportMenu({ task, available, canOperate, onOpen, onChanged }: {
  task: TaskSummary; available: boolean; canOperate: boolean; onOpen: () => void; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const report = task.delivery_report;
  const canGenerate = canOperate && !!task.delivery?.mr_url && !!task.delivery.git_push?.sha
    && !task.workspace_reclaimed_at && task.status !== "canceled"
    && (!task.continuation || task.continuation.state === "active");
  if (!available && !report && !canGenerate) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />} aria-label="交付报告操作">
      报告 <span aria-hidden>⌄</span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-60">
      {available && <DropdownMenuItem onClick={onOpen}>查看交付报告</DropdownMenuItem>}
      {canGenerate && <DropdownMenuItem closeOnClick={false} disabled={busy || report?.status === "running"} onClick={async () => {
        setBusy(true); setError("");
        try { await generateDeliveryReport(task.id); onChanged(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      }}>{busy || report?.status === "running" ? "生成中…" : report?.status === "failed" ? "重试生成" : available ? "更新报告" : "生成报告"}</DropdownMenuItem>}
      {(error || report?.message) && <p role={error || report?.status === "failed" ? "alert" : "status"}
        className="m-0 px-1.5 py-2 text-xs leading-relaxed text-muted-foreground break-words">{error || report?.message}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
