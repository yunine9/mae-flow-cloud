/**
 * IssueEnvironmentAdapter 的 Go 工具实现(every-skill 的 fetch-logs /
 * build-deploy)。
 *
 * 边界(docs/dts-issue-flow.md 的环境凭据契约在此落地):
 * - 密码由任务保险箱解密后**经环境变量**注入子进程(FETCH_LOGS_PASSWORD /
 *   BUILD_DEPLOY_PASSWORD),不落参数表(进程列表可见)、不落任何文件;
 * - 工具二进制与日志产物都只活在**仓外临时目录**,用完即删,不进任务
 *   工作区——Agent 只见适配器返回的日志文本/部署回执;
 * - 一切等待带预算(signal 合作式取消 + 宿主侧硬超时杀进程);错误文案
 *   只回工具 stdout/stderr 摘要,绝不拼凭据;
 * - fetch-logs 只支持 22 端口(工具固定 SSH 端口),配置了别的端口如实
 *   报错而不是悄悄连错。
 *
 * 换库说明:deployCandidate 以任务代码工作区(含 deployment/pom.xml 的
 * 克隆目录)为 project_path 构建。rollback 不实现——Go 工具只有部署前的
 * 自动备份(`版本号_bak时间戳`),没有一键回滚命令,能力位保持缺席比
 * 假装可回滚诚实。
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IssueEnvironmentAdapter,
  IssueEnvironmentAdapterRequest,
} from "./issueEnvironment.ts";

export interface GoEnvironmentAdapterOptions {
  /** 两个 Go 工具二进制所在目录(assets/ops-tools)。 */
  toolsDir: string;
  /** deployCandidate 要在任务工作区里找代码克隆(含 deployment/pom.xml
   * 的子目录)当 project_path。宿主侧注入查找函数(serve 持有 TaskService
   * 后回填;诊断期任务的克隆就在 workspace 下)。 */
  workspaceOf?: (taskId: string) => string | undefined;
  /** 测试注入:替换真实 spawn(原子能力的单测都从这里进)。 */
  spawnFn?: typeof spawn;
  /** 测试注入:固定二进制名(绕过平台选择)。 */
  binaryName?: { fetchLogs?: string; deploy?: string };
  /** 拉日志预算(ms);宿主 collectIssueEnvironmentLogs 的硬上限是 60s,
   * 这里默认 55s 让子进程先死,不留下孤儿 SSH。 */
  fetchTimeoutMs?: number;
  /** 换库预算(ms);Maven 构建+多台部署通常 2-5 分钟。 */
  deployTimeoutMs?: number;
  log?: (message: string) => void;
}

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 日志收集的诚实上限:截断说截断,省略说省略,不静默丢。 */
const MAX_LOG_FILES = 50;
const MAX_LOG_FILE_BYTES = 256 * 1024;
const MAX_LOG_TOTAL_BYTES = 2 * 1024 * 1024;

function platformBinary(base: string): string {
  if (process.platform === "win32") return `${base}.exe`;
  return process.arch === "arm64"
    ? `${base}-linux-arm64` : `${base}-linux-amd64`;
}

/** fetch-logs/build-deploy 的 SSH 登录账号都是 sopuser(工具内固定),
 * 保险箱给了三套账号,这里选 sopuser 那套的密码。 */
function primaryPassword(
  request: IssueEnvironmentAdapterRequest,
): string {
  const account = request.credentials.find(
    (item) => item.username === "sopuser") ?? request.credentials[0];
  const password = account?.password || request.credential?.password;
  if (!password) {
    throw new Error("环境凭据里没有 sopuser 密码,无法执行工具");
  }
  return password;
}

function runTool(options: {
  spawnFn: typeof spawn;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("采集已被取消(signal 已中止)"));
      return;
    }
    const child = options.spawnFn(
      options.binary, options.args, { env: options.env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`工具执行超过 ${Math.round(options.timeoutMs / 1000)} 秒,已终止`));
      });
    }, options.timeoutMs);
    const onAbort = () => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("采集已被取消"));
      });
    };
    options.signal.addEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      finish(() => reject(new Error(`工具无法启动: ${error.message}`)));
    });
    child.on("close", (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });
  });
}

function tail(text: string, limit = 4000): string {
  return text.length > limit
    ? `…${text.slice(text.length - limit)}` : text;
}

interface CollectedFile {
  relative: string;
  content: string;
  truncated: boolean;
}

function collectLogFiles(root: string): {
  files: CollectedFile[];
  skipped: string[];
} {
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let info;
      try {
        info = statSync(path);
      } catch {
        continue; // 竞态删除:跳过
      }
      if (info.isDirectory()) {
        walk(path, relative);
        continue;
      }
      if (!info.isFile()) continue;
      if (files.length >= MAX_LOG_FILES) {
        skipped.push(`${relative}(文件数超上限)`);
        continue;
      }
      const budget = Math.min(
        MAX_LOG_FILE_BYTES, MAX_LOG_TOTAL_BYTES - total);
      if (budget <= 0) {
        skipped.push(`${relative}(总量超上限)`);
        continue;
      }
      const raw = readFileSync(path, "utf-8");
      const withinBudget = raw.length <= budget;
      const content = withinBudget ? raw : raw.slice(0, budget);
      total += content.length;
      files.push({ relative, content, truncated: !withinBudget });
    }
  };
  if (existsSync(root)) walk(root, "");
  return { files, skipped };
}

/** 在任务工作区里找代码克隆:含 deployment/pom.xml 的直接子目录
 * (诊断期任务的仓就克隆在那;找不到返回 undefined 由调用方报错)。 */
function findProjectDir(workspace: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch {
    return undefined;
  }
  for (const name of entries.sort()) {
    const candidate = join(workspace, name);
    try {
      if (statSync(candidate).isDirectory()
          && existsSync(join(candidate, "deployment", "pom.xml"))) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function createGoEnvironmentAdapter(
  options: GoEnvironmentAdapterOptions,
): IssueEnvironmentAdapter {
  const spawnFn = options.spawnFn ?? spawn;
  const fetchBinary = options.binaryName?.fetchLogs
    ?? platformBinary("fetch-logs");
  const deployBinary = options.binaryName?.deploy
    ?? platformBinary("build-deploy");
  return {
    async fetchLogs(request) {
      if (request.environment.port !== 22) {
        throw new Error(
          `fetch-logs 工具仅支持 22 端口,环境 ${request.environment.name}`
          + ` 配置的是 ${request.environment.port}`);
      }
      const scratch = mkdtempSync(join(tmpdir(), "mfc-goenv-"));
      try {
        const localDir = join(scratch, "local-logs");
        options.log?.(`[goenv] 拉日志 ${request.environment.name}`
          + ` @ ${request.environment.host}(凭据经环境变量,不落盘)`);
        const outcome = await runTool({
          spawnFn,
          binary: join(options.toolsDir, fetchBinary),
          args: [
            "--host", request.environment.host,
            "--service", request.environment.name,
            "--local-dir", localDir,
          ],
          env: { FETCH_LOGS_PASSWORD: primaryPassword(request) },
          signal: request.signal,
          timeoutMs: options.fetchTimeoutMs ?? 55_000,
        });
        if (outcome.code !== 0) {
          // 只回工具自身输出(它不打印密码);绝不拼环境变量。
          throw new Error(
            `fetch-logs 退出码 ${outcome.code}:${tail(outcome.stdout + outcome.stderr)}`);
        }
        const { files, skipped } = collectLogFiles(localDir);
        const parts = files.map((file) => [
          `## ${file.relative}${file.truncated ? "(单文件超限,已截断)" : ""}`,
          file.content,
        ].join("\n"));
        if (!files.length) {
          // 工具自认成功却没落任何文件:如实说,不编"日志为空"的结论。
          throw new Error(
            `fetch-logs 报成功但没有产出日志文件:${tail(outcome.stdout)}`);
        }
        const suffix = skipped.length
          ? `\n\n[以下文件超出收集上限,已省略]\n${skipped.join("\n")}` : "";
        return {
          content: parts.join("\n\n") + suffix,
          source: `ssh://${request.environment.host}/var/log/oss/MAE/`
            + `${request.environment.name}`,
          collected_at: new Date().toISOString(),
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },

    async deployCandidate(request) {
      const workspace = options.workspaceOf?.(request.task_id);
      const projectDir = workspace ? findProjectDir(workspace) : undefined;
      if (!projectDir) {
        throw new Error(
          `找不到任务 ${request.task_id} 的代码克隆(工作区里没有含`
          + " deployment/pom.xml 的目录),无法构建部署");
      }
      options.log?.(`[goenv] 换库 ${request.environment.name}`
        + ` @ ${request.environment.host} ← ${projectDir}`);
      const outcome = await runTool({
        spawnFn,
        binary: join(options.toolsDir, deployBinary),
        args: [
          "--project-path", projectDir,
          "--host", request.environment.host,
        ],
        env: { BUILD_DEPLOY_PASSWORD: primaryPassword(request) },
        signal: request.signal,
        timeoutMs: options.deployTimeoutMs ?? 600_000,
      });
      // 成功哨兵与工具文档一致:服务器 x/y 部署完成 / 最终 部署完成。
      const sentinel = [...outcome.stdout.matchAll(
        /\[INFO\][^\n]*部署完成[^\n]*/g)].map((m) => m[0]);
      if (outcome.code !== 0 || !sentinel.length) {
        throw new Error(
          `build-deploy 未确认部署成功(退出码 ${outcome.code}):`
          + tail(outcome.stdout + outcome.stderr));
      }
      return {
        receipt_id: `go-deploy:${request.sha}:${request.environment.id}`,
        environment_id: request.environment.id,
        status: "deployed",
        at: new Date().toISOString(),
        summary: sentinel.join(" / "),
      };
    },
  };
}
