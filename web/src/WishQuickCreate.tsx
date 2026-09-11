import { useState } from "react";
import { createWish } from "./api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <DialogContent className="tw-root sm:max-w-[460px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>快速提个问题</DialogTitle>
            <DialogDescription>快速反馈</DialogDescription>
          </DialogHeader>
          <label className="ui-field"><span>一句话说明问题</span>
            <input autoFocus required maxLength={100} value={title}
              placeholder="哪里不好用，或者哪里不符合预期？"
              onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="ui-field"><span>补充现场 <small>（可选）</small></span>
            <textarea rows={4} maxLength={2000} value={detail}
              placeholder="刚才做了什么、希望变成什么样"
              onChange={(event) => setDetail(event.target.value)} /></label>
          {message && <p role="status">{message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline"
              onClick={() => { setOpen(false); onOpenWall(); }}>
              查看许愿墙
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? "提交中…" : "提交问题"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
