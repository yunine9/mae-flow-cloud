import { useEffect, useState } from "react";
import { getIssueReviews, sendIssueReviews, updateIssueReview, dropIssueReview, type IssueReview } from "../api";
import { ReviewBody } from "../ReviewBody";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

export function IssueExternalReviewPanel({ id, canOperate }: { id: string; canOperate: boolean }) {
  const [items, setItems] = useState<IssueReview[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; mode: "context" | "reply"; text: string }>();
  const [page, setPage] = useState(0);
  const [closed, setClosed] = useState(false);
  async function load() { const result = await getIssueReviews(id); setItems(result.reviews.filter(item => item.external_review)); }
  useEffect(() => {
    let alive = true;
    const refresh = () => getIssueReviews(id).then(result => { if (alive) setItems(result.reviews.filter(item => item.external_review)); })
      .catch(error => { if (alive) setMessage(String(error)); });
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [id]);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setMessage("");
    try { await action(); setEditing(undefined); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const done = (item: IssueReview) => !!item.resolution || !!item.owner_reply || item.status === "verified";
  const pending = items.filter(item => !done(item) && item.status === "draft" && !item.agent_assigned);
  const shown = items.filter(item => done(item) === closed);
  const pages = Math.max(1, Math.ceil(shown.length / 8));
  const current = Math.min(page, pages - 1);
  if (!items.length && !message) return null;
  return <section className="grid gap-3 rounded-xl border border-border bg-surface p-4" aria-label="MR 检视批注">
    <header className="flex items-center justify-between gap-3">
      <div><h3 className="text-base font-semibold">MR 检视批注</h3>
        <p className="mt-1 text-sm text-muted-foreground">责任人先判断，再批量交办；本地答复、闭环或删除不代表远端讨论已解决。</p></div>
      {canOperate && <Button disabled={busy || !pending.length} onClick={() => void run(async () => {
        const result = await sendIssueReviews(id, pending.map(item => item.id));
        setMessage(result.stage_note || "已批量交办");
      })}>提交 {pending.length} 条修改意见</Button>}
    </header>
    <div className="flex gap-2">
      <Button size="sm" variant={!closed ? "default" : "outline"} onClick={() => { setClosed(false); setPage(0); }}>待判断与处理中</Button>
      <Button size="sm" variant={closed ? "default" : "outline"} onClick={() => { setClosed(true); setPage(0); }}>本地已闭环</Button>
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {shown.slice(current * 8, (current + 1) * 8).map(item => <article key={item.id} className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{item.author} · {item.file}{item.line ? `:${item.line}` : ""}</span>
        <span>{done(item) ? "本地已处理" : item.agent_assigned ? "已交办 · 待核对结果" : "待你判断"}</span>
      </div>
      <ReviewBody text={item.note} />
      {item.agent_context && <p className="whitespace-pre-wrap text-sm">责任人补充：{item.agent_context.text}</p>}
      {item.owner_reply && <p className="whitespace-pre-wrap text-sm">自行答复：{item.owner_reply.text}</p>}
      <div className="flex items-center gap-2">
        {item.external_review?.mr_url && /^https?:\/\//.test(item.external_review.mr_url) && <a className="rounded-md border border-border px-3 py-1.5 text-sm text-ink" href={item.external_review.mr_url} target="_blank" rel="noreferrer">打开 MR</a>}
        {canOperate && !done(item) && !item.agent_assigned && <>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: item.id, mode: "context", text: item.agent_context?.text ?? "" })}>补充修改要求</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: item.id, mode: "reply", text: "" })}>自行答复</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => dropIssueReview(id, item.id))}>删除</Button>
        </>}
        {canOperate && !item.resolution && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => updateIssueReview(id, item.id, { resolve: true }))}>本地闭环</Button>}
      </div>
      {editing?.id === item.id && <div className="grid gap-2">
        <Textarea rows={3} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })}
          placeholder={editing.mode === "context" ? "保存要求后，再统一批量交办；不会自动启动 Agent" : "写下你的处理说明，不会发到远端 MR"} />
        <div className="flex gap-2"><Button size="sm" disabled={busy || (editing.mode === "reply" && !editing.text.trim())}
          onClick={() => void run(() => updateIssueReview(id, item.id, { [editing.mode]: editing.text }))}>保存</Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(undefined)}>取消</Button></div>
      </div>}
    </article>)}
    {pages > 1 && <div className="flex items-center justify-end gap-3 text-sm">
      <Button size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</Button>
      <span>{current + 1} / {pages}</span><Button size="sm" variant="outline" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</Button>
    </div>}
  </section>;
}
