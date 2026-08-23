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
  return `${tokenText(value)} Token/分钟`;
}

function amountText(value: number): string {
  return `${tokenText(value)} Token`;
}

/** ↑/↓ 沿用 Pi 的输入/输出语义，不表示网络流量。 */
export function TokenUsage({
  usage,
  placement = "compact",
}: {
  usage?: TaskTokenUsage;
  placement?: "compact" | "workspace" | "history" | "detail";
}) {
  if (!usage) return null;
  const title = `模型真实用量 · 更新于 ${formatLocalDateTime(
    usage.updated_at, { seconds: true })}`;

  if (placement === "detail") {
    const totalRate = usage.input_tokens_per_minute
      + usage.output_tokens_per_minute;
    return (
      <section className="token-usage-detail" aria-label="任务模型 Token 用量" title={title}>
        <header>
          <div className="token-detail-title">
            <i aria-hidden>↕</i>
            <span>
              <small>MODEL USAGE</small>
              <strong>模型 Token 用量</strong>
            </span>
          </div>
          <div className={`token-detail-rate${totalRate > 0 ? " active" : ""}`}>
            <span><i aria-hidden />最近 {usage.rate_window_seconds} 秒速率</span>
            <strong>{rateText(totalRate)}</strong>
          </div>
        </header>
        <div className="token-detail-metrics">
          <article className="total">
            <small>累计总量</small>
            <strong>{amountText(usage.total_tokens)}</strong>
            <span>输入与输出合计</span>
          </article>
          <article className="input">
            <small><b aria-hidden>↑</b> 输入</small>
            <strong>{amountText(usage.input_tokens)}</strong>
            <span>{rateText(usage.input_tokens_per_minute)}</span>
          </article>
          <article className="output">
            <small><b aria-hidden>↓</b> 输出</small>
            <strong>{amountText(usage.output_tokens)}</strong>
            <span>{rateText(usage.output_tokens_per_minute)}</span>
          </article>
        </div>
        <footer>
          <span>单位：Token</span>
          <span>速率窗口：最近 {usage.rate_window_seconds} 秒</span>
          <time dateTime={usage.updated_at}>
            更新于 {formatLocalDateTime(usage.updated_at, { seconds: true })}
          </time>
        </footer>
      </section>
    );
  }

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
