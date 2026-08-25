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
  /** 勾上才随本次决定送出。默认勾上；决定卡会读取内核分支契约，
   * 联动真正的返工选项。不勾时批注不会丢，它跨检视点继续保留。 */
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
          将 {items.length} 条未闭环检视意见随本次决定提交
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
