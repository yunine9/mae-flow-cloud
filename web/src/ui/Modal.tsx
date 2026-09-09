/**
 * 通用弹层:页内表单/面板对话框的统一底座(组件统一化 2026-09-08)。
 *
 * 此前 ~11 处手搓 overlay 各养各的 backdrop 类与 z-index(实测 20 个
 * 值),Esc/backdrop/焦点行为也各写各的;纪律收拢到这一处:
 * - portal 到 body,层级取 tokens 的 --z-modal(压过存量全屏 720);
 * - Escape 就地关闭且 stopPropagation——全屏视图把 Escape 绑在 window
 *   上当"返回",不拦会连视图一起关(ConfirmDialog 同款教训);
 * - Tab 焦点困笼,打开时焦点进框,关闭归还触发元素;
 * - backdrop 点击(mousedown 落在背板上)关闭;
 * - 无队列:声明式 <Modal open>,并发叠加由 DOM 顺序决定先后。
 *
 * 确认语义不要用本组件——继续用 confirmDialog(它有 danger 档、默认
 * 焦点与队列,层级在 --z-topmost)。样式走全局 .ui-modal-*(ui.css);
 * 组件不 import CSS,保持 node 测试可直接 import。
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, ReactNode } from "react";

const FOCUSABLE = [
  "button", "[href]", "input", "select", "textarea",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 标题元素的 id(aria-labelledby 用);标题由调用方在 children 里渲染。 */
  labelledBy?: string;
  /** 没有可见标题时的无障碍名。 */
  ariaLabel?: string;
  /** 弹层宽度;缺省 min(460px, calc(100vw - 48px))。 */
  width?: number | string;
  children: ReactNode;
}

export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return createPortal(<ModalSurface {...props} />, document.body);
}

/** 与 portal 解耦的弹层本体:node 测试渲染这一层(无 DOM 依赖的部分)。 */
export function ModalSurface({ onClose, labelledBy, ariaLabel,
  width, children }: ModalProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => { triggerRef.current?.focus(); };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // 焦点困笼:框内可聚焦元素首尾循环(ConfirmDialog 同款做法)。
      const focusables = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
      ];
      if (focusables.length === 0) return;
      const [first, last] = [focusables[0], focusables[focusables.length - 1]];
      const active = document.activeElement;
      const inside = focusables.includes(active as HTMLElement);
      if (event.shiftKey ? active === first || !inside
        : active === last || !inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };

  return <div className="ui-modal-backdrop" role="presentation"
    onKeyDown={onKeyDown}
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
    <section ref={dialogRef} className="ui-modal-dialog" role="dialog"
      aria-modal="true" aria-labelledby={labelledBy} aria-label={ariaLabel}
      style={width !== undefined ? { width } : undefined}
      tabIndex={-1}>
      {children}
    </section>
  </div>;
}
