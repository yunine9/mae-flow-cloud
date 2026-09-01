import { useEffect, useState } from "react";
import { createWish } from "./api";

export function QuickWishButton({ onOpenWall }: { onOpenWall: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [open]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setMessage("");
    try {
      await createWish({ kind: "issue", title: title.trim(),
        detail: detail.trim() || undefined, images: [] });
      setTitle(""); setDetail(""); setMessage("问题已提交到许愿墙");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "提交失败，请重试");
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" className="wish-quick-trigger"
      aria-label="快速提问题" title="快速提问题"
      onClick={() => { setOpen(true); setMessage(""); }}>
      <span aria-hidden>✦</span><strong>提问题</strong>
    </button>
    {open && <div className="wish-quick-backdrop" role="dialog"
      aria-modal="true" aria-labelledby="wish-quick-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}>
      <form className="wish-quick-dialog" onSubmit={submit}>
        <header><div><small>QUICK FEEDBACK</small>
          <h2 id="wish-quick-title">快速提个问题</h2></div>
          <button type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
        </header>
        <label><span>一句话说明问题</span>
          <input autoFocus required maxLength={100} value={title}
            placeholder="哪里不好用，或者哪里不符合预期？"
            onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>补充现场 <small>（可选）</small></span>
          <textarea rows={4} maxLength={2000} value={detail}
            placeholder="刚才做了什么、希望变成什么样"
            onChange={(event) => setDetail(event.target.value)} /></label>
        {message && <p role="status">{message}</p>}
        <footer>
          <button type="button" onClick={() => { setOpen(false); onOpenWall(); }}>
            查看许愿墙
          </button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? "提交中…" : "提交问题"}
          </button>
        </footer>
      </form>
    </div>}
  </>;
}
