/**
 * 页内确认弹框：window.confirm 的全站替代(spec #52)。
 *
 * 调用侧只 import confirmDialog(promise 风格,返回是否确认)：
 *   if (!await confirmDialog({ title: "终止会话", danger: true })) return;
 * App 根部挂一次 ConfirmDialogHost 负责渲染;并发调用 FIFO 排队,
 * 同一时刻最多一张卡。视觉与键盘纪律(Esc=取消、Tab 困笼、危险档
 * 默认焦点在取消、关闭归还焦点)都在这一处,调用点不必关心。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface ConfirmDialogOptions {
  title: string;
  /** 正文:字符串按原样换行渲染,也可以直接给 JSX(如后果清单)。 */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险档:红色确认按钮,打开时焦点落在「取消」,防手滑连按回车。 */
  danger?: boolean;
}

interface PendingConfirm {
  options: ConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
}

let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { options, resolve }];
    notify();
  });
}

function settle(confirmed: boolean) {
  const [head, ...rest] = queue;
  if (!head) return;
  queue = rest;
  head.resolve(confirmed);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0] ?? null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!current) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    (current.options.danger ? cancelRef : confirmRef).current?.focus();
    return () => { triggerRef.current?.focus(); };
  }, [current]);

  if (!current) return null;
  const { options } = current;
  // Escape 在这里拦下就地取消,不再冒泡到 window——会话工作台等全屏
  // 视图把 Escape 绑在 window 上当"返回",不拦会连视图一起关掉。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      settle(false);
      return;
    }
    if (event.key === "Tab") {
      // 焦点困笼:框内只有取消/确认两个按钮,首尾循环即可。
      const focusables = [cancelRef.current, confirmRef.current]
        .filter((button): button is HTMLButtonElement => button !== null);
      if (focusables.length === 0) return;
      const [first, last] = [focusables[0], focusables[focusables.length - 1]];
      const active = document.activeElement;
      const inside = focusables.includes(active as HTMLButtonElement);
      if (event.shiftKey ? active === first || !inside
        : active === last || !inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };
  return <div className="confirm-backdrop" role="presentation"
    onKeyDown={onKeyDown}
    onClick={(event) => {
      if (event.target === event.currentTarget) settle(false);
    }}>
    <section className="confirm-dialog" role="dialog" aria-modal="true"
      aria-labelledby="confirm-dialog-title">
      <h3 id="confirm-dialog-title">{options.title}</h3>
      {options.message != null
        && <div className="confirm-message">{options.message}</div>}
      <footer>
        <button type="button" ref={cancelRef}
          onClick={() => settle(false)}>
          {options.cancelLabel ?? "取消"}
        </button>
        <button type="button" ref={confirmRef}
          className={options.danger ? "danger" : "primary"}
          onClick={() => settle(true)}>
          {options.confirmLabel ?? "确认"}
        </button>
      </footer>
    </section>
  </div>;
}
