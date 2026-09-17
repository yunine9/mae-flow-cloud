import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskSummary } from "./taskService.ts";
import { frozenTaskBaseline } from "./artifacts.ts";
import { analyticsGit, calculateDeliveryCode } from "./deliveryAnalyticsGit.ts";
import { emptyOrigins, type CodeOrigin, type DeliveryAnalysisReport, type DeliveryCodeMetric } from "./deliveryAnalyticsTypes.ts";

interface StoredAnalysis { version: 1; head: string; metric?: DeliveryCodeMetric; error?: string }
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

const pending = new Map<string, Promise<void>>();
let lane: Promise<void> = Promise.resolve();
/** Best-effort observer, single Git worker across tasks. Never awaited by the
 * delivery state machine; failed analytics never retries or blocks a task. */
export function observeDeliveryCode(summary: TaskSummary, cwd: string | undefined, head: string, retry = false): void {
  if (!cwd || !/^[a-f0-9]{40,64}$/.test(head) || summary.origin === "issue") return;
  const snapshot: CollectionTask = { id: summary.id, workspace: summary.workspace,
    origin: summary.origin, delivery: structuredClone(summary.delivery) };
  const key = `${location(summary)}:${head}`;
  const saved = read(summary);
  if (pending.has(key) || saved?.head === head && (saved.metric?.head === head || !retry)) return;
  const job = lane.then(async () => {
    try { await collectDeliveryCode(snapshot, cwd, head); }
    catch (error) {
      try { save(snapshot, { version: 1, head, metric: read(snapshot)?.metric, error: error instanceof Error ? error.message : "统计暂不可用" }); } catch { /* read-side only */ }
    }
  }).finally(() => pending.delete(key));
  pending.set(key, job);
  lane = job;
}
export async function awaitDeliveryAnalytics(): Promise<void> { await lane; }

export async function collectDeliveryCode(summary: CollectionTask, cwd: string, head: string): Promise<DeliveryCodeMetric> {
  const previous = read(summary)?.metric;
  if (previous?.head === head) return previous;
  if (!previous && summary.delivery?.foreign_commits) throw new Error("首次取样前已混入外来提交，无法确认本任务首次提交");
  const taskBase = await frozenTaskBaseline(cwd);
  if (!taskBase) throw new Error("缺少任务创建时的 Git 基线，无法识别首次提交");
  const target = summary.delivery?.target_branch;
  if (!target) throw new Error("缺少 MR 目标分支，无法确定交付范围");
  await analyticsGit(cwd, ["check-ref-format", `refs/remotes/origin/${target}`]);
  const base = (await analyticsGit(cwd, ["merge-base", "--all", head, `refs/remotes/origin/${target}`])).trim();
  if (base === head) throw new Error("目标分支已包含交付版本，缺少合入前统计快照；不倒推历史占比");
  const origins: Record<string, CodeOrigin> = Object.fromEntries((previous?.commits ?? []).map(c => [c.sha, c.origin]));
  const loop = summary.delivery?.loop;
  const category = repairOrigin(loop);
  // A prior observed push and the platform's repair anchor must agree. A missing
  // interval or rewritten history is not evidence for a repair attribution.
  if (previous && loop?.last_sha === previous.head && category !== "other") {
    await analyticsGit(cwd, ["merge-base", "--is-ancestor", previous.head, head]);
    const foreign = summary.delivery?.foreign_commits?.base_sha;
    const changed = (await analyticsGit(cwd, ["rev-list", "--first-parent", "--no-merges", `${previous.head}..${head}`, `^${base}`,
      ...(foreign && /^[a-f0-9]{40,64}$/.test(foreign) ? [`^${foreign}`] : [])])).trim().split("\n").filter(Boolean);
    for (const sha of changed) origins[sha] = category;
  }
  const metric = await calculateDeliveryCode({ cwd, base, head, task_base: taskBase, first: previous?.first, origins });
  // Preserve cumulative events even if the target has absorbed an earlier part.
  if (previous) {
    const commits = new Map(previous.commits.map(c => [c.sha, c]));
    for (const commit of metric.commits) commits.set(commit.sha, commit);
    metric.commits = [...commits.values()];
    metric.rework = emptyOrigins();
    for (const commit of metric.commits) if (commit.sha !== metric.first) metric.rework[commit.origin] += commit.additions + commit.deletions;
  }
  save(summary, { version: 1, head, metric });
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
      const finalMatches = !merged || task.delivery?.merged_sha === head;
      const metric = finalMatches && head && stored?.metric?.head === head ? stored.metric : undefined;
      return { id: task.id, title: task.title || task.requirement.split("\n")[0], parent_id: task.parent_task_id,
        parent_title: task.parent_task_id ? names.get(task.parent_task_id) : undefined,
        repo: cleanRepository(task.repo_url ?? ""), modules: (task.business_modules ?? []).map(m => m.name),
        merged,
        at: task.completed_at ?? task.updated_at ?? task.created_at, mr_url: safeMrUrl(task.delivery?.mr_url), metric,
        unavailable: metric ? undefined : !finalMatches ? "最终合入版本与统计快照不一致，未计入正式汇总" : stored?.head === head && stored?.error ? stored.error
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
