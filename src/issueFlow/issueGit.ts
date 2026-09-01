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
  email?: string;
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
      // --no-local:本地路径仓默认 hardlink 共享 .git/objects,问题仓
      // 会与源仓共 inode(同 taskService 正式 clone 的教训)。
      ...sandbox.args, "clone", "--quiet", "--no-local",
      ...(options.baseline ? ["--branch", options.baseline] : []),
      "--", url, options.targetDir,
    ], { env: sandbox.env, timeoutMs: 30 * 60_000 });
    if (outcome.code !== 0) {
      throw new Error(cloneFailureMessage(options.credential, outcome.stderr));
    }
    await hardenCloneAsync(options.targetDir);
    // 署名(与 taskService 正式 clone 同款):repo 级 config 写入,
    // 容器内同路径可读——AI 在容器里 git commit 不再 "Author identity
    // unknown"。用户名缺省用凭据名,邮箱缺省按用户名兜底(与
    // taskService L12851-12854 同口径)。
    if (options.credential && existsSync(join(options.targetDir, ".git"))) {
      const name = options.credential.username;
      const email = options.credential.email
        ?? `${name.replace(/[^a-zA-Z0-9_.+-]/g, "-")}@localhost`;
      const configArgs = (...args: string[]) =>
        ["config", "--file", join(options.targetDir, ".git", "config"), ...args];
      await runGit(configArgs("--replace-all", "user.name", name),
        { env: sandbox.env, timeoutMs: 10_000 });
      await runGit(configArgs("--replace-all", "user.email", email),
        { env: sandbox.env, timeoutMs: 10_000 });
    }
  } finally {
    sandbox.cleanup();
  }
}

/** 远端是否已有同名修复分支且与本地分叉(同单重跑的上次遗留)。
 * 分支名烧死 master_工号_单号:上次运行(停止/取消)推过的话,新克隆
 * 会把它带成 origin/<branch>,而本地从基线另起同名分支——分叉要一路
 * 跑到 push 才以非快进炸掉。这里提前把事实挖出来:分叉返回远端短
 * SHA;远端没有、或远端是本地祖先(正常推进)返回 undefined。 */
export async function divergedRemoteBranch(
  repoDir: string,
  branch: string,
): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const remote = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    { cwd: repoDir, env, timeoutMs: 10_000 });
  if (remote.code !== 0) return undefined;
  const remoteSha = remote.stdout.trim();
  if (!remoteSha) return undefined;
  const ancestor = await runGit(
    ["merge-base", "--is-ancestor", remoteSha, "HEAD"],
    { cwd: repoDir, env, timeoutMs: 10_000 });
  // 远端是本地祖先 = 同会话已推送后的正常再确认,不是遗留。
  if (ancestor.code === 0) return undefined;
  return remoteSha.slice(0, 12);
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

/** 当前 HEAD 短 SHA(拉仓事实回报用;失败回空串由调用方如实呈现)。 */export async function currentHead(repoDir: string): Promise<string> {
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

/** 工作区未提交改动(含未跟踪文件),porcelain 逐行;干净返回空数组。
 * push 前的熔断依据:push 只推已提交历史,脏工作区推出去=旧 HEAD,
 * MR 没有 diff(2026-08-28 真实环境事故:AI 改了文件没 commit,
 * push_branch 推了 clone 时的原始提交)。status 本身失败按"没有证据"
 * 处理放行——属主修复后这是罕见路径,不值得为它堵死推送。 */
export async function dirtyWorktree(repoDir: string): Promise<string[]> {
  const view = createSafeGitView(repoDir);
  try {
    const outcome = await runGit(["status", "--porcelain"], {
      cwd: repoDir,
      env: view.environment(),
      timeoutMs: 10_000,
    });
    if (outcome.code !== 0) return [];
    return outcome.stdout.split("\n").map((line) => line.trim())
      .filter(Boolean);
  } finally {
    view.cleanup();
  }
}

/** 宿主侧确定性建分支(固定流程阶段2/转正时用)。分支名规范
 * master_工号_单号 由调用方拼好;这里只负责"分支已在且已检出"这个
 * 终态:已检出=幂等通过;分支存在未检出=切过去;不存在=从起点建。
 * 绝不 reset 已有分支——已有提交意味着有轮次在现场,覆盖是事故。
 * 隐式续跑陷阱(2026-08-28 事故):本地分支不存在而 origin/<branch>
 * 存在(同单重跑,上次运行推过)时,`git checkout <branch>` 会 DWIM
 * 成"从远端分支顶上建本地分支"——静默续跑被停掉的半成品。所以
 * 建分支必须先验本地引用,不存在就走显式 -b(起点明确,无 DWIM)。 */
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
    // 本地分支在不在(显式验引用,不能让 checkout 的 DWIM 替我们决定):
    // 在 → 只切换;不在 → 显式 -b 从起点建,绝不落在 origin/<branch> 上。
    const local = await runGit(
      [...sandbox.args, "show-ref", "--verify", "--quiet",
        `refs/heads/${options.branch}`],
      { cwd: options.repoDir, env: sandbox.env, timeoutMs: 10_000 });
    if (local.code === 0) {
      const checkout = await runGit([
        ...sandbox.args, "checkout", "--quiet", options.branch,
      ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
      if (checkout.code === 0) return;
      // 已存在但切换失败(如脏工作区冲突):原文带回去让人看。
      throw new Error(
        `切换分支失败(${options.branch}): ${checkout.stderr.trim().slice(0, 400)}`);
    }
    // 分支不存在:从起点(缺省 HEAD)建。已存在但切换失败(如脏工作
    // 区冲突)会走到这里再失败一次,原文带回去让人看。
    const create = await runGit([
      ...sandbox.args, "checkout", "--quiet", "-b", options.branch,
      ...(options.startPoint ? [options.startPoint] : []),
    ], { cwd: options.repoDir, env: sandbox.env, timeoutMs: 60_000 });
    if (create.code !== 0) {
      throw new Error(
        `建分支失败(${options.branch}): ${create.stderr.trim().slice(0, 400)}`);
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
      // porcelain 的拒收摘要(! [rejected] (non-fast-forward))走 stdout,
      // 人话 hint 走 stderr——检测要两路合看,展示仍 stderr 优先。
      const stderrText = pushed.stderr.trim();
      const stdoutText = pushed.stdout.trim();
      const raw = stderrText || stdoutText;
      // 同单重跑撞远端遗留分支(2026-08-28 事故):分支名带单号,上次
      // 停止的运行推过同名分支,本地从基线另起必然非快进。光透 git
      // 原文等于让 AI 猜——点名原因与处置。
      const staleBranch = /non-fast-forward|fetch first|stale info|already exists|\[rejected\]|behind its remote counterpart/i
        .test(`${stderrText}\n${stdoutText}`)
        ? " 远端同名分支已存在且非快进(常见于同单重跑:上次运行推过"
          + "该分支)——请与用户确认处置(在代码平台删除远端旧分支后"
          + "重推,或沿用旧分支),再重试。"
        : "";
      throw new Error(authFailureHint("推送代码", options.credential, raw)
        ?? `宿主推送失败: ${raw.slice(0, 500)}${staleBranch}`);
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

/** 推送过目闸的变更摘要(ADR-0009:服务端举闸时生成,不靠 Agent 自报
 * ——过目不是走过场,人看的是仓里的既成事实)。内容=当前分支相对
 * 基线的 diff --stat + 最近几条提交题。基线按候选逐个试(登记带的
 * baseline 优先,再退 master/main);全都不通就退化为提交题列表。
 * 摘要是给人过目的上下文,不是门禁事实——任何一步取不到都不 fail,
 * 空摘要的卡照样举:闸的作用是"停下等人",不是"读懂仓库"。 */
export async function pushChangeSummary(options: {
  repoDir: string;
  baseline?: string;
}): Promise<string> {
  const view = createSafeGitView(options.repoDir);
  try {
    const env = view.environment();
    const run = (args: string[]) => runGit(["--no-pager", ...args], {
      cwd: options.repoDir, env, timeoutMs: 10_000,
    });
    const log = await run(["log", "--format=%s", "-3"]);
    const subjects = log.code === 0
      ? log.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
    const subjectBlock = subjects.length
      ? `\n\n最近提交:\n${subjects.map((line) => `- ${line}`).join("\n")}`
      : "";
    const candidates = [
      ...(options.baseline
        ? [`origin/${options.baseline}`, options.baseline]
        : []),
      "origin/master", "master", "origin/main", "main",
    ];
    for (const candidate of candidates) {
      const diff = await run(
        ["diff", "--stat", "--no-color", `${candidate}...HEAD`]);
      if (diff.code !== 0) continue;
      const lines = diff.stdout.trim().split("\n").filter(Boolean);
      if (!lines.length) break; // 基线通了但无差异:没有 diff 可看,给提交题
      const stat = lines.slice(0, 40).join("\n")
        + (lines.length > 40 ? `\n…共 ${lines.length} 行` : "");
      return `变更摘要(相对 ${candidate}):\n${stat}${subjectBlock}`;
    }
    return subjectBlock || "(变更摘要不可得:仓里读不到基线差异与提交历史)";
  } finally {
    view.cleanup();
  }
}
