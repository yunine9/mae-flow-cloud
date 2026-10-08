/** 宿主唯一一次传输:从工作区经 safeGit 只读视图读对象,在临时 bare
 * 仓里 push 到显式远端,再 ls-remote 复核 SHA。分支名单由调用方
 * (单号门禁)先行校验,这里只管传输与复核的可靠性。
 *
 * force(同单重跑强制覆盖,2026-09-11 增补):不用裸 --force,而是先
 * ls-remote 探远端同名分支 tip,再 --force-with-lease=ref:tip 推——
 * 探测到推送之间远端又动了(他人/另一会话推送),租赁核对失败拒推,
 * 不会盲盖。远端还没有同名分支时无从覆盖,按普通推送走。 */
export async function pushFromIssueWorkspace(options: {
  dataDir: string;
  repoDir: string;
  repoUrl: string;
  branch: string;
  credential?: GitCredential;
  force?: boolean;
}): Promise<PushReceipt> {
  if (!existsSync(join(options.repoDir, ".git"))) {
    throw new Error(`代码克隆不存在: ${options.repoDir}`);
  }
  const remoteUrl = validateRepoUrl(options.repoUrl);
  const sandbox = prepareSandbox(options.dataDir, options.credential,
    options.repoDir);
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
    const probeRemoteTip = async (): Promise<string | undefined> => {
      const probed = await runGit([
        ...sandbox.args, `--git-dir=${staging}`,
        "ls-remote", "--heads", remoteUrl, ref,
      ], { env: sandbox.env, timeoutMs: 60_000 });
      const tip = probed.code === 0 ? probed.stdout.trim().split(/\s+/)[0] : "";
      return /^[0-9a-f]{40}$/i.test(tip) ? tip : undefined;
    };
    let forceLease: string[] = [];
    if (options.force === true) {
      const remoteTip = await probeRemoteTip();
      if (remoteTip) {
        forceLease = [`--force-with-lease=${ref}:${remoteTip}`];
      }
      // 远端还没有同名分支:无从覆盖,按普通推送走(不带租赁参数)。
    }
    const pushed = await runGit([
      ...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
      "--porcelain", ...forceLease, remoteUrl, `${sha}:${ref}`,
    ], { env: { ...sandbox.env, ...objectEnv }, timeoutMs: GIT_TRANSFER_TIMEOUT_MS });
    if (pushed.code !== 0) {
      // porcelain 的拒收摘要(! [rejected] (non-fast-forward))走 stdout,
      // 人话 hint 走 stderr——检测要两路合看,展示仍 stderr 优先。
      const stderrText = pushed.stderr.trim();
      const stdoutText = pushed.stdout.trim();
      const raw = stderrText || stdoutText;
      // 同单重跑撞远端遗留分支(2026-08-28 事故):分支名带单号,上次
      // 停止的运行推过同名分支,本地从基线另起必然非快进。光透 git
      // 原文等于让 AI 猜——点名原因与处置(2026-09-11 增补:处置从
      // "请用户去平台删远端分支"改为指路 force=true 重推,租赁式核对
      // 保证不盲盖;强制尝试被拒则提示核对远端,不教盲目重试)。
      const rejected = /non-fast-forward|fetch first|stale info|already exists|\[rejected\]|behind its remote counterpart/i
        .test(`${stderrText}\n${stdoutText}`);
      const staleBranch = !rejected ? "" : options.force === true
        ? " 强制覆盖被拒:远端分支状态与推送时不一致,或受平台分支保护"
          + "限制——先与用户核对远端分支状态再决定,不要盲目重试。"
        : " 远端同名分支已存在且非快进(常见于同单重跑:上次运行推过"
          + "该分支)——确认是本单遗留后带 force=true 重推即可覆盖"
          + "(该分支已有 MR 时覆盖后原 MR 随之更新,不要重复创建)。";
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
    return {
      branch: options.branch, sha, url: remoteUrl,
      ...(options.force === true ? { forced: true } : {}),
    };
  } finally {
    view?.cleanup();
    sandbox.cleanup();
  }
}
