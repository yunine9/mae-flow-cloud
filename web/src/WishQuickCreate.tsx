import { useState } from "react";
import { createWish } from "./api";
import { Modal } from "./ui/Modal";

export function QuickWishButton({ onOpenWall, inline = false }: { onOpenWall: () => void; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

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
    <button type="button" className={inline ? "wish-quick-inline" : "wish-quick-trigger"}
      aria-label="快速提问题" title="快速提问题"
      onClick={() => { setOpen(true); setMessage(""); }}>
      <span aria-hidden>✦</span><strong>提问题</strong>
    </button>
    <Modal open={open} onClose={() => setOpen(false)}
      labelledBy="wish-quick-title" width="min(460px, 100%)">
      <form onSubmit={submit}>
        <header className="ui-modal-head">
          <div><small>快速反馈</small>
            <h2 id="wish-quick-title">快速提个问题</h2></div>
          <button type="button" className="ui-btn ghost sm" aria-label="关闭"
            onClick={() => setOpen(false)}>×</button>
        </header>
        <label className="ui-field"><span>一句话说明问题</span>
          <input autoFocus required maxLength={100} value={title}
            placeholder="哪里不好用，或者哪里不符合预期？"
            onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="ui-field"><span>补充现场 <small>（可选）</small></span>
          <textarea rows={4} maxLength={2000} value={detail}
            placeholder="刚才做了什么、希望变成什么样"
            onChange={(event) => setDetail(event.target.value)} /></label>
        {message && <p role="status">{message}</p>}
        <footer className="ui-modal-foot">
          <button type="button" className="ui-btn"
            onClick={() => { setOpen(false); onOpenWall(); }}>
            查看许愿墙
          </button>
          <button type="submit" className="ui-btn primary" disabled={busy || !title.trim()}>
            {busy ? "提交中…" : "提交问题"}
          </button>
        </footer>
      </form>
    </Modal>
  </>;
}
