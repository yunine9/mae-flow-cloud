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
  onLocate,
}: {
  items: Annotation[];
  onLocate: (item: Annotation) => void;
}) {
  if (!items.length) return null;
  const shown = items.slice(0, INLINE_MAX);
  const rest = items.length - shown.length;

  return (
    <div className="annot-attached">
      <div className="annot-attached-head">
        <span>
          服务端已发现 {items.length} 条未闭环检视意见；选择返工时会全部提交，选择放行时将被拦截
        </span>
      </div>
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
