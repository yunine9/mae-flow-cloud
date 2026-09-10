import type { PipelineRun, PipelineStatus } from "./pipelineClient.ts";
import type { TaskSummary } from "./taskService.ts";

/** A request for a new SHA must not adopt an old run returned by the adapter. */
export function confirmedPipelineRun(sha: string, result: PipelineRun | PipelineStatus): PipelineRun {
  const runs = "runs" in result ? result.runs : [result];
  const matching = runs.filter(run => run.is_valid !== false && (!run.sha || run.sha === sha));
  const run = matching.filter(run => run.sha === sha).at(-1) ?? matching.at(-1);
  if (!run) throw new Error(`尚未查到提交 ${sha} 的有效流水线记录，旧 SHA 结果不能用于本次验证`);
  return { ...run, sha };
}

/** Scheduling projection only: keep the old failure/receipt intact for audit. */
export function historicalPipelineFeedback(summary: TaskSummary, item: {
  source?: unknown; observed_sha?: unknown; source_id?: unknown;
}): boolean {
  const delivery = summary.delivery;
  const sha = delivery?.sha;
  const sourceSha = String(item.observed_sha || String(item.source_id ?? "").split(":")[0]);
  return item.source === "pipeline" && !!sha && !!sourceSha && sourceSha !== sha
    && delivery?.git_push?.sha === sha
    && /^(running|success|failed)(?:$|\()/.test(delivery.pipeline ?? "");
}
