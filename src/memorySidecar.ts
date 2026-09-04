/**
 * 任务记忆检索旁路进程的宿主侧客户端(docs/knowledge-memory-design.md §7)。
 *
 * memsearch 是 Python,模型加载要几秒,所以常驻一个子进程,stdio 一行一个
 * JSON。这里只做三件事:拉起/重拉、按 id 配对请求、每次调用带预算。
 *
 * 纪律(红线"agent 不能因 harness 卡死"):
 * - 每个请求都有超时,超时返回 undefined,调用方按"检索暂不可用"处理;
 *   绝不让 Agent 或页面等一个不会回来的应答。
 * - 进程死了自动重拉,带退避和次数上限;拉不起来就 unavailable,任务照跑。
 * - 检索是索引不是正本:这里任何失败都不影响 corpus/ 里的 md。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface MemorySidecarOptions {
  /** venv 里的 python(部署包装脚本已带 HF_HOME/OFFLINE/TMPDIR)。 */
  python: string;
  script: string;
  corpusDir: string;
  milvusPath: string;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** 测试用:替换 spawn。 */
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv)
    => ChildProcessWithoutNullStreams;
  budgets?: Partial<MemorySidecarBudgets>;
}

export interface MemorySidecarBudgets {
  healthMs: number;
  ingestMs: number;
  searchMs: number;
  expandMs: number;
  /** 起进程到 ready 的预算:模型加载内网实测 2.8s,给 60s 兜冷盘。 */
  bootMs: number;
}

export const DEFAULT_MEMORY_BUDGETS: MemorySidecarBudgets = {
  healthMs: 500, ingestMs: 5_000, searchMs: 1_500, expandMs: 1_000, bootMs: 60_000,
};

export interface MemorySearchHit {
  id: string;
  score: number;
  heading?: string;
  snippet?: string;
  file?: string;
  repo?: string;
  judged_by?: "human" | "pipeline";
  source?: string;
  scope?: string;
  at?: string;
  task?: string;
  paths?: string[];
  line?: number;
  phase?: string;
}

type Pending = {
  resolve: (value: Record<string, unknown> | undefined) => void;
  timer: NodeJS.Timeout;
};

const MAX_RESTARTS = 5;

export class MemorySidecar {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private booting?: Promise<boolean>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restarts = 0;
  private stopped = false;
  private readonly budgets: MemorySidecarBudgets;

  constructor(private readonly options: MemorySidecarOptions) {
    this.budgets = { ...DEFAULT_MEMORY_BUDGETS, ...(options.budgets ?? {}) };
  }

  get available(): boolean {
    return this.ready && !!this.child && !this.stopped;
  }

  /** 拉起并等 ready。重复调用共用一个 boot;失败返回 false 不抛。 */
  start(): Promise<boolean> {
    if (this.available) return Promise.resolve(true);
    if (this.booting) return this.booting;
    if (this.stopped || this.restarts > MAX_RESTARTS) return Promise.resolve(false);
    this.booting = this.boot().finally(() => { this.booting = undefined; });
    return this.booting;
  }

  private async boot(): Promise<boolean> {
    const { options } = this;
    const args = [
      options.script, "--corpus", options.corpusDir, "--milvus", options.milvusPath,
      ...(options.provider ? ["--provider", options.provider] : []),
      ...(options.model ? ["--model", options.model] : []),
    ];
    const env = { ...process.env, ...(options.env ?? {}) };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawnProcess
        ? options.spawnProcess(options.python, args, env)
        : spawn(options.python, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      options.log?.(`记忆检索旁路拉不起来: ${String(error)}`);
      this.restarts += 1;
      return false;
    }
    this.child = child;
    this.ready = false;
    const readyPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.budgets.bootMs);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;                         // 非协议行(依赖库偶尔往 stdout 吐)只丢它自己
        }
        if (message.id === 0) {
          if (message.ready === true) {
            clearTimeout(timer);
            this.ready = true;
            resolve(true);
          } else if (message.error) {
            options.log?.(`记忆检索旁路启动失败: ${String(message.error)}`);
            clearTimeout(timer);
            resolve(false);
          }
          return;
        }
        const id = Number(message.id);
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) options.log?.(`[memsearch-sidecar] ${text.slice(0, 400)}`);
      });
      child.on("error", (error) => {
        options.log?.(`记忆检索旁路进程错误: ${String(error)}`);
        clearTimeout(timer);
        resolve(false);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        this.onExit(child, code, signal);
        resolve(false);
      });
    });
    const ok = await readyPromise;
    if (!ok) {
      this.restarts += 1;
      if (this.child === child) {
        this.ready = false;
        try { child.kill(); } catch { /* 已死 */ }
      }
    } else {
      this.restarts = 0;
    }
    return ok;
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(undefined);
      this.pending.delete(id);
    }
    if (this.stopped) return;
    this.options.log?.(
      `记忆检索旁路退出(code=${code ?? "-"} signal=${signal ?? "-"}),`
      + (this.restarts < MAX_RESTARTS ? "将按需重拉" : "重拉次数用尽,检索停用"));
  }

  private async request(
    payload: Record<string, unknown>,
    budgetMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    if (!(await this.start())) return undefined;
    const child = this.child;
    if (!child) return undefined;
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.options.log?.(`记忆检索 ${String(payload.op)} 超预算 ${budgetMs}ms,按不可用处理`);
        resolve(undefined);
      }, budgetMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.options.log?.(`记忆检索写入失败: ${String(error)}`);
        resolve(undefined);
      }
    });
  }

  async health(): Promise<boolean> {
    const reply = await this.request({ op: "health" }, this.budgets.healthMs);
    return reply?.ok === true;
  }

  /** 单条入库;失败只记日志——正本已经在 md 里,索引晚点重建也不丢。 */
  async ingest(path: string): Promise<boolean> {
    const reply = await this.request({ op: "ingest", path }, this.budgets.ingestMs);
    if (reply?.error) this.options.log?.(`记忆索引失败 ${path}: ${String(reply.error)}`);
    return reply?.ok === true;
  }

  async reindex(): Promise<number | undefined> {
    const reply = await this.request({ op: "reindex" }, this.budgets.bootMs);
    return reply?.ok === true ? Number(reply.chunks ?? 0) : undefined;
  }

  async search(input: {
    query: string; repo: string; pathPrefix?: string; limit?: number;
  }): Promise<MemorySearchHit[] | undefined> {
    const reply = await this.request({
      op: "search", query: input.query, repo: input.repo,
      path_prefix: input.pathPrefix ?? "", limit: Math.min(input.limit ?? 8, 20),
    }, this.budgets.searchMs);
    if (!reply || reply.error || !Array.isArray(reply.hits)) return undefined;
    return (reply.hits as MemorySearchHit[]).filter((hit) => typeof hit.id === "string");
  }

  async expand(memoryId: string): Promise<string | undefined> {
    const reply = await this.request(
      { op: "expand", memory_id: memoryId }, this.budgets.expandMs);
    return reply?.ok === true && typeof reply.content === "string"
      ? reply.content : undefined;
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    try { child?.stdin.end(); child?.kill(); } catch { /* 已死 */ }
  }
}
