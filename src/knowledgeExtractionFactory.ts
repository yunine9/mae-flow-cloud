import { KnowledgeSourceCleanup } from "./knowledgeSourceCleanup.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ComponentResearch } from "./componentResearch.ts";
import { runComponentResearch } from "./componentResearchAgent.ts";
import { DomainKnowledgeExtraction } from "./domainKnowledgeExtraction.ts";
import { runDomainKnowledge, type DomainAgentOptions } from "./domainKnowledgeAgent.ts";
import { KnowledgeMrPublisher } from "./knowledgeMrPublisher.ts";
import { runKnowledgeCommand } from "./knowledgeProcess.ts";

export type { ComponentResearch, DomainKnowledgeExtraction };

export function createDomainKnowledgeExtraction(options: DomainAgentOptions & ConstructorParameters<typeof KnowledgeMrPublisher>[0]) {
  const publisher = new KnowledgeMrPublisher(options);
  return new DomainKnowledgeExtraction(options.dataDir, input => runDomainKnowledge(input, options), {
    sourceCleanup: new KnowledgeSourceCleanup(publisher),
    previewCleanup: (...args) => publisher.previewCleanup(...args),
    publish: (...args) => publisher.publish(...args),
    refresh: (...args) => publisher.refresh(...args),
    readRemote: (...args) => publisher.readRemote(...args),
  });
}

export function createComponentKnowledgeExtraction(options: Parameters<typeof runComponentResearch>[1] & { dataDir: string; onIndexed: () => void }) {
  return new ComponentResearch(options.dataDir, input => runComponentResearch(input, options), options.onIndexed);
}

async function knowledgeSourceCommand(args: string[], options: Omit<Parameters<typeof runKnowledgeCommand>[2], "timeoutMs" | "maxBytes">) {
  try { return (await runKnowledgeCommand("git", args, { ...options, timeoutMs: 90_000, maxBytes: 20 * 1024 * 1024 })).trim(); }
  catch { throw new Error("组件源码同步失败，请检查仓库、分支及个人或系统 Git 凭据"); }
}

export async function syncKnowledgeSource(root: string, repository: string, branch: string,
  sandbox: { args: string[]; env: NodeJS.ProcessEnv }, signal?: AbortSignal) {
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => knowledgeSourceCommand([...sandbox.args, ...args], { cwd: root, env: sandbox.env, signal });
  if (!existsSync(join(root, "HEAD"))) await git(["init", "--bare"]);
  await git(["fetch", "--depth=1", "--no-tags", repository, `refs/heads/${branch}`]);
  return { root, revision: await git(["rev-parse", "FETCH_HEAD^{commit}"]) };
}
