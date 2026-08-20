/**
 * Cloud 与流水线适配层之间的逐项质量事实。
 *
 * 总体 status 只负责告诉宿主“一次 run 是否结束”；是否可以交付只由
 * 内核对这三类 check 的裁决决定。缺项、未知状态或畸形字段都按没有
 * 可核销证据处理，绝不拿总体绿灯补猜。
 */

export const PIPELINE_DIMENSIONS = ["COMPILE", "UT", "CODECHECK"] as const;

export type PipelineDimension = typeof PIPELINE_DIMENSIONS[number];

export type PipelineCheckStatus =
  | "success"
  | "failed"
  | "running"
  | "pending"
  | "canceled"
  | "skipped"
  | "not_run";

export interface PipelineCheck {
  dimension: PipelineDimension;
  status: PipelineCheckStatus;
  job?: string;
  url?: string;
}

const DIMENSIONS = new Set<string>(PIPELINE_DIMENSIONS);
const CHECK_STATUSES = new Set<string>([
  "success", "failed", "running", "pending", "canceled", "skipped",
  "not_run",
]);

/** 平台响应是运行时输入，过这一道才进入任务摘要和内核事实文件。 */
export function parsePipelineChecks(value: unknown): PipelineCheck[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checks: PipelineCheck[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as Record<string, unknown>;
    const dimension = String(row.dimension ?? "").toUpperCase();
    const status = String(row.status ?? "").toLowerCase();
    if (!DIMENSIONS.has(dimension) || !CHECK_STATUSES.has(status)) {
      return undefined;
    }
    checks.push({
      dimension: dimension as PipelineDimension,
      status: status as PipelineCheckStatus,
      ...(row.job !== undefined && row.job !== ""
        ? { job: String(row.job) } : {}),
      ...(row.url !== undefined && row.url !== ""
        ? { url: String(row.url) } : {}),
    });
  }
  return checks;
}
