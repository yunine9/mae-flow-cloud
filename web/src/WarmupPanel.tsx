/**
 * 环境预热编译面板(用户点名:预热进展必须清楚可见,"开始就爆红是
 * 好事")。跑的时候实时滚命令流;收口后折叠成一行结果。失败亮牌时
 * 必须说清责任:基线红=环境或上游的锅,与本单增量无关。
 */

import { useState } from "react";
import { PrepushLiveLog } from "./PrepushLiveLog";
import { tailWarmupEvents, type TaskSummary } from "./api";

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
        <div className="warmup-overlay" role="dialog" aria-modal="true"
          aria-label="环境预热编译详情"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}>
          <div className="warmup-dialog">
            <header>
              <strong>环境预热编译</strong>
              <button type="button" aria-label="关闭"
                onClick={() => setOpen(false)}>×</button>
            </header>
            <WarmupPanel task={task} />
          </div>
        </div>
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
