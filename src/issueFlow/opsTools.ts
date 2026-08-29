/**
 * 问题流的宿主侧运维工具执行器(fetch-logs / build-deploy)。
 *
 * 二进制来自 assets/ops-tools(every-skill 仓的 Go 产物,本仓带
 * linux-amd64/arm64/exe 三平台)。关键边界:密码经环境变量只交给
 * 子进程(FETCH_LOGS_PASSWORD / BUILD_DEPLOY_PASSWORD),不落盘、
 * 不回传、不进模型上下文——与旧 Go 适配器同一条纪律,只是调用方
 * 从"宿主适配器"换成了"会话宿主工具"。
 *
 * fetch-logs 的产物直接落到会话工作区的 local-logs/ 下,Agent 在
 * 容器里 grep/读真实文件——不再像旧适配器那样截成 2MB 摘要,深度
 * 分析需要完整日志目录结构。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OpsFetchLogsRequest {
  hosts: string[];
  services: string[];
  password: string;
  /** 日志落地目录(会话工作区内)。 */
  localDir: string;
}

export interface OpsBuildDeployRequest {
  /** 含 deployment/pom.xml 的项目根(会话工作区内的克隆目录)。 */
  projectPath: string;
  hosts: string[];
  password: string;
  includeLib: boolean;
}

export interface IssueOpsTools {
  fetchLogs(request: OpsFetchLogsRequest): Promise<{ summary: string }>;
  buildDeploy(request: OpsBuildDeployRequest): Promise<{ summary: string }>;
}

export class IssueOpsError extends Error {}

function platformBinary(toolsDir: string, base: string): string {
  const name = process.platform === "win32"
    ? `${base}.exe`
    : process.arch === "arm64" ? `${base}-linux-arm64` : `${base}-linux-amd64`;
  const path = join(toolsDir, name);
  if (!existsSync(path)) {
    throw new IssueOpsError(`运维二进制不存在: ${path}(部署需带 assets/ops-tools)`);
  }
  return path;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(binary, args, {
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        code: error ? (typeof code === "number" ? code : -1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function tail(text: string, limit = 2_500): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export function createGoOpsTools(options: {
  toolsDir: string;
  log?: (message: string) => void;
}): IssueOpsTools {
  const { toolsDir, log } = options;
  return {
    async fetchLogs(request) {
      if (!request.hosts.length) throw new IssueOpsError("未提供网管服务器地址");
      if (!request.services.length) throw new IssueOpsError("未提供要抓取的服务名");
      const args = [
        ...request.hosts.flatMap((host) => ["--host", host]),
        ...request.services.flatMap((service) => ["--service", service]),
        "--local-dir", request.localDir,
      ];
      log?.(`[issue-ops] fetch-logs: ${request.services.join(",")} @ `
        + `${request.hosts.join(",")}`);
      const result = await run(
        platformBinary(toolsDir, "fetch-logs"),
        args,
        { ...process.env, FETCH_LOGS_PASSWORD: request.password },
        15 * 60_000,
      );
      if (result.code !== 0 || !/解压完成/.test(result.stdout)) {
        throw new IssueOpsError(
          `拉取日志失败(退出码 ${result.code}): `
          + tail(`${result.stdout}\n${result.stderr}`.trim()));
      }
      return { summary: `日志已拉取到 ${request.localDir}:\n${tail(result.stdout)}` };
    },

    async buildDeploy(request) {
      if (!request.hosts.length) throw new IssueOpsError("未提供部署目标服务器");
      if (!existsSync(join(request.projectPath, "deployment", "pom.xml"))) {
        throw new IssueOpsError(
          `项目路径 ${request.projectPath} 下没有 deployment/pom.xml,`
          + "build-deploy 无法识别服务——请确认代码仓结构");
      }
      const args = [
        "--project-path", request.projectPath,
        ...request.hosts.flatMap((host) => ["--host", host]),
      ];
      if (request.includeLib) args.push("--include-lib");
      log?.(`[issue-ops] build-deploy: ${request.projectPath} @ `
        + `${request.hosts.join(",")}${request.includeLib ? " (含 lib)" : ""}`);
      const result = await run(
        platformBinary(toolsDir, "build-deploy"),
        args,
        { ...process.env, BUILD_DEPLOY_PASSWORD: request.password },
        20 * 60_000,
      );
      if (result.code !== 0 || !/\[INFO\].*部署完成/.test(result.stdout)) {
        throw new IssueOpsError(
          `构建部署失败(退出码 ${result.code}): `
          + tail(`${result.stdout}\n${result.stderr}`.trim()));
      }
      return { summary: `部署输出:\n${tail(result.stdout)}` };
    },
  };
}
