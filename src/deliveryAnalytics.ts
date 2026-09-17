import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskSummary } from "./taskService.ts";
import { feedbackStamp, historicalRepairIntervals, intervalOrigins, validInterval, type RepairInterval } from "./deliveryAttribution.ts";
import { frozenTaskBaseline } from "./artifacts.ts";
import { analyticsGit, calculateDeliveryCode } from "./deliveryAnalyticsGit.ts";
import { emptyOrigins, type CodeOrigin, type DeliveryAnalysisReport, type DeliveryCodeMetric } from "./deliveryAnalyticsTypes.ts";

interface StoredAnalysis { version: 1; head: string; metric?: DeliveryCodeMetric; error?: string; attribution?: string; intervals?: RepairInterval[] }
type Task = Pick<TaskSummary, "id" | "workspace">;
type CollectionTask = Pick<TaskSummary, "id" | "workspace" | "delivery" | "origin">;
function location(task: Task): string {
  const key = createHash("sha256").update(`${task.workspace}\0${task.id}`).digest("hex");
  return join(dirname(task.workspace), ".delivery-analysis", `${key}.json`);
}
function read(task: Task): StoredAnalysis | undefined {
  try {
    const path = location(task);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return;
    const saved = JSON.parse(readFileSync(path, "utf8"));
    return saved.version === 1 ? saved : undefined;
  } catch { return; }
}
function save(task: Task, record: StoredAnalysis): void {
  const path = location(task);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("统计目录不能是符号链接");
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** Only a bounded, explicitly identified repair interval receives a reason.
 * Concurrent CI + human feedback remains mixed; commit messages are never used. */
export function repairOrigin(loop: NonNullable<TaskSummary["delivery"]>["loop"]): CodeOrigin {
  if (loop?.kind === "ci" && !loop.workspace_review_pending && !loop.workspace_review_recheck_required) return "pipeline";
  if (loop?.kind === "review") return "review";
  return "other";
}

// Cache the evidence used, not just the code version. Old snapshots are upgraded
// once and late repair evidence can update an already sampled push.
function attributionKey(summary: CollectionTask, cwd: string): string {
  const loop = summary.delivery?.loop;
  return JSON.stringify([3, loop?.last_sha, repairOrigin(loop), summary.delivery?.foreign_commits?.base_sha, feedbackStamp(cwd)]);
}

function currentInterval(summary: CollectionTask, head: string): RepairInterval {
  return { base: summary.delivery?.loop?.last_sha ?? "", head, origin: repairOrigin(summary.delivery?.loop) as RepairInterval["origin"],
    foreign: summary.delivery?.foreign_commits?.base_sha, evidence: `${repairOrigin(summary.delivery?.loop) === "pipeline" ? "流水线" : repairOrigin(summary.delivery?.loop) === "review" ? "检视" : "混合或其他"}修复轮次 ${summary.delivery?.loop?.round ?? ""}` };
}

/** Persist the small attribution fact before starting best-effort Git work.
 * A process restart or failed sampler must not erase previous repair rounds. */
export function recordDeliveryPublication(summary: TaskSummary, cwd: string | undefined, head: string): void {
  if (summary.origin === "issue") return;
  try {
    const saved = read(summary);
    const interval = currentInterval(summary, head);
    if (validInterval(interval)) {
      const intervals = [...(saved?.intervals ?? [])];
      if (!intervals.some(i => JSON.stringify(i) === JSON.stringify(interval))) intervals.push(interval);
      save(summary, { version: 1, head: saved?.head ?? head, ...saved, intervals });
    }
  } catch { /* Analytics must never block a real push. */ }
  observeDeliveryCode(summary, cwd, head, true);
}

const pending = new Map<string, Promise<void>>();
let lane: Promise<void> = Promise.resolve();
/** Best-effort observer, single Git worker across tasks. Never awaited by the
 * delivery state machine; failed analytics never retries or blocks a task. */
export function observeDeliveryCode(summary: TaskSummary, cwd: string | undefined, head: string, retry = false): void {
  if (!cwd || !/^[a-f0-9]{40,64}$/.test(head) || summary.origin === "issue") return;
  const snapshot: CollectionTask = { id: summary.id, workspace: summary.workspace,
    origin: summary.origin, delivery: structuredClone(summary.delivery) };
  const attribution = attributionKey(snapshot, cwd);
  const key = `${location(summary)}:${head}:${attribution}`;
  const saved = read(summary);
  if (pending.has(key) || saved?.head === head && saved.attribution === attribution && !retry) return;
  const job = lane.then(async () => {
    try { await collectDeliveryCode(snapshot, cwd, head); }
    catch (error) {
      try { save(snapshot, { ...read(snapshot), version: 1, head, attribution, error: error instanceof Error ? error.message : "统计暂不可用" }); } catch { /* read-side only */ }
    }
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  lane = job;
}
export async function awaitDeliveryAnalytics(): Promise<void> { await lane; }

export async function collectDeliveryCode(summary: CollectionTask, cwd: string, head: string): Promise<DeliveryCodeMetric> {
  const attribution = attributionKey(summary, cwd);
  const previous = read(summary)?.metric;
  if (!previous && summary.delivery?.foreign_commits) throw new Error("首次取样前已混入外来提交，无法确认本任务首次提交");
  const taskBase = await frozenTaskBaseline(cwd);
  if (!taskBase) throw new Error("缺少任务创建时的 Git 基线，无法识别首次提交");
  const target = summary.delivery?.target_branch;
  if (!target) throw new Error("缺少 MR 目标分支，无法确定交付范围");
  await analyticsGit(cwd, ["check-ref-format", `refs/remotes/origin/${target}`]);
  // A same-source refresh must retain the pre-merge comparison base, including
  // after fast-forward/squash merge or a target branch update.
  const base = previous?.head === head ? previous.base
    : (await analyticsGit(cwd, ["merge-base", "--all", head, `refs/remotes/origin/${target}`])).trim();
  if (base === head) throw new Error("目标分支已包含交付版本，缺少合入前统计快照；不倒推历史占比");
  const origins: Record<string, CodeOrigin> = Object.fromEntries((previous?.commits ?? []).map(c => [c.sha, c.origin]));
  const evidence: Record<string, string[]> = Object.fromEntries((previous?.commits ?? []).filter(c => c.origin_evidence).map(c => [c.sha, c.origin_evidence!]));
  const fallback = await intervalOrigins(cwd, head, [currentInterval(summary, head)]);
  for (const [sha, origin] of Object.entries(fallback.origins)) {
    if (!origins[sha] || origins[sha] === "other") { origins[sha] = origin; evidence[sha] = fallback.evidence[sha]; }
  }
  const published = await intervalOrigins(cwd, head, read(summary)?.intervals ?? []);
  Object.assign(origins, published.origins);
  const historical = await intervalOrigins(cwd, head, historicalRepairIntervals(cwd, summary.id));
  // Completed feedback facts are more specific than the mutable current loop.
  // Overlapping CI/review batches remain mixed, independent of read order.
  Object.assign(origins, historical.origins);
  Object.assign(evidence, published.evidence, historical.evidence);
  const metric = await calculateDeliveryCode({ cwd, base, head, task_base: taskBase, first: previous?.first, origins });
  // Preserve cumulative events even if the target has absorbed an earlier part.
  if (previous) {
    const commits = new Map(previous.commits.map(c => [c.sha, c]));
    for (const commit of metric.commits) commits.set(commit.sha, commit);
    metric.commits = [...commits.values()];
    for (const commit of metric.commits) if (commit.sha !== metric.first && origins[commit.sha]) commit.origin = origins[commit.sha];
    metric.rework = emptyOrigins();
    for (const commit of metric.commits) if (commit.sha !== metric.first) metric.rework[commit.origin] += commit.additions + commit.deletions;
  }
  for (const commit of metric.commits) {
    commit.origin_evidence = commit.sha === metric.first ? ["任务基线后的首个非合并提交"]
      : evidence[commit.sha] ?? commit.origin_evidence ?? [commit.origin === "other"
        ? "缺少覆盖该提交的修复区间证据" : "此前推送快照保留的分类"];
  }
  save(summary, { version: 1, head, metric, intervals: read(summary)?.intervals,
    attribution });
  return metric;
}

/** No Git work in an HTTP request; unavailable history stays visibly unavailable. */
export function buildDeliveryAnalysis(tasks: TaskSummary[]): DeliveryAnalysisReport {
  const parentIds = new Set(tasks.map(t => t.parent_task_id).filter(Boolean));
  const names = new Map(tasks.map(t => [t.id, t.title || t.requirement.split("\n")[0]]));
  return { generated_at: new Date().toISOString(), rows: tasks
    .filter(task => task.origin !== "issue" && !parentIds.has(task.id))
    .map(task => {
      const stored = read(task), head = task.delivery?.git_push?.sha;
      const merged = task.status === "completed" && ["merged", "已合入"].includes(task.delivery?.mr_state ?? "");
      // merged_sha identifies the target commit (different after squash/rebase).
      // Statistics describe the confirmed pushed source, which must still match.
      const metric = head && stored?.metric?.head === head ? stored.metric : undefined;
      return { id: task.id, title: task.title || task.requirement.split("\n")[0], parent_id: task.parent_task_id,
        parent_title: task.parent_task_id ? names.get(task.parent_task_id) : undefined,
        repo: cleanRepository(task.repo_url ?? ""), modules: (task.business_modules ?? []).map(m => m.name),
        merged,
        at: task.completed_at ?? task.updated_at ?? task.created_at, mr_url: safeMrUrl(task.delivery?.mr_url), metric,
        unavailable: metric ? undefined : stored?.head === head && stored?.error ? stored.error
          : head ? "尚无本次推送的统计快照；历史任务不会猜测归因" : "尚未推送代码" };
    }) };
}
function cleanRepository(value: string): string {
  return value.replace(/(https?:\/\/)[^/@]+@/g, "$1");
}
function safeMrUrl(value?: string): string | undefined {
  try { const url = new URL(value ?? ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return; }
}
