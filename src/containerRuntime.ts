/**
 * 任务容器运行时(容器隔离设计 §分步 1):起/停/exec,docker CLI 直驱。
 *
 * 隔离的是命令执行,不是会话:工作区以相同绝对路径挂载,容器内
 * 命令、宿主文件工具、内核状态文件三方看同一份文件,零路径映射。
 * 容器从不保存状态——工作区全在挂载卷里,重建容器=重新 run,
 * 恢复语义(§11)天然满足。
 */

import { execFile, spawn } from "node:child_process";

function docker(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || String(error)));
        else resolve(stdout.trim());
      });
  });
}

export class TaskContainer {
  private containerId = "";

  constructor(
    readonly image: string,
    readonly workspace: string,
    /** 容器名(按任务定,如 mfc-task-1):恢复重启时同名先杀,
     * 崩溃留下的孤儿不累积。 */
    readonly name: string,
    private log?: (message: string) => void,
    /** 额外挂载("宿主:容器"),如构建缓存 ~/.m2/repository——
     * 没有它每个任务都从零下依赖。 */
    private volumes: string[] = [],
    /** 资源限额与身份映射(设计文档后续项):memory 如 "2g"、
     * cpus 如 "2"、user 如 "1000:1000"(容器内以宿主 uid 写挂载卷,
     * 文件属主不漂移)。不配即不限。 */
    private limits: { memory?: string; cpus?: string; user?: string } = {},
  ) {}

  /** 长驻容器:工作区同路径挂载。起不来就抛——要隔离就真隔离,
   * 静默降级回宿主执行是假隔离。 */
  async start(): Promise<void> {
    await docker("rm", "-f", this.name).catch(() => undefined);
    this.containerId = await docker(
      "run", "-d", "--rm", "--name", this.name,
      "-v", `${this.workspace}:${this.workspace}`,
      ...this.volumes.flatMap((volume) => ["-v", volume]),
      ...(this.limits.memory ? ["--memory", this.limits.memory] : []),
      ...(this.limits.cpus ? ["--cpus", this.limits.cpus] : []),
      ...(this.limits.user ? ["--user", this.limits.user] : []),
      "-w", this.workspace,
      this.image, "sleep", "infinity");
    // 挂载仓在容器视角属主"可疑",git 会拒绝操作(dubious ownership)。
    // 预置 safe.directory 免得模型在真跑里烧一回合自救(push 排雷实测)。
    await docker("exec", this.containerId,
      "git", "config", "--global", "--add", "safe.directory", "*")
      .catch(() => undefined);
    this.log?.(`容器就位: ${this.name} (${this.image})`);
  }

  /** BashOperations.exec 同形:流式输出、退出码原样、超时即杀。
   * 已知边界(设计文档):杀的是 exec 客户端,容器内进程由
   * 任务收口销毁容器兜底。 */
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      if (!this.containerId) {
        reject(new Error("容器未启动,不能执行命令"));
        return;
      }
      const child = spawn("docker",
        ["exec", "-w", cwd, this.containerId, "sh", "-lc", command],
        { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", options.onData);
      child.stderr.on("data", options.onData);
      let timer: NodeJS.Timeout | undefined;
      if (options.timeout) {
        timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
        timer.unref?.();
      }
      options.signal?.addEventListener(
        "abort", () => child.kill("SIGKILL"), { once: true });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code });
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** 停容器(--rm 会连带删除)。失败只记日志——收口路径不许被
   * 清理动作卡住,孤儿容器可由运维清扫。 */
  async stop(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    this.containerId = "";
    try {
      await docker("kill", id);
    } catch (error) {
      this.log?.(`容器清理失败(不影响任务): ${String(error)}`);
    }
  }
}

/** docker 可用性探测(daemon 活着才算可用,只装了 CLI 不算)。 */
export async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf-8",
      timeout: 5_000,
    }, (error) => resolve(!error));
  });
}
