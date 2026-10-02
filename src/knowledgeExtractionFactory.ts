import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ComponentResearch, type ResearchRecord } from "./componentResearch.ts";
import { runComponentResearch } from "./componentResearchAgent.ts";
import { DomainKnowledgeExtraction } from "./domainKnowledgeExtraction.ts";
import { runDomainKnowledge, type DomainAgentOptions } from "./domainKnowledgeAgent.ts";
import { KnowledgeMrPublisher } from "./knowledgeMrPublisher.ts";
import { runKnowledgeCommand, KnowledgeProcessError } from "./knowledgeProcess.ts";
import { knowledgeGitFailure } from "./knowledgeProductionErrors.ts";
import type { DomainKnowledgeJob } from "./domainKnowledgeTypes.ts";

export type { ComponentResearch, DomainKnowledgeExtraction };

export function createDomainKnowledgeExtraction(options: DomainAgentOptions & ConstructorParameters<typeof KnowledgeMrPublisher>[0] & { onStopTimeout?: (job: DomainKnowledgeJob) => void }) {
  const publisher = new KnowledgeMrPublisher(options);
  return new DomainKnowledgeExtraction(options.dataDir, input => runDomainKnowledge(input, options), {
    previewCleanup: (...args) => publisher.previewCleanup(...args),
    publish: (...args) => publisher.publish(...args),
    refresh: (...args) => publisher.refresh(...args),
    readRemote: (...args) => publisher.readRemote(...args),
    shutdown: () => publisher.shutdown(),
    onStopTimeout: options.onStopTimeout,
  });
}

export function createComponentKnowledgeExtraction(options: Parameters<typeof runComponentResearch>[1] & { dataDir: string; onIndexed: () => void; onStopTimeout?: (record: ResearchRecord) => void; archiveFor?: ConstructorParameters<typeof ComponentResearch>[4] }) {
  return new ComponentResearch(options.dataDir, input => runComponentResearch(input, options), options.onIndexed, options.onStopTimeout, options.archiveFor);
}

async function knowledgeSourceCommand(args: string[], options: Omit<Parameters<typeof runKnowledgeCommand>[2], "timeoutMs" | "maxBytes">) {
  try { return (await runKnowledgeCommand("git", args, { ...options, timeoutMs: 90_000, maxBytes: 20 * 1024 * 1024 })).trim(); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw knowledgeGitFailure(error instanceof KnowledgeProcessError ? error.gitFailure ?? "unknown" : "unknown", "组件源码同步");
  }
}

export async function syncKnowledgeSource(root: string, repository: string, branch: string,
  sandbox: { args: string[]; env: NodeJS.ProcessEnv }, signal?: AbortSignal, baselineRevisions: string[] = []) {
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => knowledgeSourceCommand([...sandbox.args, ...args], { cwd: root, env: sandbox.env, signal });
  if (!existsSync(join(root, "HEAD"))) await git(["init", "--bare"]);
  await git(["config", "remote.origin.url", repository]);
  await git(["fetch", "--depth=1", "--no-tags", "origin", `refs/heads/${branch}`]);
  // 补旧 SHA 会改变 FETCH_HEAD，先固定本轮版本，不能把差异基线当成最新版本。
  const revision = await git(["rev-parse", "FETCH_HEAD^{commit}"]);
  const hasRevision = async (sha: string) => {
    try {
      await runKnowledgeCommand("git", [...sandbox.args, "cat-file", "-e", `${sha}^{commit}`], { cwd: root, env: sandbox.env, signal, timeoutMs: 90_000, maxBytes: 20 * 1024 * 1024 });
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof KnowledgeProcessError && typeof error.code === "number") return false;
      throw knowledgeGitFailure(error instanceof KnowledgeProcessError ? error.gitFailure ?? "unknown" : "unknown", "组件源码读取");
    }
  };
  for (const sha of new Set(baselineRevisions.filter(Boolean))) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) throw new Error(`基线版本 ${sha} 在源码仓中已不可得；基线不是完整的 Git 提交版本`);
    if (await hasRevision(sha)) continue;
    try {
      await git(["fetch", "--depth=1", "--no-tags", "origin", sha]);
      if (!await hasRevision(sha)) throw knowledgeGitFailure("not_found", "组件源码读取");
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new Error(`基线版本 ${sha} 在源码仓中已不可得；${error instanceof Error ? error.message : "旧版本读取失败"}`, { cause: error });
    }
  }
  return { root, revision };
}
