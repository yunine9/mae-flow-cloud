import { cleanupDocumentVersions, cleanupEntries, previewKnowledgeCleanup } from "./knowledgeCleanup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { gitCommitIdentityConfigs } from "./gitCommitIdentity.ts";
import { createMergeRequest, type MergeRequestCredential } from "./mrClient.ts";
import { fetchMrGates } from "./mrGateClient.ts";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { knowledgeIssueNumber, knowledgeRelativePath, type DomainKnowledgeJob, type DomainPublication, type KnowledgeRepository } from "./domainKnowledgeExtraction.ts";
import type { DomainDocument, DomainRemoteReview } from "./domainKnowledgeTypes.ts";

const markdown = (doc: { content: string; sources: string }, job: DomainKnowledgeJob) => job.component_research_id ? doc.content : `${doc.content.trimEnd()}\n\n## 来源\n\n${doc.sources.trim()}\n`;
export class KnowledgeMrPublisher {
  constructor(private options: {
    dataDir: string; platformUrl: () => string | undefined;
    credential: (operator: string) => (MergeRequestCredential & { email?: string }) | undefined;
    onIndexed: () => void;
  }) {}
  private identity(operator: string) {
    const credential = this.options.credential(operator), platformUrl = this.options.platformUrl();
    if (!credential?.username || !credential.password || !credential.email) throw new Error("请先配置个人 Git 账号、令牌和提交邮箱，归档不会使用系统只读凭据");
    if (!platformUrl) throw new Error("未配置 MR 平台服务");
    return { credential, platformUrl, headers: { "x-mfc-git-user": encodeURIComponent(credential.username), "x-mfc-git-token": encodeURIComponent(credential.password) } };
  }
  private async state(target: KnowledgeRepository, publication: DomainPublication, operator: string) {
    const { platformUrl, headers } = this.identity(operator);
    const view = await fetchMrGates({ platformUrl, headers, repo: target.repository, requireExisting: true,
      delivery: { source_branch: publication.branch, target_branch: target.branch, mr_id: publication.mr_id, mr_url: publication.url } });
    if (!view) throw new Error("暂时无法确认 MR 状态，请稍后重试，未创建重复 MR");
    return view.mrState;
  }
  private async withGit<T>(operator: string, work: (git: (args: string[], allowFailure?: boolean) => Promise<string>, root: string) => Promise<T>) {
    const identity = this.identity(operator), sandbox = new HostGitSandbox(this.options.dataDir), prepared = sandbox.prepare(identity.credential);
    const area = join(this.options.dataDir, "knowledge-publication-tmp"); mkdirSync(area, { recursive: true });
    const root = mkdtempSync(join(area, "publish-"));
    const git = async (args: string[], allowFailure = false) => {
      const env = { ...prepared.env };
      for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
      const result = await runGitProcess([...prepared.args, ...gitCommitIdentityConfigs(identity.credential).flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args], { cwd: root, env, timeoutMs: 90_000 });
      if (result.status !== 0 && !allowFailure) throw new Error("知识文档 Git 操作失败，请检查个人权限、分支和网络；未覆盖远端提交");
      return result.status === 0 ? result.stdout : "";
    };
    try { await git(["init", "--bare"]); return await work(git, root); }
    finally { sandbox.cleanup(prepared); rmSync(root, { recursive: true, force: true }); }
  }
  private async content(git: (args: string[]) => Promise<string>, revision: string, path: string) {
    knowledgeRelativePath(path, true);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = await git(["--literal-pathspecs", "ls-tree", revision, "--", segments.slice(0, i).join("/")]);
      if (parent && !parent.startsWith("040000 tree ")) throw new Error("文档父路径包含文件或软链接，未写入");
    }
    const entry = await git(["--literal-pathspecs", "ls-tree", revision, "--", path]);
    if (!entry) return null;
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error("文档路径不是普通文件，未写入");
    return git(["show", `${revision}:${path}`]);
  }
  async publish(job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string, save: (p: DomainPublication) => void): Promise<DomainPublication> {
    const issue = knowledgeIssueNumber(job.issue_no);
    const identity = this.identity(operator);
    if (previous?.mr_attempted && !previous.url) {
      const query = new URLSearchParams({ repo: target.repository, source_branch: previous.branch, target_branch: target.branch });
      const response = await fetch(`${identity.platformUrl.replace(/\/+$/, "")}/mr/discover?${query}`, { headers: identity.headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("上次 MR 创建结果不确定，当前无法查询原分支；请恢复 MR 查询服务后重试，未重复创建");
      const body = await response.json() as { mrs?: Array<{ id: string | number; url: string; source_branch: string; target_branch: string }> };
      if (!Array.isArray(body.mrs) || body.mrs.length > 1 || body.mrs.some(mr => mr.source_branch !== previous!.branch || mr.target_branch !== target.branch || !/^https?:\/\//.test(mr.url) || mr.id === undefined)) throw new Error("原分支 MR 查询结果不明确，未重复创建");
      if (body.mrs[0]) previous = { ...previous, url: body.mrs[0].url, mr_id: body.mrs[0].id };
    }
    const oldState = previous?.url ? await this.state(target, previous, operator) : previous?.state;
    if (oldState === "merged" && previous) {
      previous = await this.refresh(job, previous, operator); save(previous);
      if (previous.sync_state !== "done") throw new Error(previous.sync_error || "已合入文档尚未同步，请重试同步后继续更新");
    }
    const continueBranch = previous && !["merged", "closed", "unchanged"].includes(oldState ?? "");
    const branch = continueBranch ? previous!.branch : `codex/knowledge-${job.id}-${target.id}-${randomUUID().slice(0, 8)}`;
    const docs = job.documents.filter(d => d.selected && d.target_id === target.id);
    const requestedCleanup = (docs.length || job.cleanup_only) ? job.cleanup_plans?.find(p => p.target_id === target.id && p.confirmed) : undefined;
    const cleanup = requestedCleanup && (job.cleanup_only || ![...(job.publication_history ?? []), ...(previous ? [previous] : [])].some(p => p.cleanup_id === requestedCleanup.id)) ? requestedCleanup : undefined;
    if (cleanup && JSON.stringify(cleanup.document_versions) !== JSON.stringify(cleanupDocumentVersions(job, target.id))) throw new Error("提交文档已变化，请重新预览并确认清理范围");
    if (!cleanup && oldState === "merged" && previous && docs.length === previous.documents.length && docs.every(doc => previous!.documents.some(old => old.id === doc.id && old.content === markdown(doc, job)))) return { ...previous, state: "merged" };
    const publication: DomainPublication = { cleanup_id: previous?.cleanup_id, removed_paths: previous?.removed_paths, target_id: target.id, branch, state: "pending", ...(continueBranch ? { url: previous!.url, mr_id: previous!.mr_id, mr_attempted: previous!.mr_attempted } : {}),
      documents: docs.map(doc => ({ id: doc.id, path: doc.path, content: markdown(doc, job), revision: doc.revision, base_content: oldState === "merged" ? previous?.documents.find(d => d.id === doc.id)?.content ?? doc.base_content : previous?.documents.find(d => d.id === doc.id)?.base_content ?? doc.base_content })) };
    for (const doc of docs) {
      if (!knowledgeRelativePath(doc.path, true).startsWith(`${target.docs_path}/`)) throw new Error("归档文件超出指定目录");
      scanForSecrets(doc.path, Buffer.from(markdown(doc, job)));
    }
    // Keep the last confirmed push separate from the attempted content. A timeout may
    // happen before or after the server accepts a push; either known version is safe.
    const saveAttempt = () => save({ ...publication, documents: continueBranch ? previous!.documents : [], attempted_documents: publication.documents });
    saveAttempt();
    return this.withGit(operator, async (git, root) => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const targetSha = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      const remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${branch}`])).trim().split(/\s/)[0];
      let parent = targetSha;
      if (remote) {
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${branch}`]);
        parent = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      }
      if (cleanup) {
        const targetEntries = await cleanupEntries(git, targetSha, cleanup.directories, cleanup.agent?.path);
        if (JSON.stringify(targetEntries) !== JSON.stringify(cleanup.target_entries)) throw new Error("清理范围内的目标分支文件已变化，请重新预览确认");
        const currentEntries = await cleanupEntries(git, parent, cleanup.directories, cleanup.agent?.path);
        const expectedEntries = remote && cleanup.branch === branch ? cleanup.branch_entries ?? cleanup.target_entries : cleanup.target_entries;
        for (const entry of currentEntries) {
          const expected = expectedEntries.find(e => e.path === entry.path);
          if (expected?.oid === entry.oid && expected.mode === entry.mode) continue;
          const draft = docs.find(d => d.path === entry.path), generated = draft ? markdown(draft, job) : entry.path === cleanup.agent?.path ? cleanup.agent.content : undefined;
          if (generated !== undefined && await this.content(git, parent, entry.path) === generated) continue;
          throw new Error(`${entry.path} 在清理预览后已有修改，请重新核对，未删除`);
        }
        if (cleanup.agent) await this.content(git, parent, cleanup.agent.path);
      }
      const cleanupIncludes = (path: string) => !!cleanup && !cleanup.preserve_paths?.includes(path) && (cleanup.directories.some(dir => path === dir || path.startsWith(`${dir}/`)) || cleanup.agent?.path === path);
      for (const doc of docs) {
        const current = await this.content(git, parent, doc.path);
        const old = previous?.documents.find(d => d.id === doc.id);
        const attempted = previous?.attempted_documents?.find(d => d.id === doc.id);
        const review = doc.remote_review?.reviewed ? doc.remote_review : undefined;
        const expected = remote && review?.branch === branch ? review.branch_content : !remote && review ? review.target_content : remote || oldState === "merged" ? old ? old.content : doc.base_content : old?.base_content ?? doc.base_content;
        if (!cleanupIncludes(doc.path) && current !== expected && current !== attempted?.content && current !== markdown(doc, job)) throw new Error(`${doc.path} 已有他人修改，请先核对目标文档再更新，未覆盖原文`);
        const targetCurrent = await this.content(git, targetSha, doc.path);
        // An open MR must also be reviewed against target-branch edits since extraction.
        if (!cleanupIncludes(doc.path) && remote && targetCurrent !== (review ? review.target_content : doc.base_content) && targetCurrent !== old?.content && targetCurrent !== markdown(doc, job)) throw new Error(`${doc.path} 的目标分支已更新，请先处理文档冲突`);
      }
      const mergeBase = remote ? (await git(["merge-base", parent, targetSha])).trim() : targetSha;
      const mergeTarget = remote && mergeBase !== targetSha;
      // Integrate the reviewed target branch so resolving a document conflict also
      // resolves the MR's ancestry. Never resolve unrelated source conflicts here.
      if (mergeTarget) {
        await git(["read-tree", "-i", "-m", mergeBase, parent, targetSha]);
        const conflicts = (await git(["ls-files", "--unmerged", "-z"])).split("\0").filter(Boolean).map(row => row.slice(row.indexOf("\t") + 1));
        if (conflicts.some(path => !docs.some(d => d.path === path) && !cleanupIncludes(path))) throw new Error("MR 包含文档范围外的合并冲突，请由仓维护者先处理源码冲突");
      } else await git(["read-tree", parent]);
      const knownDocuments = [...(previous?.documents ?? []), ...(previous?.attempted_documents ?? [])];
      if (continueBranch && remote) for (const excluded of [...new Map(knownDocuments.map(d => [d.id, d])).values()].filter(old => !docs.some(doc => doc.id === old.id))) {
        const current = await this.content(git, parent, excluded.path);
        const original = await this.content(git, targetSha, excluded.path);
        if (current !== original && !knownDocuments.some(d => d.id === excluded.id && d.content === current)) throw new Error(`${excluded.path} 已有他人修改，不能自动撤回归档`);
        if (original === null) await git(["--work-tree", root, "update-index", "--force-remove", "--", excluded.path]);
        else { const file = join(root, "knowledge-content.tmp"); writeFileSync(file, original, { mode: 0o600 }); const blob = (await git(["hash-object", "-w", file])).trim(); await git(["update-index", "--add", "--cacheinfo", "100644", blob, excluded.path]); }
      }
      if (cleanup) {
        const removed = [...new Set([...cleanup.target_entries, ...(cleanup.branch_entries ?? [])].map(e => e.path))]
          .filter(path => !cleanup.preserve_paths?.includes(path));
        for (const path of removed) await git(["--work-tree", root, "update-index", "--force-remove", "--", path]);
        publication.removed_paths = removed.filter(path => !docs.some(doc => doc.path === path) && path !== cleanup.agent?.path);
        if (cleanup.agent && !cleanup.preserve_paths?.includes(cleanup.agent.path)) {
          const file = join(root, "knowledge-agent.tmp"); writeFileSync(file, cleanup.agent.content, { mode: 0o600 });
          const blob = (await git(["hash-object", "-w", file])).trim();
          await git(["update-index", "--add", "--cacheinfo", "100644", blob, cleanup.agent.path]);
        }
      }
      for (const doc of publication.documents) {
        const file = join(root, "knowledge-content.tmp"); writeFileSync(file, doc.content, { mode: 0o600 });
        const blob = (await git(["hash-object", "-w", file])).trim();
        await git(["update-index", "--add", "--cacheinfo", "100644", blob, doc.path]);
      }
      const tree = (await git(["write-tree"])).trim(), before = (await git(["rev-parse", `${parent}^{tree}`])).trim();
      if (!remote && tree === before) { publication.cleanup_id = cleanup?.id ?? publication.cleanup_id; publication.state = "unchanged"; publication.revision = parent; const result = await this.refresh(job, publication, operator); save(result); return result; }
      const sha = tree === before && !mergeTarget ? parent : (await git(["commit-tree", tree, "-p", parent, ...(mergeTarget ? ["-p", targetSha] : []), "-m", job.cleanup_only ? `docs(${issue}): 清理萃取前旧知识` : `docs: 更新${job.title}知识`])).trim();
      publication.revision = sha; saveAttempt();
      if (sha !== remote) await git(["push", target.repository, `${sha}:refs/heads/${branch}`]);
      publication.cleanup_id = cleanup?.id ?? publication.cleanup_id;
      save(publication);
      if (!publication.url) {
        // The adapter deduplicates by repository and source/target branches.
        publication.mr_attempted = true; save(publication);
        let receipt;
        try { receipt = await createMergeRequest({ platformUrl: identity.platformUrl, repo: target.repository, sourceBranch: branch, targetBranch: target.branch, title: job.cleanup_only ? `知识清理：${issue} · ${target.name}` : `知识库：${job.title}`, credential: identity.credential, dtsNo: issue, purpose: "knowledge" }); }
        catch { throw new Error("文档已推送，MR 创建尚未确认；重试将复用同一分支"); }
        if (!/^https?:\/\//.test(receipt.url)) throw new Error("MR 链接无效，请恢复平台查询后重试");
        publication.url = receipt.url; publication.mr_id = receipt.id;
      }
      publication.state = "opened"; save(publication); return publication;
    });
  }
  async refresh(job: DomainKnowledgeJob, publication: DomainPublication, operator: string): Promise<DomainPublication> {
    const target = [job.knowledge_target, ...job.repositories].find(r => r.id === publication.target_id)!;
    const state = publication.state === "unchanged" ? "unchanged" : await this.state(target, publication, operator), result: DomainPublication = { ...publication, state, error: undefined };
    if (state !== "merged" && state !== "unchanged") return result;
    result.sync_state = "pending"; result.sync_error = undefined;
    try { await this.withGit(operator, async git => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const revision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      for (const saved of publication.documents) {
        const content = await this.content(git, revision, saved.path);
        if (content === null) throw new Error(`${saved.path} 不在当前目标分支中，未标记为已入库`);
        scanForSecrets(saved.path, Buffer.from(content));
        const doc = job.documents.find(d => d.id === saved.id)!;
        const previous = listKnowledgeDocuments(this.options.dataDir).find(d => d.source?.repository === target.repository && d.source.branch === target.branch && d.source.path === saved.path)
          ?? (job.component_research_id ? listKnowledgeDocuments(this.options.dataDir).find(d => !d.source && d.research_source?.job_id === job.component_research_id) : undefined);
        if (previous?.content === content && previous.source?.revision === revision) continue;
        saveKnowledgeDocument(this.options.dataDir, { ...previous, title: doc.title, content, scope: previous?.scope ?? (job.component_research_id ? "platform" : target.id === "domain" && job.module_id ? "module" : "repository"), module_ids: previous?.module_ids ?? (target.id === "domain" && job.module_id ? [job.module_id] : []),
          repositories: previous?.repositories ?? (target.id === "domain" && job.repositories.length ? job.repositories.map(r => r.repository) : [target.repository]), source: { repository: target.repository, branch: target.branch, path: saved.path, revision }, active: previous?.active ?? true,
          technologies: previous?.technologies ?? job.technologies,
          research_source: { job_id: job.component_research_id ?? job.id, repository: target.repository, branch: target.branch, path: saved.path, revision } }, operator, previous?.id, job.component_research_id ? { maxContentBytes: 16 * 1024 * 1024 } : {});
      }
      for (const path of publication.removed_paths ?? []) {
        if ((await cleanupEntries(git, revision, [path])).length) continue;
        for (const old of listKnowledgeDocuments(this.options.dataDir).filter(d => d.active && d.source?.repository === target.repository && d.source.branch === target.branch && d.source.path === path)) saveKnowledgeDocument(this.options.dataDir, { ...old, active: false }, operator, old.id);
      }
      this.options.onIndexed();
    }); result.sync_state = "done"; }
    catch (error) { result.sync_state = "failed"; result.sync_error = error instanceof Error ? error.message : "已合入，知识文档同步失败"; }
    return result;
  }
  async previewCleanup(job: DomainKnowledgeJob, target: KnowledgeRepository, input: unknown, operator: string) {
    const publication = job.publications.find(p => p.target_id === target.id);
    const state = publication?.url ? await this.state(target, publication, operator) : undefined;
    return this.withGit(operator, async git => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const targetRevision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      let branch: { name: string; revision: string } | undefined;
      if (publication && !["merged", "closed", "unchanged"].includes(state ?? publication.state) && (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim()) {
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
        branch = { name: publication.branch, revision: (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim() };
      }
      return previewKnowledgeCleanup(git, job, target, input, targetRevision, branch);
    });
  }
  async readRemote(job: DomainKnowledgeJob, doc: DomainDocument, operator: string): Promise<DomainRemoteReview> {
    const target = [job.knowledge_target, ...job.repositories].find(r => r.id === doc.target_id)!;
    const publication = job.publications.find(p => p.target_id === target.id);
    const state = publication?.url ? await this.state(target, publication, operator) : undefined;
    return this.withGit(operator, async git => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const target_revision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      const result: DomainRemoteReview = { id: randomUUID(), target_revision, target_content: await this.content(git, target_revision, doc.path), reviewed: false };
      if (publication && state !== "merged" && state !== "closed" && (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim()) {
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
        result.branch = publication.branch; result.branch_revision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
        result.branch_content = await this.content(git, result.branch_revision, doc.path);
      }
      scanForSecrets("远端知识文档", Buffer.from(JSON.stringify(result)));
      return result;
    });
  }
}
