/**
 * 问题流的 Git 边界:克隆加固 + 宿主唯一一次传输。
 *
 * 机制与 TaskService 的同名能力同源(凭据沙箱、safeGit 只读视图、
 * 临时 bare 传输仓、ls-remote 复核),但按问题域的需要重写为独立
 * 模块——问题流与需求流是两条交付通道,互不 import;将来若要合并,
 * 以这里的契约为准抽公共层。安全语义不减配:
 * - Agent 侧 pushurl 一律指向 /dev/null(容器/宿主都推不动);
 * - 凭据只在一次 clone/push 的受控窗口进入 0700 临时目录;
 * - 宿主 push 从临时 bare 仓发起,不读工作区 .git/config。
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createSafeGitView } from "../safeGit.ts";

export interface GitCredential {
  username: string;
  password: string;
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolveRun) => {
    execFile("git", args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf-8",
      timeout: options.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolveRun({
        code: error ? (typeof code === "number" ? code : -1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/** 可执行 helper 不放系统 /tmp(生产宿主常挂 noexec);问题流自己的
 * 运行目录在数据目录 .runtime/issue-git 下,0700。 */
function runtimeDir(dataDir: string): string {
  const root = join(resolve(dataDir), ".runtime", "issue-git");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, "operation-"));
}

export interface GitSandbox {
  dir: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** 一次 Git 动作一个私有 HOME/配置边界。同 TaskService 版语义。 */
export function prepareSandbox(
  dataDir: string,
  credential: GitCredential | undefined,
): GitSandbox {
  const dir = runtimeDir(dataDir);
  let helper: string | undefined;
  if (credential) {
    const file = join(dir, "credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`,
      { mode: 0o600 });
    helper = join(dir, "helper.sh");
    writeFileSync(helper, [
      "#!/bin/sh",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(helper, 0o700);
  }
  const home = join(dir, "home");
  const xdg = join(dir, "xdg");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(xdg, { mode: 0o700 });
  const globalConfig = join(dir, "global.gitconfig");
  const systemConfig = join(dir, "system.gitconfig");
  writeFileSync(globalConfig, "", { mode: 0o600 });
  writeFileSync(systemConfig, "", { mode: 0o600 });
  const askpass = join(dir, "reject-askpass.sh");
  writeFileSync(askpass, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  chmodSync(askpass, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:CONFIG(?:_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS))?|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|EXEC_PATH|TEMPLATE_DIR|SSH|SSH_COMMAND|PROXY_COMMAND)$/.test(key)
        || /^GIT_CONFIG$/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: "never",
    GCM_INTERACTIVE: "Never",
  });
  const args = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.ext.allow=never",
    "-c", "credential.helper=",
    ...(helper ? ["-c", `credential.helper=${helper}`] : []),
  ];
  return {
    dir, args, env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function validateRepoUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("代码仓地址为空");
  if (/^(?:https?|file):\/\//i.test(value)) return value;
  const windowsDrive = /^[a-z]:[\\/]/i.test(value);
  if (windowsDrive || !/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return resolve(value); // 本地路径(测试/演示裸仓)
  }
  throw new Error("问题流只接受 HTTPS 或本地代码仓地址(不支持 ssh/git 协议)");
}

/** 认证类失败的机器标记(协议,不是文案):错误文本以此打头,前端
 * 「去个人设置配令牌」的跳转按钮认这个标记(web 侧镜像常量),人话
 * 怎么改都不破坏跳转。旧锚是文案里嵌「Git 令牌」字样——改字=跳转
 * 静默消失,正是本票要拆的文本匹配债务。 */
export const GIT_AUTH_ERROR_TAG = "[git-auth]";

/** 认证类失败 → "去哪配令牌"的引导;非认证失败返回 undefined 由调用方
 * 保留 git 原文,不吞事实。返回文本以 GIT_AUTH_ERROR_TAG 打头(前端
 * 跳转锚),人话部分随意改。
 *
 * 问题流 failed 是终态(不能续聊),引导说"重新发起"而不是"发消息重试"。 */
function authFailureHint(
  verb: string,
  credential: GitCredential | undefined,
  stderr: string,
): string | undefined {
  const fatal = stderr.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("fatal:")) ?? "";
  const tail = fatal ? `(${fatal})` : "";
  if (!credential
      && /could not read Username|terminal prompts disabled|read askpass/i.test(stderr)) {
    return `${GIT_AUTH_ERROR_TAG}${verb}需要 Git 凭据,当前账号还没有配置 Git 令牌:`
      + "请到「个人设置 → Git 令牌」填写代码平台的 HTTPS 密码或访问令牌"
      + "(Git 用户名 = 登录账号名),保存后重新发起问题分析。" + tail;
  }
  if (/Authentication failed|HTTP 403|status[ :=]403/i.test(stderr)) {
    return `${GIT_AUTH_ERROR_TAG}代码仓拒绝了 Git 凭据:请到「个人设置 → Git 令牌」核对令牌内容`
      + `(当前按登录账号「${credential?.username ?? "(未配置)"}」认证,Git 用户名 = 登录账号名),`
      + "保存后重新发起问题分析。" + tail;
  }
  return undefined;
}

/** 克隆失败 → 人话:认证类给引导,其余保留 git 原文。 */
export function cloneFailureMessage(
  credential: GitCredential | undefined,
  stderr: string,
): string {
  return authFailureHint("克隆代码仓", credential, stderr)
    ?? `克隆代码仓失败: ${stderr.trim().slice(0, 500)}`;
}

/** 克隆到 targetDir,并加固:origin URL 去 userinfo、pushurl 指向
 * /dev/null(Agent 可读可提交,但推不动;宿主推送走显式 URL)。 */
export async function cloneRepository(options: {
  dataDir: string;
  targetDir: string;
  repoUrl: string;
  baseline?: string;
  credential?: GitCredential;
}): Promise<void> {
  const url = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential);
  try {
    const outcome = await runGit([
      ...sandbox.args, "clone", "--quiet",
      ...(options.baseline ? ["--branch", options.baseline] : []),
      "--", url, options.targetDir,
    ], { env: sandbox.env, timeoutMs: 30 * 60_000 });
    if (outcome.code !== 0) {
      throw new Error(cloneFailureMessage(options.credential, outcome.stderr));
    }
    await hardenCloneAsync(options.targetDir);
  } finally {
    sandbox.cleanup();
  }
}

export async function hardenCloneAsync(repoDir: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const configArgs = (...args: string[]) =>
    ["config", "--file", join(repoDir, ".git", "config"), ...args];
  await runGit(configArgs("--unset-all", "credential.helper"),
    { env, timeoutMs: 10_000 }).catch(() => undefined);
  const origin = await runGit(configArgs("--get", "remote.origin.url"),
    { env, timeoutMs: 10_000 });
  if (origin.code === 0) {
    const raw = origin.stdout.trim();
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      const cleaned = parsed.toString();
      if (cleaned !== raw) {
        await runGit(configArgs("--replace-all", "remote.origin.url", cleaned),
          { env, timeoutMs: 10_000 });
      }
    } catch { /* 本地路径没有 userinfo 可清 */ }
  }
  await runGit(configArgs("--replace-all", "remote.origin.pushurl",
    "/dev/null/mae-flow-host-owned"), { env, timeoutMs: 10_000 });
}

export async function currentBranch(repoDir: string): Promise<string> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(["--no-pager", "branch", "--show-current"], {
      cwd: repoDir,
      env: view.environment(),
      timeoutMs: 10_000,
    });
    return outcome.code === 0 ? outcome.stdout.trim() : "";
  } finally {
    view.cleanup();
  }
}

/** 当前 HEAD 短 SHA(拉仓事实回报用;失败回空串由调用方如实呈现)。 */
export async function currentHead(repoDir: string): Promise<string> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(
      ["--no-pager", "rev-parse", "--short=12", "HEAD"],
      { cwd: repoDir, env: view.environment(), timeoutMs: 10_000 });
    return outcome.code === 0 ? outcome.stdout.trim() : "";
  } finally {
    view.cleanup();
  }
}

/** 宿主侧确定性建分支(固定流程阶段2/转正时用)。分支名规范
 * master_工号_单号 由调用方拼好;这里只负责"分支已在且已检出"这个
 * 终态:已检出=幂等通过;分支存在未检出=切过去;不存在=从起点建。
 * 绝不 reset 已有分支——已有提交意味着有轮次在现场,覆盖是事故。 */
export async function ensureBranch(options: {
  dataDir: string;
  repoDir: string;
  branch: string;
  /** 建分支起点;缺省当前 HEAD。 */
  startPoint?: string;
}): Promise<void> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    throw new Error(`代码克隆不存在: ${options.repoDir}`);
  }
  const format = await runGit(
    ["check-ref-format", "--branch", options.branch],
    { env: process.env, timeoutMs: 10_000 });
  if (format.code !== 0) throw new Error(`分支名不合法: ${options.branch}`);
  const sandbox = prepareSandbox(options.dataDir, undefined);
  try {
    const current = await runGit(
      [...sandbox.args, "branch", "--show-current"],
      { cwd: options.repoDir, env: sandbox.env, timeoutMs: 10_000 });
    if (current.code === 0 && current.stdout.trim() === options.branch) return;
    const checkout = await runGit([
      ...sandbox.args, "checkout", "--quiet", options.branch,
    ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
    if (checkout.code === 0) return;
    // 分支不存在:从起点(缺省 HEAD)建。已存在但切换失败(如脏工作
    // 区冲突)会走到这里再失败一次,原文带回去让人看。
    const create = await runGit([
      ...sandbox.args, "checkout", "--quiet", "-b", options.branch,
      ...(options.startPoint ? [options.startPoint] : []),
    ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
    if (create.code !== 0) {
      throw new Error(
        `建分支失败(${options.branch}): ${(create.stderr || checkout.stderr).trim().slice(0, 400)}`);
    }
  } finally {
    sandbox.cleanup();
  }
}

export interface PushReceipt {
  branch: string;
  sha: string;
  url: string;
}

/** 宿主唯一一次传输:从工作区经 safeGit 只读视图读对象,在临时 bare
 * 仓里 push 到显式远端,再 ls-remote 复核 SHA。分支名单由调用方
 * (单号门禁)先行校验,这里只管传输与复核的可靠性。 */
export async function pushFromIssueWorkspace(options: {
  dataDir: string;
  repoDir: string;
  repoUrl: string;
  branch: string;
  credential?: GitCredential;
}): Promise<PushReceipt> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    throw new Error(`代码克隆不存在: ${options.repoDir}`);
  }
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential);
  let view: ReturnType<typeof createSafeGitView> | undefined;
  const ref = `refs/heads/${options.branch}`;
  try {
    const format = await runGit(
      [...sandbox.args, "check-ref-format", "--branch", options.branch],
      { env: sandbox.env, timeoutMs: 10_000 });
    if (format.code !== 0) throw new Error(`分支名不合法: ${options.branch}`);
    view = createSafeGitView(options.repoDir);
    const head = await runGit([...sandbox.args, "rev-parse", "--verify", "HEAD"], {
      cwd: options.repoDir,
      env: view.environment(sandbox.env),
      timeoutMs: 30_000,
    });
    const sha = head.stdout.trim();
    if (head.code !== 0 || !sha) {
      throw new Error(`读取待推送 HEAD 失败: ${head.stderr.trim().slice(0, 400)}`);
    }
    const staging = join(sandbox.dir, "transport.git");
    const initialized = await runGit(
      [...sandbox.args, "init", "--quiet", "--bare", staging],
      { env: sandbox.env, timeoutMs: 30_000 });
    if (initialized.code !== 0) {
      throw new Error(`创建传输仓失败: ${initialized.stderr.trim().slice(0, 400)}`);
    }
    const objectEnv = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: view.objectDirectory,
    };
    const objectCheck = await runGit([
      ...sandbox.args, `--git-dir=${staging}`, "cat-file", "-e", `${sha}^{commit}`,
    ], { env: { ...sandbox.env, ...objectEnv }, timeoutMs: 30_000 });
    if (objectCheck.code !== 0) throw new Error("待推送 HEAD 不是可读取的提交对象");
    const pushed = await runGit([
      ...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
      "--porcelain", remoteUrl, `${sha}:${ref}`,
    ], { env: { ...sandbox.env, ...objectEnv }, timeoutMs: 5 * 60_000 });
    if (pushed.code !== 0) {
      const raw = `${pushed.stderr.trim() || pushed.stdout.trim()}`;
      throw new Error(authFailureHint("推送代码", options.credential, raw)
        ?? `宿主推送失败: ${raw.slice(0, 500)}`);
    }
    const verified = await runGit([
      ...sandbox.args, `--git-dir=${staging}`,
      "ls-remote", "--heads", remoteUrl, ref,
    ], { env: sandbox.env, timeoutMs: 60_000 });
    const remoteSha = verified.stdout.trim().split(/\s+/)[0];
    if (verified.code !== 0 || remoteSha !== sha) {
      throw new Error(`远端 SHA 复核失败: 本地 ${sha.slice(0, 12)},`
        + `远端 ${remoteSha ? remoteSha.slice(0, 12) : "缺失"}`);
    }
    return { branch: options.branch, sha, url: remoteUrl };
  } finally {
    view?.cleanup();
    sandbox.cleanup();
  }
}
