import { useEffect, useState } from "react";
import { FileText, Sparkles, MessageSquareQuote } from "lucide-react";
import { reviewTaskMemory, type MemoryRecord } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

/** 边界与结论一起持久化、检索，避免推荐时遗漏限定条件。 */
const boundaryMarker = /\n\s*适用例外[：:]/;
export function MemoryReviewEditor({ record, taskId, onChanged, onDismiss, onDirty }: {
  record: MemoryRecord; taskId: string; onChanged: () => Promise<void>; onDismiss: () => void; onDirty: (dirty: boolean) => void;
}) {
  const parts = record.conclusion.split(boundaryMarker);
  const [trigger, setTrigger] = useState(record.trigger);
  const [conclusion, setConclusion] = useState(parts[0]);
  const [exceptions, setExceptions] = useState(parts.slice(1).join("\n适用例外：").trim());
  const [scope, setScope] = useState(record.scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accepted = record.review?.status === "accepted";
  const active = !record.withdrawn && !record.superseded_by && !record.archived;
  const editable = record.can_review && !accepted && active;
  useEffect(() => {
    onDirty(trigger !== record.trigger || conclusion !== parts[0] || exceptions !== parts.slice(1).join("\n适用例外：").trim() || scope !== record.scope);
  }, [trigger, conclusion, exceptions, scope, record, onDirty]);
  async function decide(decision: "accepted" | "rejected") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await reviewTaskMemory(taskId, record, { decision, trigger, scope,
        conclusion: conclusion.trim() + (exceptions.trim() ? `\n\n适用例外：${exceptions.trim()}` : "") });
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="grid min-w-0 grid-cols-2 items-stretch gap-4 text-[16px]">
    <section className="min-w-0 rounded-xl border border-border bg-surface">
      <h3 className="flex items-center gap-2 border-b border-border p-4 font-semibold"><FileText className="size-5 text-primary" />事实与依据</h3>
      <div className="grid gap-4 p-4">
        <div className="text-sm text-muted-foreground">{record.repo} · {record.task}<p className="mt-1 break-all">来源标识：{record.evidence}</p></div>
        {(record.problem || record.quote) && <div className="rounded-lg border border-border p-4">
          <h4 className="mb-3 flex items-center gap-2 font-medium"><MessageSquareQuote className="size-4" />原始反馈</h4>
          {record.problem && <p className="whitespace-pre-wrap break-words">{record.problem}</p>}
          {record.quote && <blockquote className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words border-l-2 border-primary/30 bg-muted/50 p-3 text-sm">{record.quote}</blockquote>}
        </div>}
        <div className="rounded-lg border border-border p-4"><h4 className="mb-3 font-medium">当时记录的处理结论</h4>
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{record.basis?.conclusion ?? record.review?.original?.conclusion ?? record.conclusion}</p>
          <p className="mt-3 text-sm text-muted-foreground">处理回执不等于验证证明。具体代码与测试请在来源任务中核对，证据不足可以暂不采纳。</p>
        </div>
        {record.review?.original && <details className="text-sm"><summary className="cursor-pointer">查看人工编辑前的候选</summary><p className="mt-2 whitespace-pre-wrap break-words">{record.review.original.conclusion}</p></details>}
      </div>
    </section>
    <section className="min-w-0 rounded-xl border border-border bg-surface">
      <h3 className="flex items-center gap-2 border-b border-border p-4 font-semibold"><Sparkles className="size-5 text-primary" />{editable ? "AI 提炼 · 可直接修改" : accepted ? "已采纳经验" : "经验记录"}</h3>
      <div className="grid gap-4 p-4">
        <label className="grid gap-2 font-medium">什么情况下使用<Input className="h-10 text-[16px] md:text-[16px]" value={trigger} disabled={!editable || busy} maxLength={80} onChange={event => setTrigger(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">经验结论<Textarea className="text-[16px] font-normal md:text-[16px]" rows={4} value={conclusion} disabled={!editable || busy}
          placeholder="提炼可迁移的判断方法、做法与依据，不只复述本次修复。" onChange={event => setConclusion(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">适用例外<Textarea className="text-[16px] font-normal md:text-[16px]" rows={3} value={exceptions} disabled={!editable || busy}
          placeholder="什么前提下成立？哪些情况不能照搬？还缺什么证据？" onChange={event => setExceptions(event.target.value)} /></label>
        <label className="grid gap-2 font-medium">复用范围<select className="rounded-md border border-border bg-surface p-2 font-normal" value={scope} disabled={!editable || busy}
          onChange={event => setScope(event.target.value as MemoryRecord["scope"])}>
          <option value="local">本仓相关位置</option><option value="general">本仓通用</option>
          <option value="platform">跨仓通用</option><option value="one_off">仅检索参考，不主动推荐</option>
        </select><span className="text-sm font-normal text-muted-foreground">跨仓通用需确认结论不依赖当前仓库的特殊条件。</span></label>
      </div>
    </section>
    <footer className="sticky bottom-0 z-10 col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="text-sm text-muted-foreground"><p>采纳后供后续任务按范围检索和使用，不阻塞原任务。</p>
        {record.review?.by && <p>最近处理：{record.review.by} · {record.review.at ? new Date(record.review.at).toLocaleString() : ""}</p>}
        {!record.can_review && <p>由任务责任人或管理员确认是否采纳。</p>}</div>
      <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={onDismiss}>{editable ? "暂不处理" : "返回列表"}</Button>
        {editable && <><Button variant="outline" disabled={busy} onClick={() => void decide("rejected")}>不采纳，保留记录</Button>
          <Button disabled={busy || !trigger.trim() || !conclusion.trim()} onClick={() => void decide("accepted")}>采纳为可复用经验</Button></>}
        {accepted && record.can_review && active && <Button variant="outline" disabled={busy} onClick={() => void decide("rejected")}>撤销采纳</Button>}
      </div>
      {error && <p role="alert" className="w-full text-destructive">{error}</p>}
    </footer>
  </div>;
}
