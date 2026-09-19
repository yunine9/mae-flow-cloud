import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Notifier } from "./notifier.ts";
import type { TaskSummary } from "./taskService.ts";
import { listArtifactDocuments, readArtifact } from "./artifacts.ts";
import { runDeliverySummaryAgent, summaryGit, type DeliverySummaryInput, type DeliverySummarySessionOptions } from "./deliverySummaryAgent.ts";

export const DELIVERY_SUMMARY_FILE = "交付摘要.md";
export const DELIVERY_SUMMARY_ARTIFACT = `task-materials/${DELIVERY_SUMMARY_FILE}`;
type Owner = { cwd?: string; summary: TaskSummary };
type SummaryOptions = DeliverySummarySessionOptions & { notifier?: Pick<Notifier, "notifyOutcome">; taskLink?: string };
type Runner = (input: DeliverySummaryInput, signal: AbortSignal, options: DeliverySummarySessionOptions) => Promise<string>;

/** 首次交付的独立旁路。状态放在任务目录，既不占主 driver，也不改交付状态。 */
export class DeliverySummaries<T extends Owner> {
  private jobs = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private stopped = false;
  constructor(private options: (task: T) => SummaryOptions, private runner: Runner = runDeliverySummaryAgent) {}

  start(task: T): void {
    if (this.stopped || !task.cwd || !task.summary.delivery?.git_push?.sha || !task.summary.delivery.mr_url) return;
    const root = join(task.summary.workspace, "delivery-summary");
    const statePath = join(root, "state.json");
    try {
      // wx 是首次领取标记；重试交付、并发回调、重启均不重复烧模型或更新快照。
      mkdirSync(root, { recursive: true });
      const snapshot = structuredClone(task.summary);
      const capturedAt = new Date().toISOString();
      const head = snapshot.delivery!.git_push!.sha;
      writeFileSync(statePath, JSON.stringify({ status: "running", head, captured_at: capturedAt }), { flag: "wx", mode: 0o600 });
      const repo = task.cwd;
      const abort = new AbortController();
      const work = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        const options = this.options(task);
        const timer = setTimeout(() => abort.abort(new Error("交付摘要超过 10 分钟，已停止")), 10 * 60_000);
        timer.unref();
        const save = (status: string, error?: string) => {
          if (existsSync(root)) writeFileSync(statePath, JSON.stringify({ status, head, captured_at: capturedAt, finished_at: new Date().toISOString(), ...(error ? { error } : {}) }), { mode: 0o600 });
        };
        try {
          abort.signal.throwIfAborted();
          const branch = snapshot.delivery!.target_branch;
          if (!branch || !/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("首次交付缺少确定的分支或提交版本");
          // 只使用已同步的目标分支，绝不拿之后的工作区 HEAD 代替首次交付。
          const target = (await summaryGit(repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`])).trim();
          const base = (await summaryGit(repo, ["merge-base", target, head])).trim();
          const designs = listArtifactDocuments(repo, { taskMaterialRoot: snapshot.workspace })
            .filter(doc => /(?:story|spec)\.md$/i.test(doc.name)).slice(0, 3)
            .map(doc => ({ name: doc.name, content: readArtifact(repo, doc.name, { taskMaterialRoot: snapshot.workspace })?.content.slice(0, 32_000) }));
          const context = JSON.stringify({ requirement: snapshot.requirement, mr: snapshot.delivery!.mr_url,
            head, base, captured_at: capturedAt, design: designs,
            // 已有结构化记录冻结后交给模型；当前流水线未结束不等待、不追更。
            test_records: { prepush: snapshot.delivery!.prepush, pipeline: snapshot.delivery!.pipeline,
              pipeline_sha: snapshot.delivery!.sha, checks: snapshot.delivery!.checks, baseline: snapshot.baseline_build },
          }, null, 2);
          writeFileSync(join(root, "input.json"), context, { mode: 0o600 });
          const body = await this.runner({ taskId: snapshot.id, repo, root, head, base,
            mrUrl: snapshot.delivery!.mr_url!, capturedAt, context }, abort.signal, options);
          abort.signal.throwIfAborted();
          if (!existsSync(root) || task.summary.status === "canceled") return;
          const content = `# 交付摘要\n\n> 首次交付快照，后续 MR 修改不在本文更新。\n> MR：${snapshot.delivery!.mr_url}\n> 版本：\`${head}\` · ${capturedAt}\n\n${body.trim()}\n`;
          const temporary = join(root, "summary.tmp");
          writeFileSync(temporary, content, { mode: 0o600 });
          renameSync(temporary, join(snapshot.workspace, DELIVERY_SUMMARY_FILE));
          save("completed");
          try { options.onPublished?.(); }
          catch (error) { options.log?.(`交付摘要已发布，任务投影刷新失败：${String(error)}`); }
          // 通知沿用既有投递记录和重试，不引入确认卡，不影响已发布的摘要。
          const account = task.summary.luban_account;
          if (account && options.notifier && options.taskLink) {
            try {
              await options.notifier.notifyOutcome({ taskId: snapshot.id, account,
                status: "首次交付摘要已生成",
                summary: "首次交付摘要已生成，包含改动图与测试情况，请联系对应 Committer 审视。本文为首次交付快照，后续修改请查看 MR diff。",
                link: `${options.taskLink}?deliverySummary=1`,
              });
            } catch (error) { options.log?.(`交付摘要通知失败（文档已发布）：${String(error)}`); }
          }
        } catch (error) {
          save("failed", String(error));
          options.log?.(`任务 ${snapshot.id} 交付摘要未生成（不影响交付）：${String(error)}`);
        } finally { clearTimeout(timer); }
      }).catch(error => {
        try { if (existsSync(root)) writeFileSync(statePath, JSON.stringify({ status: "failed", head, captured_at: capturedAt, error: String(error) })); }
        catch { /* 状态磁盘故障也不得影响交付。 */ }
      }).finally(() => this.jobs.delete(snapshot.id));
      this.jobs.set(snapshot.id, { abort, work });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // 旁路连状态文件也写不了时不能反向阻断 MR。
        console.warn(`交付摘要启动失败：${String(error)}`);
      }
    }
  }

  async flush(): Promise<void> { await Promise.all([...this.jobs.values()].map(job => job.work)); }
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const job of this.jobs.values()) job.abort.abort(new Error("服务停止"));
    await this.flush();
  }
}
