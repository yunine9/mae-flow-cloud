/**
 * 环境预热编译面板(用户点名:预热进展必须清楚可见,"开始就爆红是
 * 好事")。跑的时候实时滚命令流;收口后折叠成一行结果。失败亮牌时
 * 必须说清责任:基线红=环境或上游的锅,与本单增量无关。
 */

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PrepushLiveLog } from "./PrepushLiveLog";
import { tailWarmupEvents, type TaskSummary } from "./api";

/** 可拖拽、可缩放的浮层(用户点名"能支持拖拽放大不"):标题栏拖动
 * 移动,右下角原生 resize 拉大;portal 到 body 逃出祖先层叠上下文
 * (实锤:留在头部 DOM 里 z-index 再高也被 sticky 进度条盖)。 */
export function OverlayDialog({
  ariaLabel,
  title,
  onClose,
  children,
}: {
  ariaLabel: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{
    px: number; py: number; ox: number; oy: number;
  } | null>(null);
  return createPortal(
    <div className="warmup-overlay" role="dialog" aria-modal="true"
      aria-label={ariaLabel}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <div className="warmup-dialog"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        <header className="warmup-dialog-drag"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            dragFrom.current = {
              px: event.clientX, py: event.clientY,
              ox: offset.x, oy: offset.y,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = dragFrom.current;
            if (!from) return;
            setOffset({
              x: from.ox + event.clientX - from.px,
              y: from.oy + event.clientY - from.py,
            });
          }}
          onPointerUp={() => { dragFrom.current = null; }}>
          <strong>{title}</strong>
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 工作台头部的小标志:头部寸土寸金(用户拍板),平时只占一枚小胶囊,
 * 点开浮层看完整面板(实时命令流也在浮层里)。刻意不绑 Escape——
 * 工作台自己的 Escape 是关整个工作台,抢按键会一次关两层。 */
export function WarmupBadge({ task }: { task: TaskSummary }) {
  const [open, setOpen] = useState(false);
  const receipt = task.baseline_build;
  if (!receipt) return null;
  const short = receipt.status === "running" ? "预热中"
    : receipt.status === "passed" ? "预热通过"
      : receipt.status === "failed" ? "预热失败" : "预热未完";
  const full = receipt.status === "running"
    ? `正在编译基线 ${receipt.sha.slice(0, 12)},焐热构建缓存`
    : receipt.status === "passed"
      ? "基线编译通过,构建缓存已就绪"
      : receipt.status === "failed"
        ? "基线编译失败——环境或上游问题,与本单增量无关"
        : "预热未完成(基础设施问题),不代表基线编译失败";
  return (
    <>
      <button type="button" className={`warmup-badge is-${receipt.status}`}
        onClick={() => setOpen(true)} title={`环境预热:${full}`}>
        <i aria-hidden />{short}
      </button>
      {open && (
        <OverlayDialog ariaLabel="环境预热编译详情" title="环境预热编译"
          onClose={() => setOpen(false)}>
          <WarmupPanel task={task} />
        </OverlayDialog>
      )}
    </>
  );
}

export function WarmupPanel({ task }: { task: TaskSummary }) {
  const receipt = task.baseline_build;
  if (!receipt) return null;
  const running = receipt.status === "running";
  return (
    <section className={`warmup-panel is-${receipt.status}`}
      aria-label="环境预热编译">
      <header>
        <i aria-hidden />
        <strong>环境预热</strong>
        <span>
          {receipt.status === "running"
            ? `正在编译基线 ${receipt.sha.slice(0, 12)},为增量编译焐热缓存`
            : receipt.status === "passed"
              ? `基线编译通过(${receipt.sha.slice(0, 12)}),构建缓存已就绪`
              : receipt.status === "failed"
                ? "基线编译失败——环境或上游问题,与本单增量无关"
                : "预热未完成(基础设施问题),不代表基线编译失败"}
        </span>
      </header>
      {receipt.detail && receipt.status !== "passed" && !running && (
        <p className="warmup-detail">{receipt.detail}</p>
      )}
      {receipt.build_command && receipt.status === "passed" && (
        <p className="warmup-command">
          验证过的构建入口:<code>{receipt.build_command}</code>
        </p>
      )}
      {running && (
        <PrepushLiveLog taskId={task.id} active
          source={tailWarmupEvents}
          title="预热过程"
          emptyText="等待预热专员的第一条命令……" />
      )}
    </section>
  );
}
