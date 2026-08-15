/**
 * 决定卡上的"这次会带上哪几处"。
 *
 * 只报一个数字("已圈注 2 处")等于没说:人要在这里按下提交,他得知道
 * 自己到底提交了什么。所以直接把那几条列出来,而且每条都能点回原处
 * ——改批注前人几乎总要再看一眼上下文(内核面板那条经验)。
 */

import type { Annotation } from "./api";
import { shortPath } from "./paths";

/** 列太多会把决定卡挤没,超过这个数就折进下方清单。 */
const INLINE_MAX = 5;

export function AttachedNotes({
  items,
  attached,
  onToggle,
  onLocate,
}: {
  /** 勾上才随本次决定送出。默认勾上,但必须由人决定——"哪个选项算打回"
   * 是内核的判定(choice_key → 分支),TS 侧抄一份就越了红线;而不勾时
   * 批注不会丢,它跨检视点活着,下一个决策点还会浮出来。 */
  attached: boolean;
  onToggle: (next: boolean) => void;
  items: Annotation[];
  onLocate: (item: Annotation) => void;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, INLINE_MAX);
  const rest = items.length - shown.length;

  return (
    <div className="annot-attached">
      <label className="annot-attached-head">
        <input type="checkbox" checked={attached}
               onChange={(event) => onToggle(event.target.checked)} />
        <span>
          提交本次决定时附带 {items.length} 条批注
          {!attached && "（本次不提交，批注仍会保留）"}
        </span>
      </label>
      <ul className="annot-attached-list">
        {shown.map((item) => (
          <li key={item.id}>
            {/* 两行:坐标一行、意见一行。挤在一行里侧栏放不下,两截
                都被省略号切成看不懂的残句。 */}
            <button type="button" onClick={() => onLocate(item)}
                    title={`回到 ${item.file}:${item.line}`}>
              <code>{shortPath(item.file)}:{item.line}</code>
              <span>{item.note}</span>
            </button>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <div className="annot-attached-rest">另有 {rest} 条，可在下方批注列表中查看</div>
      )}
    </div>
  );
}
