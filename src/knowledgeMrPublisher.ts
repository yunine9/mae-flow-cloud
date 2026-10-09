import { componentArchiveParts } from "./componentKnowledgeArchiveFormat.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { gitCommitIdentityConfigs } from "./gitCommitIdentity.ts";
import { deliveryBranchName } from "./deliveryBranchName.ts";
import { cloudCommitSubject, commitHookRejection, rejectedCommitSha } from "./commitPolicy.ts";
import { createMergeRequest, type MergeRequestCredential } from "./mrClient.ts";
import { readMrFailureBody } from "./mrGateClient.ts";
import { classifyKnowledgeGitFailure, knowledgeGitFailure, knowledgeHttpFailure, knowledgeMrFailure } from "./knowledgeProductionErrors.ts";
import { readKnowledgeDocumentVersion } from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { knowledgeIssueDescription, knowledgeIssueNumber, knowledgeRelativePath, type DomainKnowledgeJob, type DomainPublication, type KnowledgeRepository } from "./domainKnowledgeExtraction.ts";
import type { DomainDocument, KnowledgeCleanupPlan, KnowledgeCleanupPublication } from "./domainKnowledgeTypes.ts";

export class KnowledgeMrPublisher {
  private stopped = false;
  private active = new Map<AbortController, Promise<unknown>>();
  constructor(private options: {
    dataDir: string; platformUrl: () => string | undefined;
    credential: (operator: string) => (MergeRequestCredential & { email?: string }) | undefined;
  }) {
    // kill -9 不执行 finally。知识归档的仓和凭据放在同一个专用根，
    // 起服清扫只处理这个根，不能误删问题流或需求交付正在用的 Git 凭据。
    const area = this.temporaryRoot();
    for (const name of readdirSync(area).filter(name => name.startsWith("publish-"))) rmSync(join(area, name), { recursive: true, force: true });
  }
  private temporaryRoot() {
    const area = join(this.options.dataDir, "knowledge-publication-tmp");
    if (existsSync(area) && (!lstatSync(area).isDirectory() || lstatSync(area).isSymbolicLink())) throw new Error("知识归档临时目录不是可信普通目录");
    mkdirSync(area, { recursive: true, mode: 0o700 });
    return area;
  }
  private assertActive(signal?: AbortSignal) { signal?.throwIfAborted(); if (this.stopped) throw new Error("知识归档服务已停止"); }
  async shutdown() {
    this.stopped = true;
    for (const controller of this.active.keys()) controller.abort(new Error("知识归档服务已停止"));
    if (!this.active.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.active.values()]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("知识归档关停超时：Git 操作 60 秒内未退出")), 60_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private identity(operator: string) {
    const credential = this.options.credential(operator), platformUrl = this.options.platformUrl();
    if (!credential?.username || !credential.password || !credential.email) throw new Error("请先配置个人 Git 账号、令牌和提交邮箱，归档不会使用系统只读凭据");
    if (!platformUrl) throw new Error("未配置 MR 平台服务");
    return { credential, platformUrl, headers: { "x-mfc-git-user": encodeURIComponent(credential.username), "x-mfc-git-token": encodeURIComponent(credential.password) } };
  }
  private async withGit<T>(operator: string, work: (git: (args: string[], allowFailure?: boolean) => Promise<string>, root: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    this.assertActive(signal);
    const identity = this.identity(operator), controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const root = mkdtempSync(join(this.temporaryRoot(), "publish-")), sandbox = new HostGitSandbox(root);
    const operation = (async () => {
      let prepared: ReturnType<HostGitSandbox["prepare"]> | undefined;
      try {
        prepared = sandbox.prepare(identity.credential);
        const git = async (args: string[], allowFailure = false) => {
          operationSignal.throwIfAborted(); this.assertActive(signal);
          const env = { ...prepared!.env };
          for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
          const result = await runGitProcess([...prepared!.args, ...gitCommitIdentityConfigs(identity.credential).flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args], { cwd: root, env, timeoutMs: 90_000, signal: operationSignal });
          operationSignal.throwIfAborted(); this.assertActive(signal);
          if (result.status !== 0 && !allowFailure) {
            const output = `${result.stderr}\n${result.stdout}`;
            if (commitHookRejection(output)) {
              const sha = rejectedCommitSha(output);
              throw new Error(`CodeHub 拒绝推送：提交说明不符合仓库规范${sha ? `（提交 ${sha.slice(0, 12)}）` : ""}，请检查仓库提交格式要求`);
            }
            throw knowledgeGitFailure(result.timedOut ? "network" : classifyKnowledgeGitFailure(output), "知识文档");
          }
          return result.status === 0 ? result.stdout : "";
        };
        await git(["init", "--bare"]);
        const result = await work(git, root, operationSignal);
        operationSignal.throwIfAborted(); this.assertActive(signal);
        return result;
      } finally {
        sandbox.cleanup(prepared);
        rmSync(root, { recursive: true, force: true });
      }
    })();
    this.active.set(controller, operation);
    try { return await operation; }
    finally { this.active.delete(controller); }
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
  private cleanupPaths(paths: unknown, limit = 20): string[] {
    if (!Array.isArray(paths) || paths.length > limit || paths.some(path => typeof path !== "string")) throw new Error(`每仓最多选择 ${limit} 条清理目录或文件路径`);
    return [...new Set(paths.map(path => knowledgeRelativePath(path)))].sort();
  }
  private async cleanupEntries(git: (args: string[]) => Promise<string>, revision: string, paths: string[]) {
    if (!paths.length) return [];
    const result = await git(["--literal-pathspecs", "ls-tree", "-r", "-z", revision, "--", ...paths]);
    const entries = result.split("\0").filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match || match[2] !== "blob") throw new Error("清理范围包含子模块，请移除该路径");
      const path = knowledgeRelativePath(match[4]);
      if (!paths.some(scope => path === scope || path.startsWith(`${scope}/`))) throw new Error("清理预览超出指定路径");
      return { path, mode: match[1], oid: match[3] };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length > 1000) throw new Error("每仓最多预览 1000 个旧文件，请缩小清理范围");
    return entries;
  }
  async previewCleanup(target: KnowledgeRepository, input: unknown, operator: string, signal?: AbortSignal): Promise<KnowledgeCleanupPlan> {
    const paths = this.cleanupPaths(input);
    return this.withGit(operator, async git => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const target_revision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      const entries = await this.cleanupEntries(git, target_revision, paths);
      return { id: `cleanup-${randomUUID()}`, target_id: target.id, paths, target_revision, entries, selected_paths: entries.map(entry => entry.path) };
    }, signal);
  }
  private async discoverMr(target: KnowledgeRepository, publication: DomainPublication, operator: string, signal?: AbortSignal) {
    const identity = this.identity(operator), query = new URLSearchParams({ repo: target.repository, source_branch: publication.branch, target_branch: target.branch });
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    let body: { mrs?: Array<{ id: string | number; url: string; source_branch: string; target_branch: string }> };
    try {
      const response = await fetch(`${identity.platformUrl.replace(/\/+$/, "")}/mr/discover?${query}`, { headers: identity.headers, signal: operationSignal });
      this.assertActive(operationSignal);
      if (!response.ok) {
        const failure = knowledgeHttpFailure(response, `HTTP ${response.status}`);
        const detail = await readMrFailureBody(response, operationSignal).catch(error => error instanceof Error ? error.message : String(error));
        this.assertActive(operationSignal); failure.message += detail ? `：${detail}` : ""; throw failure;
      }
      try { body = await response.json() as typeof body; this.assertActive(operationSignal); }
      catch (error) { if (error instanceof SyntaxError) throw new Error("交付平台响应不完整：原分支 MR 查询响应不是合法 JSON"); throw error; }
    } catch (error) { this.assertActive(signal); throw knowledgeMrFailure(error, "原分支 MR 查询", [identity.credential.password]); }
    if (!Array.isArray(body.mrs) || body.mrs.length > 1 || body.mrs.some(mr => mr.source_branch !== publication.branch
      || mr.target_branch !== target.branch || !/^https?:\/\//.test(mr.url) || mr.id === undefined)) throw new Error("原分支 MR 查询结果不明确，未重复创建");
    return body.mrs[0];
  }
  private async openMr<T extends DomainPublication>(job: Pick<DomainKnowledgeJob, "title" | "issue_no" | "issue_description">,
    target: KnowledgeRepository, publication: T, operator: string, save: (publication: T) => void, signal: AbortSignal): Promise<T> {
    const identity = this.identity(operator), issue = knowledgeIssueNumber(job.issue_no);
    const title = knowledgeIssueDescription(job.issue_description?.trim() ? job.issue_description : undefined) ?? job.title;
    publication.mr_attempted = true; save(publication);
    let receipt;
    try { receipt = await createMergeRequest({ platformUrl: identity.platformUrl, repo: target.repository, sourceBranch: publication.branch,
      targetBranch: target.branch, title, credential: identity.credential, dtsNo: issue, purpose: "knowledge", signal, includeFailureMetadata: true }); }
    catch (error) { signal.throwIfAborted(); this.assertActive(signal); throw knowledgeMrFailure(error, "MR 创建", [identity.credential.password]); }
    this.assertActive(signal);
    if (!/^https?:\/\//.test(receipt.url)) throw new Error("MR 链接无效，请恢复平台查询后手动重试");
    publication.url = receipt.url; publication.mr_id = receipt.id; publication.state = "opened";
    save(publication); return publication;
  }
  async publishCleanup(job: Pick<DomainKnowledgeJob, "id" | "title" | "issue_no" | "issue_description">, target: KnowledgeRepository,
    plan: KnowledgeCleanupPlan, input: unknown, previous: KnowledgeCleanupPublication | undefined, operator: string,
    save: (publication: KnowledgeCleanupPublication) => void, signal?: AbortSignal): Promise<KnowledgeCleanupPublication> {
    this.assertActive(signal);
    const issue = knowledgeIssueNumber(job.issue_no), selected = this.cleanupPaths(input, 1000);
    const branch = deliveryBranchName(target.branch, this.identity(operator).credential.username, issue);
    if (plan.target_id !== target.id || !selected.length || selected.some(path => !plan.entries.some(entry => entry.path === path))) throw new Error("请选择预览中的待删文件");
    const samePlan = previous?.cleanup_plan_id === plan.id;
    const continuing = samePlan && JSON.stringify(previous!.removed_paths) === JSON.stringify(selected);
    if (samePlan && !continuing && (previous!.revision || previous!.mr_attempted || previous!.url)) throw new Error("原清理分支已确定删除范围，请按原范围重试");
    let publication: KnowledgeCleanupPublication = continuing ? { ...structuredClone(previous!), state: "pending", error: undefined }
      : { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: selected, documents: [], state: "pending", branch };
    const saveLive = (value: KnowledgeCleanupPublication) => { this.assertActive(signal); save(structuredClone(value)); };
    if (publication.url) { publication.state = "opened"; saveLive(publication); return publication; }
    if (publication.mr_attempted) {
      const found = await this.discoverMr(target, publication, operator, signal);
      if (found) { publication = { ...publication, state: "opened", url: found.url, mr_id: found.id }; saveLive(publication); return publication; }
    }
    saveLive(publication);
    return this.withGit(operator, async (git, root, operationSignal) => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const base = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      let remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim().split(/\s/)[0];
      // 未推送的旧失败记录可改名；已在远端的分支仍沿原记录恢复，避免重复 MR。
      if (!remote && publication.branch !== branch) {
        publication.branch = branch; publication.revision = undefined; publication.mr_attempted = undefined; saveLive(publication);
        remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${branch}`])).trim().split(/\s/)[0];
      }
      if (remote) {
        if (!continuing || !publication.revision || remote !== publication.revision) throw knowledgeGitFailure("non_fast_forward", "同名清理分支已有提交，请先核对本单原分支");
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
      } else {
        const entries = await this.cleanupEntries(git, base, plan.paths);
        if (JSON.stringify(entries) !== JSON.stringify(plan.entries)) throw new Error("清理范围内的文件已变化，请重新预览，尚未删除文件");
        await git(["read-tree", base]);
        // 删除只改临时仓的索引；Git 在 bare 仓执行此命令时仍要求显式工作树位置。
        for (const path of selected) await git(["--work-tree", root, "update-index", "--force-remove", "--", path]);
        const tree = (await git(["write-tree"])).trim();
        publication.revision = (await git(["commit-tree", tree, "-p", base, "-m", cloudCommitSubject(issue, "feat", "清理萃取前旧知识")])).trim();
        saveLive(publication);
        await git(["push", target.repository, `${publication.revision}:refs/heads/${publication.branch}`]);
      }
      return this.openMr(job, target, publication, operator, saveLive, operationSignal);
    }, signal);
  }
  async publish(job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string,
    save: (publication: DomainPublication) => void, signal?: AbortSignal): Promise<DomainPublication> {
    this.assertActive(signal);
    const issue = knowledgeIssueNumber(job.issue_no), identity = this.identity(operator);
    const logicalTargets = new Map([job.knowledge_target, ...job.repositories].filter(candidate => candidate.repository === target.repository
      && candidate.branch === target.branch).map(candidate => [candidate.id, candidate]));
    const docs: DomainDocument[] = job.documents.filter(doc => doc.selected && logicalTargets.has(doc.target_id)).flatMap(doc => {
      if (!doc.knowledge_document_id || !doc.published_revision) throw new Error("请先发布所选知识，再手动归档正式版本");
      const formal = readKnowledgeDocumentVersion(this.options.dataDir, doc.knowledge_document_id, doc.published_revision).document;
      const outgoing = { ...doc, path: doc.archive_path ?? doc.path };
      if (!job.component_research_id) {
        if (formal.content !== doc.content) throw new Error("归档正文与所选正式版本不一致，请重新预览");
        return [outgoing];
      }
      // 平台不读回 Git 里的组件知识，结构化字段只留在正式库；仓里只放给人读的一篇正文（2026-10-08 用户）。
      const parts = componentArchiveParts(formal.content), requested = componentArchiveParts(doc.content);
      if (parts.content !== requested.content) throw new Error("组件归档正文与所选正式版本不一致，请重新预览");
      return [{ ...outgoing, content: parts.content }];
    });
    if (!docs.length) throw new Error("请选择至少一篇已发布知识进行归档");
    const documents: DomainPublication["documents"] = docs.map(doc => ({ id: doc.id, path: doc.path,
      content: doc.content, revision: doc.revision, knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision }));
    if (new Set(documents.map(doc => doc.path)).size !== documents.length) throw new Error("归档文件路径不能重复");
    for (const doc of docs) {
      const logicalTarget = logicalTargets.get(doc.target_id)!;
      if (!knowledgeRelativePath(doc.path, true).startsWith(`${logicalTarget.docs_path}/`) && doc.path !== doc.archive_path) throw new Error("归档文件超出指定目录或已设置的文件路径");
      scanForSecrets(doc.path, Buffer.from(doc.content));
    }
    const documentKey = (values: DomainPublication["documents"]) => JSON.stringify(values.map(doc => [doc.id, doc.path, doc.content, doc.revision,
      doc.knowledge_document_id, doc.knowledge_revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const continuing = !!previous && previous.target_id === target.id
      && documentKey(previous.attempted_documents ?? previous.documents) === documentKey(documents);
    // 同一精确版本的失败恢复沿用已落盘分支；新版本独立建MR，不受旧MR的合入或关闭影响。
    let publication: DomainPublication = { target_id: target.id, branch: continuing ? previous!.branch : `codex/knowledge-${job.id}-${target.id}-${randomUUID().slice(0, 8)}`,
      state: "pending", documents, ...(continuing ? { revision: previous!.revision, url: previous!.url, mr_id: previous!.mr_id, mr_attempted: previous!.mr_attempted } : {}) };
    const saveLive = (value: DomainPublication) => { this.assertActive(signal); save(structuredClone(value)); };
    if (continuing && publication.url) { publication.state = "opened"; saveLive(publication); return publication; }
    if (continuing && publication.mr_attempted) {
      const query = new URLSearchParams({ repo: target.repository, source_branch: publication.branch, target_branch: target.branch });
      const discoverSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      let body: { mrs?: Array<{ id: string | number; url: string; source_branch: string; target_branch: string }> };
      try {
        const response = await fetch(`${identity.platformUrl.replace(/\/+$/, "")}/mr/discover?${query}`, { headers: identity.headers, signal: discoverSignal });
        this.assertActive(discoverSignal);
        if (!response.ok) {
          const failure = knowledgeHttpFailure(response, `HTTP ${response.status}`);
          const detail = await readMrFailureBody(response, discoverSignal).catch(error => error instanceof Error ? error.message : String(error));
          this.assertActive(discoverSignal); failure.message += detail ? `：${detail}` : ""; throw failure;
        }
        try { body = await response.json() as typeof body; this.assertActive(discoverSignal); }
        catch (error) { if (error instanceof SyntaxError) throw new Error("交付平台响应不完整：原分支 MR 查询响应不是合法 JSON"); throw error; }
      } catch (error) { this.assertActive(signal); throw knowledgeMrFailure(error, "原分支 MR 查询", [identity.credential.password]); }
      if (!Array.isArray(body.mrs) || body.mrs.length > 1 || body.mrs.some(mr => mr.source_branch !== publication.branch
        || mr.target_branch !== target.branch || !/^https?:\/\//.test(mr.url) || mr.id === undefined)) throw new Error("原分支 MR 查询结果不明确，未重复创建");
      if (body.mrs[0]) {
        publication = { ...publication, state: "opened", url: body.mrs[0].url, mr_id: body.mrs[0].id };
        saveLive(publication); return publication;
      }
    }
    const title = knowledgeIssueDescription(job.issue_description?.trim() ? job.issue_description : undefined) ?? job.title;
    const saveAttempt = () => saveLive({ ...publication, documents: continuing ? previous!.documents : [], attempted_documents: documents });
    saveAttempt();
    return this.withGit(operator, async (git, root, operationSignal) => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const targetRevision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      const remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim().split(/\s/)[0];
      let parent = targetRevision;
      if (remote) {
        if (!continuing || !publication.revision || remote !== publication.revision) throw knowledgeGitFailure("non_fast_forward", "归档分支已有人工修改");
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
        parent = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      }
      await git(["read-tree", parent]);
      for (const doc of documents) {
        await this.content(git, parent, doc.path);
        const file = join(root, "knowledge-content.tmp"); writeFileSync(file, doc.content, { mode: 0o600 });
        const blob = (await git(["hash-object", "-w", file])).trim();
        await git(["update-index", "--add", "--cacheinfo", "100644", blob, doc.path]);
      }
      const tree = (await git(["write-tree"])).trim(), before = (await git(["rev-parse", `${parent}^{tree}`])).trim();
      // 纯适用范围新版本也独立尝试建MR；平台拒绝无差异时如实返回原文，不虚写成功。
      const revision = remote && tree === before ? parent : (await git(["commit-tree", tree, "-p", parent, "-m", cloudCommitSubject(issue, "feat", `更新${job.title}知识`)])).trim();
      publication.revision = revision; saveAttempt();
      if (revision !== remote) await git(["push", target.repository, `${revision}:refs/heads/${publication.branch}`]);
      saveLive(publication);
      publication.mr_attempted = true; saveLive(publication);
      let receipt;
      try { receipt = await createMergeRequest({ platformUrl: identity.platformUrl, repo: target.repository, sourceBranch: publication.branch,
        targetBranch: target.branch, title, credential: identity.credential, dtsNo: issue, purpose: "knowledge", signal: operationSignal, includeFailureMetadata: true }); }
      catch (error) { operationSignal.throwIfAborted(); this.assertActive(signal); throw knowledgeMrFailure(error, "MR 创建", [identity.credential.password]); }
      operationSignal.throwIfAborted(); this.assertActive(signal);
      if (!/^https?:\/\//.test(receipt.url)) throw new Error("MR 链接无效，请恢复平台查询后手动重试");
      publication.url = receipt.url; publication.mr_id = receipt.id; publication.state = "opened";
      saveLive(publication); return publication;
    }, signal);
  }
}
