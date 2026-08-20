/**
 * 批注清单:记录批注内容、提交状态和原位置变化。
 *
 * 进展这一栏只报**事实**,不下"已采纳"这种结论:
 * - 锚定的原文还在(不论挪没挪行)→ 它还没改这里
 * - 原文已不在 → 这处已经被改动
 * 是不是照你说的改的,你看了再说——系统替你判断"采纳了"就是推断,
 * 而推断错了比不显示更坏(你会以为提过的都落实了)。
 *
 * 踩过的坑(2026-08-19 内网实锤):moved(原文还在,只是行号变了)
 * 一度也被当"已被改动·请你确认"。agent 在跑,别处任何改动都会让
 * 行号漂移——批注打在工作区变更(diff)上时更是全文重排,刚送出的
 * 批注秒变"已修改请检视",而批的那处一个字没动。位置漂移只是定位
 * 信息(脚注里如实标),"被改动"的判据只有一个:原文没了。
 *
 * 没有"批注管理页":这块面板就长在工作台里,跟材料和决定同屏。
 */

import { useEffect, useState } from "react";
import {
  dropAnnotation,
  editAnnotation,
  judgeAnnotation,
  sendAnnotations,
  type Annotation,
  type AnchorCheck,
} from "./api";
import { shortPath } from "./paths";
import { relativeTime } from "./time";
import "./annotate.css";

const ANCHOR_TEXT: Record<AnchorCheck["state"], string> = {
  hit: "定位正常",
  moved: "原文仍在,行号有漂移(定位已跟随)",
  gone: "原位置内容已删除",
  ambiguous: "存在多个匹配位置",
};

/** 一条批注此刻处在哪。检视闭环的五站:
 * 待提交 → 已提交 → 已被改动·请你确认 → 确认通过 / 返工(回到待提交)。 */
function progressOf(item: Annotation, check?: AnchorCheck): {
  tone: "draft" | "waiting" | "review" | "done";
  text: string;
  hint?: string;
} {
  if (item.status === "verified") {
    return { tone: "done", text: "确认通过",
             hint: "你已确认这处改动符合要求。" };
  }
  if (item.status !== "sent") {
    return item.rework
      ? { tone: "draft", text: `第 ${item.rework + 1} 轮·待提交`,
          hint: "上一轮改动没达到要求,这条已退回,提交后会再送给 AI。" }
      : { tone: "draft", text: "待提交" };
  }
  // "被改动"只认一个判据:锚定的原文消失了。行号漂移(moved)不算——
  // 原文还在就说明它还没改这处,只是别处的改动把行挤动了。
  return check?.state === "gone"
    ? { tone: "review", text: "已被改动·请你确认",
        hint: "你批注的那段原文已经不在了。是不是照你说的改的,系统不替你判断,请回到原位看一眼。" }
    : { tone: "waiting", text: "已提交" };
}

function deliveryText(item: Annotation): string {
  if (item.status === "verified") return "已确认";
  if (item.status !== "sent") return "尚未提交";
  return item.sent_via === "decision" ? "通过审批提交" : "执行中发送";
}

export function AnnotationPanel({
  taskId,
  viewerUsername,
  items,
  checks,
  reply,
  canOperate,
  running,
  onChanged,
  onLocate,
}: {
  taskId: string;
  viewerUsername: string;
  items: Annotation[];
  checks: AnchorCheck[];
  /** 最后一批送出后 AI 的原话。不做逐条对应——配错了比不显示更害人。 */
  reply?: { texts: string[]; truncated: boolean };
  canOperate: boolean;
  /** 点一条回到材料里那一行——改批注前人几乎总要再看一眼上下文。 */
  onLocate?: (item: Annotation) => void;
  /** 只有在跑的时候才能插话送出;等人决定时批注走决定卡。 */
  running: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [mutationBusy, setMutationBusy] = useState("");
  const [error, setError] = useState("");
  const drafts = items.filter((item) => item.status === "draft");
  const [open, setOpen] = useState(drafts.length > 0);

  useEffect(() => {
    if (drafts.length > 0) setOpen(true);
  }, [drafts.length]);

  if (!items.length) return null;
  const checkOf = (id: string) => checks.find((check) => check.id === id);

  async function send() {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await sendAnnotations(taskId);
    setBusy(false);
    if (result.error) setError(result.error);
    onChanged();
  }

  return (
    <details className="annot-panel" aria-label="批注" open={open}
             onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="annot-panel-head">
        <div>
          <span>REVIEW NOTES</span>
          <strong>批注</strong>
        </div>
        <div className="annot-panel-summary-side">
          <div className="annot-panel-counts">
            <span>{items.length} 条</span>
            {drafts.length > 0 && <em>{drafts.length} 条待提交</em>}
          </div>
          <i className="annot-panel-chevron" aria-hidden />
        </div>
      </summary>
      {canOperate && drafts.length > 0 && running && (
        <div className="annot-panel-actions">
          <button type="button" className="primary" disabled={busy}
                  onClick={() => void send()}>
            {busy ? "提交中…" : `提交 ${drafts.length} 条批注`}
          </button>
        </div>
      )}

      {canOperate && drafts.length > 0 && !running && (
        <p className="annot-panel-note">
          有 {drafts.length} 条批注待提交。完成当前审批时，可选择将它们作为修改说明一并提交。
        </p>
      )}
      {error && <div className="alert">{error}</div>}

      <ol className="annot-list">
        {items.map((item) => {
          const check = checkOf(item.id);
          const progress = progressOf(item, check);
          const isAuthor = item.author === viewerUsername;
          const editing = editingId === item.id;
          return (
            <li key={item.id} className={`annot-item ${progress.tone}`}>
              <div className="annot-item-head">
                <button type="button" className="annot-where"
                        onClick={() => onLocate?.(item)}
                        title={`回到 ${item.file}:${check?.line ?? item.line}`}>
                  <code>{shortPath(item.file)}:{check?.line ?? item.line}</code>
                </button>
                <span className={`annot-progress ${progress.tone}`}
                      title={progress.hint}>
                  {progress.text}
                </span>
              </div>
              {editing ? (
                <div className="annot-inline-editor">
                  <textarea value={editingNote} autoFocus rows={3}
                            aria-label="修改批注意见"
                            onChange={(event) => setEditingNote(event.target.value)} />
                  <div>
                    <span>{item.status === "draft"
                      ? "保存后仍在待提交清单中。"
                      : "修改后会回到待提交，避免新内容被误认为已经送达。"}</span>
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => { setEditingId(""); setEditingNote(""); }}>
                      取消
                    </button>
                    <button type="button" className="primary"
                            disabled={!editingNote.trim() || !!mutationBusy}
                            onClick={async () => {
                              setMutationBusy(item.id);
                              setError("");
                              const result = await editAnnotation(
                                taskId, item.id, editingNote);
                              setMutationBusy("");
                              if (result.error) setError(result.error);
                              else { setEditingId(""); setEditingNote(""); }
                              onChanged();
                            }}>
                      {mutationBusy === item.id ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              ) : <p className="annot-note">{item.note}</p>}
              <blockquote className="annot-anchor"><span>针对</span>{item.anchor}</blockquote>
              <div className="annot-item-foot">
                <small>
                  {deliveryText(item)} · {item.author} · {relativeTime(item.created_at)}
                  {item.edited_at && " · 已编辑"}
                  {check && check.state !== "hit"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {isAuthor && !editing && (
                  <span className="annot-owner-actions">
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy}
                            onClick={() => {
                              setEditingId(item.id);
                              setEditingNote(item.note);
                            }}>编辑</button>
                    <button type="button" className="ghost danger"
                            disabled={!!mutationBusy} onClick={async () => {
                      setMutationBusy(item.id);
                      setError("");
                      const result = await dropAnnotation(taskId, item.id);
                      setMutationBusy("");
                      if (result.error) setError(result.error);
                      onChanged();
                    }}>删除</button>
                  </span>
                )}
                {/* 检视闭环的裁决:提过的意见不能停在"请你确认"没有下文。
                    通过=收口;返工=退回待提交,下一次提交再送给 AI。 */}
                {item.status === "sent" && isAuthor && !editing && (
                  <span className="annot-verdict">
                    <button type="button" className="ghost"
                            disabled={!!mutationBusy} onClick={async () => {
                      const result = await judgeAnnotation(taskId, item.id, "reopen");
                      if (result.error) setError(result.error);
                      onChanged();
                    }}>返工</button>
                    <button type="button" className="approve"
                            disabled={!!mutationBusy} onClick={async () => {
                      const result = await judgeAnnotation(taskId, item.id, "verify");
                      if (result.error) setError(result.error);
                      onChanged();
                    }}>确认通过</button>
                  </span>
                )}
              </div>
              {/* 靶子变了要说清:意见可能已经过期,送过去轻则白烧一轮,
                  重则让它改回去。撤不撤是人的判断,这里只把事实摊开。 */}
              {item.status === "draft" && check?.state === "gone" && (
                <div className="annot-stale">
                  原位置内容已经删除{check.now ? `，当前位置内容为「${check.now}」` : ""}。
                  请确认这条批注是否仍然有效。
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* AI 收到批注后的原话。护栏要求它逐条回复"改了什么/为什么不改",
          那段话原来只躺在会话流里——不同意的批注在面板上就永远停在
          "已提交",人干等一个不会来的改动。这里原样摆出来,对应关系
          人自己看:从自由文本里猜"第几段对第几条",配错了更害人。 */}
      {reply && reply.texts.length > 0 && (
        <details className="annot-reply">
          <summary>送出之后 AI 说了什么({reply.texts.length} 段)</summary>
          <p className="annot-reply-note">
            原话未做逐条对应,请对照各条自行核对;不服就点那条的「返工」。
          </p>
          {reply.texts.map((text, at) => (
            <blockquote key={at}>{text}</blockquote>
          ))}
          {reply.truncated && <p className="annot-reply-note">(太长截断,完整内容见执行动态)</p>}
        </details>
      )}
    </details>
  );
}
