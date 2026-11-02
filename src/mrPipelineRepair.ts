import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PIPELINE_DIMENSIONS, onlyUnfixableToolFailures } from "./pipelineContract.ts";
import type { PipelineRun, PipelineStatus } from "./pipelineClient.ts";
import { normalizeRepairMrUrl, repairIsActive, type PipelineRepairRecord, type RepairMr } from "./mrPipelineRepairTypes.ts";

export interface RepairWorkspace {
  repair(run: PipelineRun, round: number): Promise<{ sha: string; summary: string }>;
  push(): Promise<string>;
  close(): Promise<void>;
}

export interface PipelineRepairRuntime {
  unavailableReason(): string | undefined;
  detail(url: string, account: string, signal: AbortSignal): Promise<RepairMr>;
  status(mr: RepairMr, account: string, signal: AbortSignal): Promise<PipelineStatus>;
  trigger(mr: RepairMr, account: string, signal: AbortSignal): Promise<unknown>;
  open(record: PipelineRepairRecord, root: string, signal: AbortSignal, note: (text: string) => void): Promise<RepairWorkspace>;
}

export class PipelineRepairError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function sameMrRevision(current: RepairMr, expected: RepairMr): boolean {
  return current.state === "opened" && current.sha === expected.sha && current.repo === expected.repo
    && current.source_branch === expected.source_branch && current.target_branch === expected.target_branch;
}

/** 仅管理 MR 修复记录和执行，不创建需求任务或问题会话。 */
export class MrPipelineRepairs {
  private readonly records = new Map<string, PipelineRepairRecord>();
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  constructor(readonly options: {
    dataDir: string;
    runtime: PipelineRepairRuntime;
    managedMr?: (mr: RepairMr) => string | undefined;
    maxRounds?: () => number;
    unfixableTools?: string[];
    pollMs?: number;
    waitMs?: number;
    maxConcurrent?: number;
    log?: (message: string) => void;
  }) {
    const root = join(options.dataDir, "pipeline-repairs");
    if (!existsSync(root)) return;
    for (const id of readdirSync(root).filter(id => /^repair-[a-f0-9-]+$/.test(id))) {
      try {
        const record = JSON.parse(readFileSync(join(root, id, "record.json"), "utf8")) as PipelineRepairRecord;
        if (record.id !== id || !record.account || !Array.isArray(record.logs)) continue;
        this.records.set(id, record);
        if (repairIsActive(record.status)) this.update(record, "needs_attention", "执行服务已重启，工作区和记录已保留，可重试继续");
      } catch (error) { options.log?.(`[pipeline-repair] 无法读取记录 ${id}: ${String(error)}`); }
    }
  }

  list(account: string) {
    const reason = this.options.runtime.unavailableReason();
    return { enabled: !reason, ...(reason ? { reason } : {}), records: [...this.records.values()]
      .filter(r => r.account === account).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(r => structuredClone(r)) };
  }
  get(id: string, account: string): PipelineRepairRecord {
    const record = this.records.get(id);
    if (!record || record.account !== account) throw new PipelineRepairError("修复记录不存在", 404);
    return structuredClone(record);
  }
  start(url: unknown, account: string): PipelineRepairRecord {
    this.assertAvailable();
    const mrUrl = normalizeRepairMrUrl(url);
    const existing = [...this.records.values()].find(r => r.mr_url === mrUrl && repairIsActive(r.status));
    if (existing) {
      if (existing.account === account) return structuredClone(existing);
      throw new PipelineRepairError("这个 MR 正在修复，请等待本次修复结束", 409);
    }
    const now = new Date().toISOString();
    const record: PipelineRepairRecord = { id: `repair-${randomUUID()}`, account, mr_url: mrUrl,
      status: "queued", message: "已排队，等待读取 MR", round: 0, created_at: now, updated_at: now, logs: [] };
    this.records.set(record.id, record); this.save(record); this.pump();
    return structuredClone(record);
  }
  retry(id: string, account: string) {
    this.assertAvailable(); this.get(id, account);
    const record = this.records.get(id)!;
    if (repairIsActive(record.status) || this.running.has(id)) throw new PipelineRepairError("本次修复仍在运行或停止中", 409);
    if ([...this.records.values()].some(r => r.id !== id && r.mr_url === record.mr_url && repairIsActive(r.status))) {
      throw new PipelineRepairError("这个 MR 已有另一项修复正在运行", 409);
    }
    this.update(record, "queued", "已排队，将保留工作区继续处理"); this.pump();
    return this.get(id, account);
  }
  stop(id: string, account: string) {
    this.get(id, account); const record = this.records.get(id)!;
    const active = this.running.get(id);
    if (active) { this.update(record, "stopping", "正在停止执行并释放容器"); active.controller.abort(); }
    else if (repairIsActive(record.status)) this.update(record, "stopped", "已停止，工作区和修复记录保留");
    return this.get(id, account);
  }
  async shutdown() {
    this.closing = true;
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.all([...this.running.values()].map(r => r.done));
  }
  private assertAvailable() {
    if (this.closing) throw new PipelineRepairError("执行服务正在关闭", 503);
    const reason = this.options.runtime.unavailableReason();
    if (reason) throw new PipelineRepairError(reason, 503);
  }
  private root(id: string) { return join(this.options.dataDir, "pipeline-repairs", id); }
  private save(record: PipelineRepairRecord) {
    const root = this.root(record.id); mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = join(root, "record.json");
    writeFileSync(file + ".tmp", JSON.stringify(record), { mode: 0o600 }); renameSync(file + ".tmp", file);
  }
  private note(record: PipelineRepairRecord, text: string) {
    record.updated_at = new Date().toISOString();
    record.logs.push({ at: record.updated_at, text: text.slice(0, 4000) });
    record.logs = record.logs.slice(-120); this.save(record);
  }
  private update(record: PipelineRepairRecord, status: PipelineRepairRecord["status"], message: string) {
    if (record.status === status && record.message === message) return;
    record.status = status; record.message = message; this.note(record, message);
  }
  private pump() {
    if (this.closing) return;
    for (const record of this.records.values()) {
      if (this.running.size >= (this.options.maxConcurrent ?? 2)) break;
      if (record.status !== "queued" || this.running.has(record.id)) continue;
      const controller = new AbortController();
      const done = Promise.resolve().then(() => this.run(record, controller.signal)).finally(() => {
        this.running.delete(record.id); this.pump();
      });
      void done.catch(error => this.options.log?.(`[pipeline-repair] ${record.id}: ${String(error)}`));
      this.running.set(record.id, { controller, done });
    }
  }
  private ensureUnmanaged(mr: RepairMr) {
    const reason = this.options.managedMr?.(mr);
    if (reason) throw new Error(reason);
  }
  private async run(record: PipelineRepairRecord, signal: AbortSignal) {
    const runtime = this.options.runtime;
    let workspace: RepairWorkspace | undefined;
    try {
      signal.throwIfAborted(); this.update(record, "preparing", "正在读取 MR 仓库、分支和当前提交");
      const mr = await runtime.detail(record.mr_url, record.account, signal);
      if (mr.state !== "opened") throw new Error("MR 已关闭或合入，不能继续自动修复");
      this.ensureUnmanaged(mr);
      if ([...this.records.values()].some(other => other.id !== record.id && repairIsActive(other.status)
        && other.mr?.repo === mr.repo && other.mr.source_branch === mr.source_branch)) {
        throw new Error("同一源分支正在被另一项流水线修复使用，请等待该项修复结束");
      }
      if (record.mr && (record.mr.repo !== mr.repo || record.mr.source_branch !== mr.source_branch)) {
        throw new Error("MR 仓库或源分支已变化，请新建一项修复");
      }
      record.mr = mr; this.save(record);
      const max = Math.max(0, Math.floor(this.options.maxRounds?.() ?? 20));
      let rounds = 0, triggered = "", waitingSince = Date.now();
      for (;;) {
        signal.throwIfAborted();
        const current = await runtime.detail(record.mr_url, record.account, signal);
        if (!sameMrRevision(current, mr)) throw new Error("MR 状态、分支或提交已变化，已停止，请核对后重试");
        this.ensureUnmanaged(current);
        const status = await runtime.status(mr, record.account, signal);
        signal.throwIfAborted();
        const run = status.runs.find(r => r.sha === mr.sha && r.is_valid !== false);
        record.checks = run?.checks; this.save(record);
        if (!run || run.status === "running") {
          if (Date.now() - waitingSince > (this.options.waitMs ?? 2 * 60 * 60_000)) throw new Error("等待当前提交的流水线超时，请在代码平台检查后重试");
          if (!run && status.runs.length) throw new Error("平台未返回当前提交的有效流水线记录，不能使用旧提交的结果");
          if (!run && triggered !== mr.sha) { await runtime.trigger(mr, record.account, signal); triggered = mr.sha; }
          this.update(record, "verifying", run ? "正在等待当前提交的流水线结果" : "等待平台生成当前提交的流水线记录");
          await delay(this.options.pollMs ?? 10_000, undefined, { signal }); continue;
        }
        if (run.status === "success") {
          if (!PIPELINE_DIMENSIONS.every(d => run.checks?.some(c => c.dimension === d))
            || run.checks?.some(c => c.status !== "success")) throw new Error("流水线总体通过，但编译、测试或代码质量的逐项通过证据不完整");
          const final = await runtime.detail(record.mr_url, record.account, signal);
          signal.throwIfAborted();
          if (!sameMrRevision(final, mr)) throw new Error("验证结束时 MR 已变化，请核对后重试");
          this.update(record, "passed", "当前 MR 提交的编译、测试和代码质量检查均已通过"); break;
        }
        if (onlyUnfixableToolFailures(run.checks, this.options.unfixableTools)) throw new Error("剩余告警来自无法自动修复的工具，请在代码平台处理后重试");
        if (rounds >= max) throw new Error(`本次已完成 ${max} 轮修复仍未通过，请查看记录并人工处理`);
        if (!workspace) {
          this.update(record, "preparing", "正在准备独立代码工作区与构建环境");
          workspace = await runtime.open(record, this.root(record.id), signal, text => { if (!signal.aborted) this.note(record, text); });
        }
        signal.throwIfAborted(); rounds++; record.round++;
        this.update(record, "repairing", `正在进行第 ${record.round} 轮修复与本地编译、测试`);
        const result = await workspace.repair(run, record.round);
        signal.throwIfAborted(); this.ensureUnmanaged(mr);
        const beforePush = await runtime.detail(record.mr_url, record.account, signal);
        if (!sameMrRevision(beforePush, mr)) throw new Error("修复期间 MR 的分支、提交或状态已变化，已保留本地修改并停止推送");
        if (result.sha === mr.sha) throw new Error(result.summary || "本轮没有产生新的修复提交，已停止重复尝试");
        const sha = await workspace.push();
        mr.sha = sha; this.note(record, `平台已推送提交 ${sha.slice(0, 12)}`);
        if (sha !== result.sha) throw new Error("推送提交与本地验证的提交不一致，请人工核对");
        signal.throwIfAborted(); this.note(record, result.summary);
        await runtime.trigger(mr, record.account, signal); triggered = sha; waitingSince = Date.now();
        this.update(record, "verifying", "已推送修复提交，正在检查新提交的流水线");
        await delay(this.options.pollMs ?? 10_000, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) this.update(record, this.closing ? "needs_attention" : "stopped",
        this.closing ? "执行服务已停止，工作区和记录保留，可重试继续" : "已停止，工作区和修复记录保留");
      else this.update(record, "needs_attention", error instanceof Error ? error.message : "修复执行失败，请查看记录");
    } finally {
      try { await workspace?.close(); }
      catch (error) { this.update(record, "needs_attention", "执行已结束，但容器释放失败，请管理员检查执行服务日志"); this.options.log?.(`[pipeline-repair] ${record.id} cleanup: ${String(error)}`); }
    }
  }
}
