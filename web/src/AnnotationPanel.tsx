/**
 * 批注清单:我圈了哪些、送出去没有、它动了没有。
 *
 * 进展这一栏只报**事实**,不下"已采纳"这种结论:
 * - 原文还在原处 → 它还没碰这里
 * - 原文挪到第 N 行 / 原文已不在 → 这处已经被改动
 * 是不是照你说的改的,你看了再说——系统替你判断"采纳了"就是推断,
 * 而推断错了比不显示更坏(你会以为提过的都落实了)。
 *
 * 没有"批注管理页":这块面板就长在工作台里,跟材料和决定同屏。
 */

import { useState } from "react";
import {
  dropAnnotation,
  sendAnnotations,
  type Annotation,
  type AnchorCheck,
} from "./api";
import "./annotate.css";

const ANCHOR_TEXT: Record<AnchorCheck["state"], string> = {
  hit: "原文还在原处",
  moved: "原文已挪位",
  gone: "原文已不在",
  ambiguous: "原文有多处同样内容",
};

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 一条批注此刻处在哪:草稿 / 已送出待回应 / 已送出且那处已变。 */
function progressOf(item: Annotation, check?: AnchorCheck): {
  tone: "draft" | "waiting" | "touched";
  text: string;
} {
  if (item.status !== "sent") return { tone: "draft", text: "待送出" };
  const changed = check && (check.state === "gone" || check.state === "moved");
  const how = item.sent_via === "decision" ? "随决定提交" : "已插话送出";
  return changed
    ? { tone: "touched", text: `${how} · 这处已被改动` }
    : { tone: "waiting", text: `${how} · 那处还没动` };
}

export function AnnotationPanel({
  taskId,
  items,
  checks,
  canOperate,
  running,
  onChanged,
}: {
  taskId: string;
  items: Annotation[];
  checks: AnchorCheck[];
  canOperate: boolean;
  /** 只有在跑的时候才能插话送出;等人决定时批注走决定卡。 */
  running: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!items.length) return null;
  const drafts = items.filter((item) => item.status === "draft");
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
    <section className="annot-panel" aria-label="我的批注">
      <header className="annot-panel-head">
        <div>
          <span>MY NOTES</span>
          <strong>
            我圈了 {items.length} 处
            {drafts.length > 0 && ` · ${drafts.length} 处还没送出`}
          </strong>
        </div>
        {canOperate && drafts.length > 0 && running && (
          <button type="button" className="primary" disabled={busy}
                  onClick={() => void send()}>
            {busy ? "发送中…" : `发给它（${drafts.length} 处）`}
          </button>
        )}
      </header>

      {canOperate && drafts.length > 0 && !running && (
        <p className="annot-panel-note">
          它这会儿没在跑。等它问你时，这 {drafts.length} 处会作为「需要修改」
          的理由一起提交，不用你再复述一遍。
        </p>
      )}
      {error && <div className="alert">{error}</div>}

      <ol className="annot-list">
        {items.map((item) => {
          const check = checkOf(item.id);
          const progress = progressOf(item, check);
          return (
            <li key={item.id} className={`annot-item ${progress.tone}`}>
              <div className="annot-item-head">
                <code className="annot-where">
                  {item.file}:{check?.line ?? item.line}
                </code>
                <span className={`annot-progress ${progress.tone}`}>
                  {progress.text}
                </span>
              </div>
              <blockquote className="annot-anchor">{item.anchor}</blockquote>
              <p className="annot-note">{item.note}</p>
              <div className="annot-item-foot">
                <small>
                  {item.author} · {relative(item.created_at)}
                  {check && check.state !== "hit"
                    && ` · ${ANCHOR_TEXT[check.state]}`}
                </small>
                {item.status === "draft" && canOperate && (
                  <button type="button" className="ghost" onClick={async () => {
                    const result = await dropAnnotation(taskId, item.id);
                    if (result.error) setError(result.error);
                    onChanged();
                  }}>删掉</button>
                )}
              </div>
              {/* 靶子变了要说清:意见可能已经过期,送过去轻则白烧一轮,
                  重则让它改回去。撤不撤是人的判断,这里只把事实摊开。 */}
              {item.status === "draft" && check?.state === "gone" && (
                <div className="annot-stale">
                  这处原文已经不在了{check.now ? `，现在是「${check.now}」` : ""}。
                  它可能已经自己改过了——确认还要送吗？
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
