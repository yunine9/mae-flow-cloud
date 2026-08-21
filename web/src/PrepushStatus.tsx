import type { PrepushVerification } from "./api";
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
        label: "准备",
        detail: "已进入验证队列，Cloud 将在推送前启动专项验证 Agent。",
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
        label: "验证未通过",
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
    default:
      return {
        phase: "unknown",
        label: "推送前验证",
        detail: "Cloud 正在处理这次推送前验证。",
        tone: "neutral",
        busy: true,
        generic: true,
      };
  }
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
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
  const title = view.generic ? view.label : `推送前验证 · ${view.label}`;
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
