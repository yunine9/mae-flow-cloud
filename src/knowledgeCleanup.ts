import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { knowledgeRelativePath } from "./domainKnowledgeExtraction.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import type { DomainKnowledgeJob, KnowledgeCleanupPlan, KnowledgeRepository } from "./domainKnowledgeTypes.ts";

export type CleanupGit = (args: string[], allowFailure?: boolean) => Promise<string>;
export function cleanupDocumentVersions(job: DomainKnowledgeJob, targetId: string) {
  return job.documents.filter(d => d.selected && d.target_id === targetId).map(d => `${d.id}:${d.revision}:${d.path}`).sort();
}
export function cleanupOptions(input: any) {
  const paths = input.paths ?? input.directories;
  if (!Array.isArray(paths) || paths.length > 20) throw new Error("最多指定 20 个待删除路径");
  const directories = [...new Set(paths.map((path: unknown) => knowledgeRelativePath(path)))] as string[];
  let agent: { path: string; content: string } | undefined;
  if (input.agent) {
    const path = knowledgeRelativePath(input.agent.path, true);
    if (!/^agents?\.md$/i.test(posix.basename(path))) throw new Error("规范文件请选择 AGENTS.md 或 agent.md");
    const content = String(input.agent.content ?? "");
    if (!content.trim() || Buffer.byteLength(content) > 256 * 1024) throw new Error("请提供新规范正文，最多 256 KiB");
    scanForSecrets(path, Buffer.from(content)); agent = { path, content };
  }
  if (!directories.length && !agent) throw new Error("请指定待删除的目录或文件");
  return { directories, agent };
}
export function generatedAgentRules(job: DomainKnowledgeJob, target: KnowledgeRepository, agentPath: string) {
  const links = job.documents.filter(d => d.selected && d.target_id === target.id)
    .map(d => `- [${d.title.replace(/[\[\]\\\n]/g, "")}](<${posix.relative(posix.dirname(agentPath), d.path)}>)`).join("\n");
  return `# 项目知识使用规范\n\n## 知识文档\n\n修改相关功能前，先阅读与本次任务有关的知识文档，并核对当前代码和接口。\n\n${links}\n\n## 使用与维护\n\n- 文档中的结论应能追溯到代码、接口或业务资料；证据不足时明确说明，不自行补造。\n- 文档与当前实现不一致时，说明差异并核对，再提出修订建议。\n- 修改业务行为或组件用法时，同步检查对应知识文档是否需要更新。\n- 知识文档的新增、修订和清理通过 MR 审查，不直接覆盖目标分支。\n- 不把凭据、令牌或其他敏感信息写进文档。\n`;
}
export async function cleanupEntries(git: CleanupGit, revision: string, directories: string[], agentPath?: string) {
  const paths = [...directories, ...(agentPath ? [agentPath] : [])];
  const output = paths.length ? await git(["--literal-pathspecs", "ls-tree", "-r", "-z", revision, "--", ...paths]) : "";
  const entries = output.split("\0").filter(Boolean).map(row => {
    const index = row.indexOf("\t"), [mode, , oid] = row.slice(0, index).split(" ");
    return { path: row.slice(index + 1), mode, oid };
  });
  if (entries.length > 1000) throw new Error("清理范围超过 1000 个文件，请缩小目录范围");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export async function previewKnowledgeCleanup(git: CleanupGit, job: DomainKnowledgeJob, target: KnowledgeRepository, input: any, targetRevision: string, branch?: { name: string; revision: string }): Promise<KnowledgeCleanupPlan> {
  const { directories, agent } = cleanupOptions(input);
  if (agent && job.documents.some(d => d.target_id === target.id && d.path === agent.path)) throw new Error("规范文件不能与知识文档使用同一路径");
  for (const directory of directories) {
    for (const revision of [targetRevision, ...(branch ? [branch.revision] : [])]) {
      const entry = await git(["--literal-pathspecs", "ls-tree", revision, "--", directory]);
      if (entry && !/^(040000 tree|100644 blob|100755 blob|120000 blob) /.test(entry)) throw new Error(`${directory} 不是可清理的目录或文件`);
    }
  }
  const target_entries = await cleanupEntries(git, targetRevision, directories, agent?.path);
  const branch_entries = branch ? await cleanupEntries(git, branch.revision, directories, agent?.path) : undefined;
  if (new Set([...target_entries, ...(branch_entries ?? [])].map(entry => entry.path)).size > 1000) throw new Error("清理范围超过 1000 个文件，请缩小目录范围");
  const readAgent = async (revision: string, entries: typeof target_entries) => {
    const entry = entries.find(e => e.path === agent?.path);
    if (!entry) return null;
    if (!/^100(644|755)$/.test(entry.mode)) throw new Error("规范文件不是普通文件，不能自动替换");
    const content = await git(["show", `${revision}:${agent!.path}`]);
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error("旧规范文件过大，请缩小处理范围");
    scanForSecrets(agent!.path, Buffer.from(content)); return content;
  };
  return { id: randomUUID(), target_id: target.id, directories, target_revision: targetRevision, target_entries,
    ...(branch ? { branch: branch.name, branch_entries } : {}),
    ...(agent ? { agent: { ...agent, target_content: await readAgent(targetRevision, target_entries), branch_content: branch ? await readAgent(branch.revision, branch_entries!) : undefined } } : {}),
    document_versions: cleanupDocumentVersions(job, target.id), confirmed: false };
}
