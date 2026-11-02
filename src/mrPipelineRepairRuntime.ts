import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CloudSession } from "./sessionDriver.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import { createPrePushGateContract, parsePrePushAgentReport, prePushMission, verifyPrePushEvidence } from "./prepushAgent.ts";
import { TaskContainer, taskContainerInstance, type TaskContainerLimits, type TaskContainerOptions } from "./containerRuntime.ts";
import { prepareContainerHostPaths } from "./containerOwnership.ts";
import { perRepoBuildCacheMounts } from "./buildCacheMounts.ts";
import { isMaeRepository, maeBuildVolumes, prepareMaeBuildSupport, MAE_BUILD_ASSETS, MAE_BUILD_MOUNT } from "./maeBuildSupport.ts";
import { createContainerBashOperations } from "./issueFlow/containerBash.ts";
import { cloneRepository, currentBranch, dirtyWorktree, hardenCloneAsync, prepareSandbox,
  pushFromIssueWorkspace, type GitCredential } from "./issueFlow/issueGit.ts";
import { applyGitCommitIdentity, GIT_COMMIT_IDENTITY_GUIDANCE } from "./gitCommitIdentity.ts";
import { createSafeGitView } from "./safeGit.ts";
import { getPipelineStatus, pipelineHeaders, triggerPipeline } from "./pipelineClient.ts";
import { isBlindPipelineInput, mirrorPipelineArtifacts } from "./pipelineMirror.ts";
import { resolveModelConfig, type DeploymentModels, type ModelSettingsSource } from "./modelResolution.ts";
import { parseRepairMr, type RepairMr } from "./mrPipelineRepairTypes.ts";
import type { PipelineRepairRuntime } from "./mrPipelineRepair.ts";

export interface RepairIsolation extends TaskContainerLimits {
  image: string;
  volumes: string[];
  cacheRoot?: string;
  network?: string;
  environment?: NodeJS.ProcessEnv;
}

/** 执行身份、凭据和状态文件留在宿主，Agent 只进入独立代码容器。 */
export function createPipelineRepairRuntime(options: {
  dataDir: string;
  platformUrl?: string;
  isolation?: RepairIsolation;
  deployment: DeploymentModels;
  settings?: ModelSettingsSource;
  credential: (account: string) => GitCredential | undefined;
  log?: (text: string) => void;
  createSession?: typeof CloudSession.create;
  createContainer?: (image: string, workspace: string, name: string, log: ((text: string) => void) | undefined,
    volumes: string[], limits: TaskContainerLimits, runtime: TaskContainerOptions) => Pick<TaskContainer, "start" | "exec" | "stop">;
}): PipelineRepairRuntime {
  const platformUrl = options.platformUrl?.replace(/\/+$/, "");
  const call = (mr: RepairMr, account: string) => ({ platformUrl: platformUrl!, repo: mr.repo,
    mr: mr.iid, sha: mr.sha, credential: options.credential(account) });
  return {
    unavailableReason: () => !platformUrl ? "尚未配置交付平台，请联系管理员配置后使用流水线修复"
      : !options.isolation ? "尚未配置代码执行容器，请联系管理员配置后使用流水线修复" : undefined,
    detail: async (url, account, signal) => {
      const response = await fetch(`${platformUrl}/mr/detail?mr_url=${encodeURIComponent(url)}`, {
        headers: pipelineHeaders(options.credential(account)), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error(response.status === 404
        ? "交付平台尚未支持 MR 详情查询，请联系管理员更新配置"
        : `读取 MR 详情失败（HTTP ${response.status}），请核对个人 Git 令牌与 MR 权限`);
      return parseRepairMr(await response.json(), url);
    },
    status: (mr, account, signal) => { signal.throwIfAborted(); return getPipelineStatus(call(mr, account)); },
    trigger: (mr, account, signal) => { signal.throwIfAborted(); return triggerPipeline(call(mr, account)); },
    open: async (record, root, signal, note) => {
      const mr = record.mr!;
      const workspace = resolve(root, "workspace"), repo = join(workspace, "repo"), evidence = join(workspace, "pipeline");
      mkdirSync(workspace, { recursive: true }); mkdirSync(evidence, { recursive: true });
      const credential = options.credential(record.account);
      if (!credential?.email) throw new Error("请先在个人设置中配置 Git 令牌和提交邮箱");
      const sandbox = prepareSandbox(options.dataDir, undefined, repo);
      const git = async (args: string[]) => {
        const view = createSafeGitView(repo);
        try { return (await promisify(execFile)("git", [...sandbox.args, ...args], {
          cwd: repo, env: view.environment(sandbox.env), timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        })).stdout.trim(); } finally { view.cleanup(); }
      };
      let container: Pick<TaskContainer, "start" | "exec" | "stop"> | undefined;
      try {
        signal.throwIfAborted();
        for (const branch of [mr.source_branch, mr.target_branch]) await promisify(execFile)("git", ["check-ref-format", "--branch", branch], { timeout: 10_000 });
        if (!existsSync(join(repo, ".git"))) {
          if (existsSync(repo)) throw new Error("保留的代码目录不含有效 Git 仓库，请管理员检查，未删除原有内容");
          const temporary = join(workspace, `clone-${randomUUID()}`);
          try {
            note("正在克隆 MR 的源分支");
            await cloneRepository({ dataDir: options.dataDir, targetDir: temporary, repoUrl: mr.repo,
              baseline: mr.source_branch, credential });
            signal.throwIfAborted(); renameSync(temporary, repo);
          } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
        }
        if (await currentBranch(repo) !== mr.source_branch) throw new Error("保留工作区的分支与 MR 源分支不同，已保留现场并停止");
        await git(["merge-base", "--is-ancestor", mr.sha, "HEAD"]).catch(() => { throw new Error("远端分支已变化，保留工作区不包含当前 MR 提交，请人工核对"); });
        await hardenCloneAsync(repo); await applyGitCommitIdentity(repo, credential);
        mkdirSync(join(repo, ".mae-flow-work"), { recursive: true });
        appendFileSync(join(repo, ".git", "info", "exclude"), "\n/.mae-flow-work/\n");
        const isolation = options.isolation!;
        let buildVolumes: string[] = [];
        const buildEnvironment: NodeJS.ProcessEnv = {};
        if (isMaeRepository(mr.repo)) {
          note("正在准备已有的 MAE 构建资源");
          await prepareMaeBuildSupport({ root: workspace, workspace: repo, dataDir: options.dataDir,
            repositories: [mr.repo], user: isolation.user, log: note,
            clone: async (repoUrl, targetDir, baseline) => {
              signal.throwIfAborted();
              await cloneRepository({ dataDir: options.dataDir, repoUrl, targetDir, baseline, shallow: true, credential });
            } });
          buildVolumes = maeBuildVolumes(workspace, repo);
          buildEnvironment.MFC_MAE_BUILD_ROOT = workspace;
          buildEnvironment.MFC_MAE_BASELINE = mr.target_branch;
        }
        const mounts = perRepoBuildCacheMounts({ cacheRoot: isolation.cacheRoot, cacheKeySource: mr.repo,
          volumes: [...isolation.volumes, ...buildVolumes], seedEnvironment: { ...isolation.environment, ...buildEnvironment },
          cppSdkDestination: join(workspace, "cpp_sdk_repository"), ccacheBaseDirSource: workspace });
        const volumes = [...mounts.volumes, `${MAE_BUILD_ASSETS}:${MAE_BUILD_MOUNT}:ro`, `${evidence}:${evidence}:ro`];
        prepareContainerHostPaths({ workspace, volumes, user: isolation.user, cacheRoot: isolation.cacheRoot,
          markerRoot: join(options.dataDir, ".runtime", "container-ownership"), log: options.log });
        const instance = taskContainerInstance(options.dataDir);
        const containerOptions: TaskContainerOptions = { network: isolation.network, environment: mounts.environment,
          labels: { "com.mae-flow-cloud.instance": instance.fingerprint,
            "com.mae-flow-cloud.role": "pipeline-repair", "com.mae-flow-cloud.task": record.id } };
        const create = options.createContainer ?? ((...args: ConstructorParameters<typeof TaskContainer>) => new TaskContainer(...args));
        container = create(isolation.image, workspace, `mfc-${instance.namePrefix}-${record.id}`, options.log,
          volumes, { memory: isolation.memory, cpus: isolation.cpus, user: isolation.user, pidsLimit: isolation.pidsLimit }, containerOptions);
        await container.start(); signal.throwIfAborted();
        return {
          repair: async (run, round) => {
            signal.throwIfAborted();
            const files = await mirrorPipelineArtifacts({ platformUrl: platformUrl!, repo: mr.repo, sha: mr.sha,
              mrUrl: mr.url, dir: evidence, headers: pipelineHeaders(options.credential(record.account)), log: note,
              current: () => !signal.aborted });
            signal.throwIfAborted();
            const detail = (run.checks ?? []).flatMap(c => (c.details ?? []).map(d => `${c.dimension}: ${d.file ?? ""}:${d.line ?? ""} ${d.message}`)).join("\n");
            const failure = [run.log, detail].filter(Boolean).join("\n");
            if (!files.length && (!failure.trim() || isBlindPipelineInput(failure, false))) throw new Error("平台没有提供可定位的失败日志，已停止，请补齐失败材料后重试");
            const dir = join(root, "sessions", randomUUID()), agentDir = join(dir, "pi-agent");
            mkdirSync(agentDir, { recursive: true, mode: 0o700 });
            const model = resolveModelConfig({ settings: options.settings, deployment: options.deployment,
              operator: record.account, log: options.log });
            if (!model.provider || !model.model) throw new Error("尚未配置可用的主模型，请联系管理员");
            writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), { mode: 0o600 });
            const events = new EventLog(join(dir, "events.jsonl"), event => {
              if (event.kind === "assistant_message") note(String(event.payload.text ?? "").slice(0, 2000));
              if (event.kind === "tool_requested") {
                const input = event.payload.input as { command?: string } | undefined;
                note(`正在执行：${input?.command ?? String(event.payload.name ?? "命令")}`);
              }
            });
            const driver = await (options.createSession ?? CloudSession.create)({ taskId: record.id, workspace: repo, agentDir,
              provider: model.provider, model: model.model, eventLog: events,
              transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"),
              gate: new GateService({ workspace: repo, cwd: repo, failClosed: true, contract: createPrePushGateContract() }),
              humanGate: new HumanGate(join(dir, "waiting.json")), allowHumanQuestions: false, allowSubagents: false,
              allowedTools: ["bash"], excludeAgentFiles: true,
              bashOperations: createContainerBashOperations(() => container), currentStep: () => "MR 流水线修复" });
            const abort = () => { void driver.abort().catch(error => options.log?.(`[pipeline-repair] abort: ${String(error)}`)); };
            signal.addEventListener("abort", abort, { once: true });
            try {
              signal.throwIfAborted();
              const prompt = prePushMission({ taskId: record.id, workspace: repo, sha: mr.sha, round,
                requirement: "仅修复这个 MR 的流水线失败，不处理检视意见、不改变业务需求。", branch: mr.source_branch, baseline: mr.target_branch })
                + `\n\n${GIT_COMMIT_IDENTITY_GUIDANCE}\n`
                + `本次 MR：${mr.url}。目标分支：${mr.target_branch}。失败日志全文目录：${evidence}（只读）。\n`
                + "先读取仓库已有构建指引和失败原文。首次先准备依赖并执行仓库标准的完整构建入口；后续修改在同一工作区重跑同一命令以复用增量缓存，环境或构建配置变化时按仓库规则完整重建。\n"
                + "修复范围包含本次编译、测试与代码质量错误。不得跳过测试、关闭检查或修改流水线规则来制造通过。不要覆盖或丢弃保留工作区里的未提交修改，先核对其用途并继续完成。\n"
                + "验证通过后仅按明确路径提交本次修复，保留既有提交历史。不能自行 push、创建 MR、回复检视意见或合入。无法解决时如实返回基础设施或代码失败。\n"
                + `平台失败原文：\n${failure.slice(0, 24_000)}`;
              const outcome = await driver.start(prompt);
              signal.throwIfAborted();
              const report = parsePrePushAgentReport(driver.finalReply());
              if (outcome.status !== "turn_finished" || !report) throw new Error("修复会话未完成本地验证报告，工作区保留，可重试继续");
              if (report.status !== "passed") throw new Error(report.summary);
              const missing = verifyPrePushEvidence(events.replay(), report);
              if (missing) throw new Error(missing);
              if ((await dirtyWorktree(repo)).length) throw new Error("本地仍有未提交修改，已保留工作区并停止推送，请查看修复记录");
              await git(["merge-base", "--is-ancestor", mr.sha, "HEAD"]);
              if (await currentBranch(repo) !== mr.source_branch) throw new Error("修复后工作区分支已变化，已停止推送");
              return { sha: await git(["rev-parse", "HEAD"]), summary: report.summary };
            } finally { signal.removeEventListener("abort", abort); driver.dispose(); }
          },
          push: async () => {
            signal.throwIfAborted();
            return (await pushFromIssueWorkspace({ dataDir: options.dataDir, repoDir: repo,
              repoUrl: mr.repo, branch: mr.source_branch, credential: options.credential(record.account) })).sha;
          },
          close: async () => { try { await container?.stop(); } finally { sandbox.cleanup(); } },
        };
      } catch (error) { try { await container?.stop(); } finally { sandbox.cleanup(); } throw error; }
    },
  };
}
