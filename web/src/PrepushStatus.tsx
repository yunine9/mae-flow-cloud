import { useState } from "react";
import {
  retryPrepushVerification,
  skipPrepushVerification,
  stopPrepushVerification,
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

function viewOf(state: string): PrepushView {
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
        detail: "正在为最终工作区准备编译与单元测试。",
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
        label: "UT",
        detail: "编译已通过，正在运行单元测试。",
        tone: "active",
        busy: true,
      };
    case "repairing":
      return {
        phase: "repairing",
        label: "自动修复",
        detail: "专项 Agent 正在修复验证失败，修复后会重新编译并运行 UT。",
        tone: "repair",
        busy: true,
      };
    case "blocked":
      return {
        phase: "environment",
        label: "编译未通过",
        detail: "编译或 UT 尚未修复完成，本次推送已停止。",
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
        detail: "编译与 UT 已通过，Cloud 可以推送这个 SHA。",
        tone: "success",
      };
    case "user_skipped":
      return {
        phase: "environment",
        label: "已跳过·流水线裁决",
        detail: "用户选择跳过本地验证；编译与 UT 由权威流水线裁决。",
        tone: "neutral",
      };
    default:
      return {
        phase: "unknown",
        label: "推送前编译",
        detail: "Cloud 正在处理这次推送前编译。",
        tone: "neutral",
        busy: true,
        generic: true,
      };
  }
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
  const [skipArmed, setSkipArmed] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [skipError, setSkipError] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNote, setRetryNote] = useState("");
  const [stopArmed, setStopArmed] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopNote, setStopNote] = useState("");
  const prepush = task.delivery?.prepush;
  if (!prepush) return null;
  const skippable = canOperate
    && ["blocked", "environment_error"].includes(prepush.state);
  const view = viewOf(prepush.state);
  const cls = view.tone === "success" ? "is-passed"
    : view.tone === "danger" ? "is-failed"
      : view.tone === "repair" ? "is-repair" : "is-running";
  const label = view.phase === "passed" ? "编译通过"
    : view.generic ? "推送前编译"
      : view.phase === "compiling" ? "编译中"
        : prepush.state === "user_skipped" ? view.label : `编译·${view.label}`;
  return (
    <>
      <button type="button" className={`warmup-badge ${cls}`}
        onClick={() => setOpen(true)}
        title={`推送前编译:${prepush.message?.trim() || view.detail}`}>
        <i aria-hidden />{label}
      </button>
      {open && (
        <OverlayDialog ariaLabel="推送前编译详情" title="推送前编译"
          onClose={() => setOpen(false)}>
          <PrepushStatus prepush={prepush} placement="workspace" />
            <PrepushLiveLog taskId={task.id}
              active={prepushActive(prepush.state)} />
            {canOperate && prepushActive(prepush.state) && (
              /* 主动停止(用户点名):停止≠放行,本轮如实收口成失败
                 停机,之后跳过/重跑两条出路才亮起来。 */
              <div className="prepush-rerun">
                {stopNote && <p className="prepush-skip-error">{stopNote}</p>}
                {!stopArmed ? (
                  <button type="button" disabled={stopBusy}
                    onClick={() => setStopArmed(true)}>
                    停止本轮编译
                  </button>
                ) : (
                  <>
                    <em>确定?本轮会收口成失败停机,之后可重跑或跳过直推流水线。</em>
                    <button type="button" disabled={stopBusy}
                      onClick={() => {
                        setStopBusy(true);
                        setStopNote("");
                        void stopPrepushVerification(task.id)
                          .then(() => { setOpen(false); onChanged?.(); })
                          .catch((reason) => setStopNote(reason instanceof Error
                            ? reason.message : String(reason)))
                          .finally(() => {
                            setStopBusy(false);
                            setStopArmed(false);
                          });
                      }}>
                      {stopBusy ? "停止中…" : "确认停止"}
                    </button>
                    <button type="button" disabled={stopBusy}
                      onClick={() => setStopArmed(false)}>返回</button>
                  </>
                )}
                <small>中止编译 Agent 与构建容器;已推进的修复提交保留在工作区。</small>
              </div>
            )}
            {canOperate && prepush.state !== "passed" && (
              /* 人工重跑兼活性探针(实锤:部署重启杀掉在途轮后,现场
                 停在"准备"没人能回答活着没有)。真在跑时服务端会拒绝
                 并明说"正在进行"——那句拒绝本身就是答案。 */
              <div className="prepush-rerun">
                {retryNote && <p className="prepush-skip-error">{retryNote}</p>}
                <button type="button" disabled={retryBusy}
                  onClick={() => {
                    setRetryBusy(true);
                    setRetryNote("");
                    void retryPrepushVerification(task.id)
                      .then(() => { setOpen(false); onChanged?.(); })
                      .catch((reason) => setRetryNote(reason instanceof Error
                        ? reason.message : String(reason)))
                      .finally(() => setRetryBusy(false));
                  }}>
                  {retryBusy ? "提交中…" : "重跑推送前编译"}
                </button>
                <small>失败停机或重启后卡住时用;正在编译时服务端会拒绝并说明。</small>
              </div>
            )}
            {skippable && (
              /* 失败停机后的人工出路:本地验证只是省流水线的前闸,
                 权威裁决在绑 SHA 流水线。跳过绑当下 HEAD,新提交即失效。 */
              <div className="prepush-skip">
                <p>
                  本地编译已失败停机。你可以跳过本地编译直接推送——
                  编译与 UT 交由权威流水线裁决;若代码真编译不过,
                  会消耗一条流水线后进入流水线修复环。
                </p>
                {skipError && <p className="prepush-skip-error">{skipError}</p>}
                {!skipArmed ? (
                  <button type="button" onClick={() => setSkipArmed(true)}>
                    跳过本地编译,直接推送流水线
                  </button>
                ) : (
                  <span className="prepush-skip-confirm">
                    <em>确定?跳过只对当前 HEAD 有效。</em>
                    <button type="button" disabled={skipBusy}
                      onClick={() => {
                        setSkipBusy(true);
                        setSkipError("");
                        void skipPrepushVerification(task.id)
                          .then(() => { setOpen(false); onChanged?.(); })
                          .catch((reason) => setSkipError(reason instanceof Error
                            ? reason.message : String(reason)))
                          .finally(() => {
                            setSkipBusy(false);
                            setSkipArmed(false);
                          });
                      }}>
                      {skipBusy ? "提交中…" : "确认跳过"}
                    </button>
                    <button type="button" disabled={skipBusy}
                      onClick={() => setSkipArmed(false)}>返回</button>
                  </span>
                )}
              </div>
            )}
        </OverlayDialog>
      )}
    </>
  );
}

/** 推送前快速验证只补充平台状态，不覆盖内核的任务状态。 */
export function PrepushStatus({
  prepush,
  placement = "card",
}: {
  prepush?: PrepushVerification;
  placement?: "card" | "workspace";
}) {
  if (!prepush) return null;
  const view = viewOf(prepush.state);
  const title = view.generic ? view.label : `推送前编译 · ${view.label}`;
  const detail = prepush.message?.trim() || view.detail;
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
        {prepush.sha && <code>SHA {shortSha(prepush.sha)}</code>}
      </span>
    </span>
  );
}
