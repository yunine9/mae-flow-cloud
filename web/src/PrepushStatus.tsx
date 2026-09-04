import { useState } from "react";
import {
  retryBuildFix,
  skipBuildFix,
  stopBuildFix,
  type PrepushRuntime,
  type PrepushVerification,
  type TaskSummary,
} from "./api";
import { OverlayDialog } from "./WarmupPanel";
import { PrepushLiveLog, prepushActive } from "./PrepushLiveLog";
import { formatLocalDateTime } from "./time";

type PrepushTone = "active" | "repair" | "danger" | "success" | "neutral";

interface PrepushView {
  phase: "preparing" | "compiling" | "testing" | "repairing" | "environment" | "passed" | "unknown";
  label: string;
  detail: string;
  tone: PrepushTone;
  busy?: boolean;
  generic?: boolean;
}

export function prepushViewOf(state: string): PrepushView {
  switch (state) {
    case "queued":
      return {
        phase: "preparing",
        // "排队"必须说破(实锤:用户对着"准备"以为卡死了)——同一
        // 时刻只放行有限个重型构建,等的是编译槽位,不是出了故障。
        label: "排队中",
        detail: "已进入验证队列，等待编译槽位释放(同一时刻仅运行有限个重型构建，前面的构建结束后自动开始)。",
        tone: "neutral",
        busy: true,
      };
    case "preparing":
      return {
        phase: "preparing",
        label: "准备",
        detail: "正在为最终工作区准备编译与受影响范围的定向单元测试。",
        tone: "active",
        busy: true,
      };
    case "compiling":
      return {
        phase: "compiling",
        label: "编译",
        detail: "Cloud 正在编译即将推送的版本。",
        tone: "active",
        busy: true,
      };
    case "testing":
    case "unit_testing":
    case "ut":
      return {
        phase: "testing",
        label: "单元测试",
        detail: "编译已通过，正在运行受影响范围的定向单元测试。",
        tone: "active",
        busy: true,
      };
    case "repairing":
      return {
        phase: "repairing",
        label: "自动修复",
        detail: "专项 Agent 正在修复验证失败，修复后会重新编译并运行定向单元测试。",
        tone: "repair",
        busy: true,
      };
    case "blocked":
      return {
        phase: "environment",
        label: "编译未通过",
        detail: "编译或单元测试尚未修复完成，本次推送已停止。",
        tone: "danger",
      };
    case "environment_error":
      return {
        phase: "environment",
        label: "环境异常",
        detail: "验证环境不可用，Cloud 已停止本次推送。",
        tone: "danger",
      };
    case "passed":
      return {
        phase: "passed",
        label: "通过",
        detail: "编译与定向单元测试已通过，Cloud 可以推送这个 SHA；全量回归由远端流水线负责。",
        tone: "success",
      };
    case "user_skipped":
      return {
        phase: "environment",
        label: "已跳过·流水线裁决",
        detail: "用户选择不再本地编译；编译与单元测试由权威流水线裁决。",
        tone: "neutral",
      };
    default:
      return {
        phase: "unknown",
        label: "Build-Fix",
        detail: "Cloud 正在检查并修复这次待推送版本。",
        tone: "neutral",
        busy: true,
        generic: true,
      };
  }
}

function withRuntime(view: PrepushView, runtime?: PrepushRuntime): PrepushView {
  if (!runtime) return view;
  if (runtime.state === "recovering") {
    return {
      ...view,
      phase: "preparing",
      label: "恢复中",
      detail: runtime.message,
      tone: "active",
      busy: true,
    };
  }
  if (runtime.state === "stopped" && view.phase === "environment") return view;
  if (runtime.state === "interrupted" || runtime.state === "stopped") {
    return {
      ...view,
      phase: "environment",
      label: runtime.state === "interrupted" ? "已中断" : "已停止",
      detail: runtime.message,
      tone: "danger",
      busy: false,
    };
  }
  return view;
}

function runtimeOwnsCopy(state: string, runtime?: PrepushRuntime): boolean {
  return Boolean(runtime && (
    runtime.state === "recovering"
    || runtime.state === "interrupted"
    || (runtime.state === "stopped"
      && ["queued", "preparing", "compiling", "testing", "unit_testing", "ut",
        "repairing"].includes(state))
  ));
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** 工作台头部的小胶囊(与预热同款):头部只放一行式信号,状态卡与
 * 实时日志进浮层/执行现场——头部堆叠是各功能局部最优抢地盘的结果,
 * 2026-08-27 用户拍板立规矩收敛。样式复用 warmup-badge/overlay。 */
export function PrepushBadge({
  task,
  canOperate = false,
  onChanged,
}: {
  task: TaskSummary;
  canOperate?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<"stop" | "skip" | "">("");
  const [busy, setBusy] = useState<"stop" | "skip" | "retry" | "">("");
  const [actionError, setActionError] = useState("");
  const prepush = task.delivery?.prepush;
  if (!prepush) return null;
  const runtime = task.delivery?.prepush_runtime;
  const skippable = canOperate
    && ["blocked", "environment_error"].includes(prepush.state);
  const view = withRuntime(prepushViewOf(prepush.state), runtime);
  const badgeDetail = runtimeOwnsCopy(prepush.state, runtime)
    ? (runtime?.message ?? view.detail) : (prepush.message?.trim() || view.detail);
  const perform = (kind: "stop" | "skip" | "retry",
    call: (id: string) => Promise<unknown>) => {
    setBusy(kind);
    setActionError("");
    void call(task.id)
      .then(() => { setOpen(false); onChanged?.(); })
      .catch((reason) => setActionError(reason instanceof Error
        ? reason.message : String(reason)))
      .finally(() => { setBusy(""); setConfirming(""); });
  };
  const cls = view.tone === "success" ? "is-passed"
    : view.tone === "danger" ? "is-failed"
      : view.tone === "repair" ? "is-repair" : "is-running";
  const label = view.phase === "passed" ? "Build-Fix · 通过"
    : view.generic ? "Build-Fix"
      : view.phase === "compiling" ? "编译中"
        : prepush.state === "user_skipped" ? view.label : `Build-Fix · ${view.label}`;
  return (
    <>
      <button type="button" className={`warmup-badge ${cls}`}
        onClick={() => setOpen(true)}
        title={`Build-Fix：${badgeDetail}`}>
        <i aria-hidden />{label}
      </button>
      {open && (
        <OverlayDialog ariaLabel="Build-Fix 详情" title="Build-Fix"
          onClose={() => setOpen(false)}>
          <PrepushStatus prepush={prepush} runtime={runtime}
            placement="workspace" />
            <PrepushLiveLog taskId={task.id}
              active={prepushActive(prepush.state, runtime)} />
            {canOperate && prepush.state !== "passed" && (
              /* 统一操作栏(2026-08-28 用户点名重designed:三个叠放的
                 虚线盒子太丑)。语义分色的胶囊按钮 + 一条内联确认条:
                 停止/跳过要确认(拍板即产生外部动作),重跑直点(兼
                 活性探针,真在跑时服务端拒绝并明说"正在进行")。 */
              <div className="prepush-actions">
                <span className="prepush-actions-label">人工操作</span>
                {actionError && (
                  <p className="prepush-actions-error">{actionError}</p>
                )}
                {confirming === "stop" ? (
                  <div className="prepush-actions-confirm">
                    <span>中止本轮编译,直接推送当前 HEAD 交流水线裁决;
                      若编译不过会消耗一条流水线进入修复环。已推进的
                      修复提交保留。</span>
                    <button type="button" className="prepush-action-btn is-danger"
                      disabled={busy === "stop"}
                      onClick={() => perform("stop", stopBuildFix)}>
                      {busy === "stop" ? "停止中…" : "确认停止并直推"}
                    </button>
                    <button type="button" className="prepush-action-btn"
                      disabled={busy === "stop"}
                      onClick={() => setConfirming("")}>取消</button>
                  </div>
                ) : confirming === "skip" ? (
                  <div className="prepush-actions-confirm">
                    <span>跳过本地编译直接推送,编译与单元测试交由权威流水线
                      裁决。跳过只绑当前 HEAD,新提交后自动失效。</span>
                    <button type="button" className="prepush-action-btn is-warn"
                      disabled={busy === "skip"}
                      onClick={() => perform("skip", skipBuildFix)}>
                      {busy === "skip" ? "提交中…" : "确认跳过"}
                    </button>
                    <button type="button" className="prepush-action-btn"
                      disabled={busy === "skip"}
                      onClick={() => setConfirming("")}>取消</button>
                  </div>
                ) : (
                  <div className="prepush-actions-row">
                    {prepushActive(prepush.state, runtime) && (
                      <button type="button"
                        className="prepush-action-btn is-danger"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming("stop")}
                        title="中止本轮编译并直推流水线裁决">
                        ⏹ 停止并直推流水线
                      </button>
                    )}
                    {skippable && (
                      <button type="button" className="prepush-action-btn is-warn"
                        disabled={Boolean(busy)}
                        onClick={() => setConfirming("skip")}
                        title="跳过本地编译,由权威流水线裁决(绑当前 HEAD)">
                        ⤼ 跳过,直推流水线
                      </button>
                    )}
                    <button type="button" className="prepush-action-btn"
                      disabled={Boolean(busy)}
                      onClick={() => perform("retry", retryBuildFix)}
                      title="失败停机或重启后卡住时用;正在编译时服务端会拒绝并说明,这句拒绝即是活性答案">
                      {busy === "retry" ? "提交中…" : "↻ 重跑编译"}
                    </button>
                  </div>
                )}
              </div>
            )}
        </OverlayDialog>
      )}
    </>
  );
}

/** Build-Fix 只补充平台状态，不覆盖内核的任务状态。 */
export function PrepushStatus({
  prepush,
  runtime,
  placement = "card",
}: {
  prepush?: PrepushVerification;
  runtime?: PrepushRuntime;
  placement?: "card" | "workspace";
}) {
  if (!prepush) return null;
  const view = withRuntime(prepushViewOf(prepush.state), runtime);
  const title = view.generic ? view.label : `Build-Fix · ${view.label}`;
  const detail = runtimeOwnsCopy(prepush.state, runtime)
    ? (runtime?.message ?? view.detail) : (prepush.message?.trim() || view.detail);
  const titleHint = prepush.updated_at
    ? `${title}（更新于 ${formatLocalDateTime(prepush.updated_at, { seconds: true })}）`
    : title;

  return (
    <span
      className={`prepush-status prepush-${placement} tone-${view.tone} phase-${view.phase}`}
      role="status"
      title={titleHint}
    >
      <span className={`prepush-marker${view.busy ? " busy" : ""}`} aria-hidden>
        <i />
      </span>
      <span className="prepush-copy">
        <strong>{title}</strong>
        {placement === "workspace" && <small>{detail}</small>}
      </span>
      <span className="prepush-facts">
        {prepush.round !== undefined && (
          <span>第 {prepush.round} 轮</span>
        )}
        {prepush.sha && <code title="本次验证绑定的代码版本号(Git 提交)">
          SHA {shortSha(prepush.sha)}</code>}
      </span>
    </span>
  );
}
