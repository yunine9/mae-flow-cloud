/**
 * 贴底跟随 hook:流式面板「人一往上翻就撒手」。
 *
 * 任务侧 EventTail 与问题侧现场页签共用同一实现(spec #2 用户故事 18:
 * 语义修复两域同享)——从 TaskCard.tsx 原文搬出成模块,行为零变化。
 * 「在不在底部」与「积压几条」的判据是纯函数,见 follow.ts
 * (atBottom/backlog,有用例);本文件只是把判据接上 ref/滚动事件
 * 与积压计数,不新增任何判断。
 */
import { useEffect, useRef, useState } from "react";
import { atBottom, backlog } from "./follow";

export function useStickyBottom<T extends HTMLElement>(count: number) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const mark = useRef(count);
  const [behind, setBehind] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (pinned.current) {
      node.scrollTo({ top: node.scrollHeight });
      mark.current = count;
      setBehind(0);
    } else {
      setBehind(backlog(count, mark.current));
    }
  }, [count]);

  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    const bottom = atBottom(node);
    if (bottom === pinned.current) return;
    pinned.current = bottom;
    if (bottom) { mark.current = count; setBehind(0); }
  };

  const toBottom = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = true;
    mark.current = count;
    setBehind(0);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  return { ref, behind, paused: !pinned.current, onScroll, toBottom };
}
