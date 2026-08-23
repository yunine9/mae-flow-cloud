import type { TaskTokenUsage } from "./api";
import { formatLocalDateTime } from "./time";

function tokenText(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) {
    const compact = value / 1_000;
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}k`;
  }
  const compact = value / 1_000_000;
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}m`;
}

function rateText(value: number): string {
  return value > 0 ? `${tokenText(value)}/分钟` : "当前空闲";
}

/** ↑/↓ 沿用 Pi 的输入/输出语义，不表示网络流量。 */
export function TokenUsage({
  usage,
  placement = "compact",
}: {
  usage?: TaskTokenUsage;
  placement?: "compact" | "workspace" | "history";
}) {
  if (!usage) return null;
  const title = `模型真实用量 · 更新于 ${formatLocalDateTime(
    usage.updated_at, { seconds: true })}`;

  if (placement !== "workspace") {
    return (
      <span className={`token-usage token-${placement}`} title={title}>
        <span className="token-usage-label">Token</span>
        <span><b aria-hidden>↑</b>{tokenText(usage.input_tokens)}</span>
        <span><b aria-hidden>↓</b>{tokenText(usage.output_tokens)}</span>
      </span>
    );
  }

  return (
    <section className="token-usage-workspace" aria-label="任务模型用量" title={title}>
      <span className="token-usage-heading">
        <i aria-hidden>↕</i>
        <span><strong>模型用量</strong><small>提供方实时回报</small></span>
      </span>
      <span className="token-usage-total">
        <small>累计</small><strong>{tokenText(usage.total_tokens)}</strong>
      </span>
      <span className="token-usage-direction input">
        <b aria-hidden>↑</b>
        <span><small>输入</small><strong>{tokenText(usage.input_tokens)}</strong></span>
        <em>{rateText(usage.input_tokens_per_minute)}</em>
      </span>
      <span className="token-usage-direction output">
        <b aria-hidden>↓</b>
        <span><small>输出</small><strong>{tokenText(usage.output_tokens)}</strong></span>
        <em>{rateText(usage.output_tokens_per_minute)}</em>
      </span>
    </section>
  );
}
