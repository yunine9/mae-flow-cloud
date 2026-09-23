import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CloudSession } from "./sessionDriver.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import { codeSearchTool, evidencePreview, executeFile, languageComponentSourceTool } from "./componentResearchTools.ts";
import { extractionSkillMission, extractionSkillTool, KnowledgeExtractionSkills } from "./knowledgeExtractionSkills.ts";
import { knowledgeMaterialTool, readKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { wxdoubaoTool } from "./wxdoubao.ts";
import type { DomainDocumentContent, DomainExecution, KnowledgeRepository } from "./domainKnowledgeExtraction.ts";
import { DomainResearchProgress, IncompleteDomainResearch } from "./domainResearchProgress.ts";
import { DomainResearchWorkers } from "./domainResearchWorkers.ts";
import { runDomainResearchWorker } from "./domainResearchWorkerAgent.ts";
import { businessKnowledgeEvidenceId, knowledgeEvidenceTool } from "./domainResearchEvidence.ts";

export interface DomainAgentOptions {
  dataDir: string;
  model: () => { provider: string; model: string; json: unknown } | undefined;
  source: (repository: KnowledgeRepository, operator: string, signal?: AbortSignal) => Promise<{ root: string; revision: string }>;
}
export async function runDomainKnowledge(input: DomainExecution, options: DomainAgentOptions) {
  const model = options.model();
  if (!model) throw new Error("请在模型网关配置主模型");
  const runController = new AbortController(), signal = AbortSignal.any([input.signal, runController.signal]);
  const skill = new KnowledgeExtractionSkills(options.dataDir).pin("domain", join(input.root, "skill.json"), input.turn.use_latest_skill && !input.turn.skill);
  input.update({ skill: { name: skill.name, digest: skill.digest } });
  const sources = new Map<string, Promise<{ root: string; revision: string }>>(), revisions: Record<string, string> = { ...input.turn.revisions };
  const source = (repository: KnowledgeRepository) => {
    if (!sources.has(repository.id)) sources.set(repository.id, options.source(repository, input.turn.operator, signal).then(value => {
      if (signal.aborted) throw new Error("研究已停止");
      const revision = revisions[repository.id] ?? value.revision; revisions[repository.id] = revision;
      input.update({ revisions: { ...revisions } }); return { root: value.root, revision };
    }));
    return sources.get(repository.id)!;
  };
  const researchRepositories = input.job.source_repositories ?? input.job.repositories;
  const repositories = researchRepositories.map(repo => ({ ...repo, languages: ["agnostic"], description: "本次业务研究范围", enabled: true }));
  const research = input.turn.mode === "extract" ? new DomainResearchProgress(input, revisions) : undefined;
  const observe = (event: Record<string, unknown>) => {
    signal.throwIfAborted();
    const evidenceId = businessKnowledgeEvidenceId(event);
    if (evidenceId) event = { ...event, evidence_id: evidenceId };
    input.job.evidence.push(event);
    research?.observe(event);
    input.evidence(event);
    return evidenceId;
  };
  const sourceTool = languageComponentSourceTool(repositories, row => source(researchRepositories.find(r => r.id === row.id)!), observe);
  const workers = research ? new DomainResearchWorkers({ root: join(input.root, "research-workers", input.turn.id), signal,
    capability: id => research.state.capabilities.find(c => c.id === id), evidence: input.evidence,
    run: (worker, workerSignal, save) => {
      const capability = research.state.capabilities.find(c => c.id === worker.capability_id);
      if (!capability) throw new Error("子研究对应的业务知识主题已不存在");
      return runDomainResearchWorker({ input, dataDir: options.dataDir, worker, signal: workerSignal, capability: structuredClone(capability),
        skill, model, revisions, source, evidence: observe, save });
    },
  }) : undefined;
  if (workers) research!.attachWorkers(workers);
  const documentTool = defineTool({
    name: "knowledge_draft", label: "保存领域知识草稿",
    description: "read 列出文档摘要，id 读取当前正文与来源；save 新建或完善本轮研究草稿，人工改过或已发布的文档受保护。修订/更新模式仅对选中文档生成建议。目标编号 domain 为知识仓，repo-* 为对应业务仓；新文件使用默认文档目录，已有文件保持完整路径。不能更换已有文件路径、修改源码、创建 MR 或直接采纳建议。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("save")]), id: Type.Optional(Type.String()),
      document: Type.Optional(Type.Object({ id: Type.String(), title: Type.String(), target_id: Type.String(), path: Type.String(), layer: Type.Union([Type.Literal("domain"), Type.Literal("repository")]), content: Type.String(), sources: Type.String() })) }),
    async execute(_id: string, params: { action: "read" | "save"; id?: string; document?: DomainDocumentContent }) {
      try {
        if (params.action === "read") {
          const docs = input.read();
          const found = params.id ? docs.find(d => d.id === params.id) : undefined;
          const data = params.id ? found && { ...documentSummary(found), content: found.content, sources: found.sources } : docs.map(documentSummary);
          if (!data) throw new Error("文档不在本次研究范围");
          research?.readDocument(params.id);
          return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} };
        }
        const doc = params.document;
        if (!doc) throw new Error("缺少草稿内容");
        const previous = input.read().find(d => d.id === doc.id);
        let baseline: { content: string | null; revision: string } | undefined;
        if (!previous && input.job.archive_configured !== false) {
          const target = [input.job.knowledge_target, ...input.job.repositories].find(r => r.id === doc.target_id);
          if (!target || !doc.path.startsWith(`${target.docs_path}/`) || /(^|\/)\.\.?($|\/)|[\\\x00-\x1f]/.test(doc.path)) throw new Error("无效的归档路径");
          const prepared = await options.source(target, input.turn.operator, input.signal);
          const entry = await executeFile("git", ["--literal-pathspecs", "ls-tree", prepared.revision, "--", doc.path], prepared.root, input.signal);
          if (entry && !/^100644 blob |^100755 blob /.test(entry)) throw new Error("目标路径不是普通文档文件");
          const content = entry ? await executeFile("git", ["show", `${prepared.revision}:${doc.path}`], prepared.root) : null;
          baseline = { content, revision: prepared.revision };
        }
        const saved = input.save(doc, baseline);
        if (!previous || previous.content !== doc.content || previous.sources !== doc.sources || previous.title !== doc.title) research?.documentChanged();
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: saved.id, saved: true, state: input.turn.mode === "extract" ? "draft" : "proposal" }) }], details: {} };
      } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "草稿操作失败" }], details: {}, isError: true }; }
    },
  });
  const changesTool = defineTool({
    name: "knowledge_source_changes", label: "核对来源变化",
    description: "比较增量更新前后的仓库版本；返回本次允许范围内的文件变化及补丁。没有旧版本时明确未建立基线。",
    parameters: Type.Object({ repository_id: Type.String() }),
    async execute(_id: string, params: { repository_id: string }) {
      try {
        const repo = researchRepositories.find(r => r.id === params.repository_id), previous = input.turn.previous_revisions?.[params.repository_id];
        if (!repo || !previous) throw new Error("该仓没有可比较的旧版本");
        const current = await source(repo);
        const patch = await executeFile("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--unified=3", `${previous}..${current.revision}`, "--", ...(repo.path ? [repo.path] : [])], current.root, input.signal);
        input.evidence({ tool: "knowledge_source_changes", repository_id: repo.id, previous, revision: current.revision, status: "returned" });
        return { content: [{ type: "text" as const, text: patch || "源码没有变化" }], details: {} };
      } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "来源比较失败" }], details: {}, isError: true }; }
    },
  });
  const materials = input.job.material_ids.map(id => readKnowledgeMaterial(join(options.dataDir, "knowledge-materials"), id));
  const tools = [extractionSkillTool(skill), sourceTool, codeSearchTool(input.evidence), documentTool, knowledgeMaterialTool(materials, join(options.dataDir, "knowledge-materials"), observe), changesTool,
    wxdoubaoTool(signal, observe, { evidencePaging: true }), knowledgeEvidenceTool(() => input.job.evidence, observe), ...(research ? [research.tool(), workers!.tool()] : [])];
  const agentDir = join(input.root, "agent"); mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), { mode: 0o600 });
  const session = await CloudSession.create({ taskId: `${input.job.id}-${input.turn.id}`, workspace: input.root, agentDir,
    resumeSession: true,
    provider: model.provider, model: model.model, allowedTools: tools.map(t => t.name), extraTools: tools, allowHumanQuestions: false, allowSubagents: false,
    eventLog: new EventLog(join(input.root, "events.jsonl"), event => { if (event.kind === "assistant_message") input.evidence({ tool: "research_note", preview: evidencePreview(String(event.payload.text ?? "")) }); }),
    transcript: new TranscriptStore(join(input.root, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace: input.root, cwd: input.root, failClosed: true }), humanGate: new HumanGate(join(input.root, "waiting.json")),
    currentStep: () => "领域知识萃取", compactAnchor: () => research?.anchor() ?? input.job.scope,
    log: text => { if (/压缩|上下文容量/.test(text)) input.evidence({ tool: "research_note", preview: evidencePreview(text) }); },
  });
  let timedOut = false;
  const abort = () => { void session.abort().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; runController.abort(); }, 24 * 60 * 60_000); timer.unref();
  try {
    signal.throwIfAborted(); workers?.restore();
    let outcome = await session.start((research ? `本次是持续业务知识研究任务，补全读代码无法得知的背景、业务意图、规则原因、隐含约束和历史经验。无线豆包与上传业务资料同为主力来源，按 Skill 的 references/materials.md 主动发现主题、追查需求设计与历史依据，没有上传资料也从业务检索开始。用 knowledge_evidence 检索和回读已有查询；源码仅按具体疑问辅助核对，不要求扫描或读取每个仓。先用 knowledge_research 保存知识问题和资料线索，持续补证；多项独立调查可用 knowledge_delegate 分工。完成项引用业务资料实际返回的 evidence_id，不能用源码代替业务意图依据。普通回复不会结束研究；知识主题调查和最终资料核对完成后才结束。既有草稿可完善，人工修改受保护。\n${research.anchor()}\n\n` : "") + extractionSkillMission(skill, {
      mode: input.turn.mode, title: input.job.title, scope: input.job.scope, repositories: researchRepositories, archive_targets: input.job.repositories, archive_configured: input.job.archive_configured, knowledge_target: input.job.knowledge_target,
      revisions, previous_revisions: input.turn.previous_revisions, selected_document_ids: input.turn.document_ids, message: input.turn.message,
      materials: materials.map(({ sections, ...m }) => ({ ...m, sections: sections.length })), ar_codes: input.job.ar_codes,
      documents: input.read().map(documentSummary),
      history: input.job.turns.filter(t => t.id !== input.turn.id && t.document_ids.some(id => input.turn.document_ids.includes(id))),
    }));
    const currentProgress = () => (research?.progress ?? 0) + (workers?.progress ?? 0);
    let stagnant = 0, progress = currentProgress();
    for (;;) {
      if (outcome.status === "turn_finished") await workers?.waitForIdle();
      if (timedOut) throw new IncompleteDomainResearch("研究达到单次连续运行 24 小时上限，尚未完成；已有草稿、会话和研究进度保留，可继续原任务");
      if (input.signal.aborted) throw new Error("研究已停止");
      if (outcome.status !== "turn_finished") throw new Error(`研究会话未正常完成：${outcome.detail ?? outcome.reason ?? "请查看执行记录"}`);
      const next = research?.next(); if (!next) break;
      if (currentProgress() === progress) stagnant++; else stagnant = 0;
      if (stagnant >= 3) throw new IncompleteDomainResearch("研究尚未完成，连续三轮未补充业务资料、知识结论或草稿；已停止无效重复，已有进度保留。" + research!.gaps().join("；"));
      progress = currentProgress();
      input.update({ stage: research!.state.phase === "review" ? "核对业务知识与证据" : "继续调查未完成知识主题" });
      outcome = await session.startResume(next);
    }
    return session.finalReply();
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); runController.abort(); await workers?.shutdown(); session.dispose(); }
}

/** 正文通过 knowledge_draft 按需读取，接续时不重复注入全部草稿。 */
function documentSummary(doc: ReturnType<DomainExecution["read"]>[number]) {
  return { id: doc.id, title: doc.title, target_id: doc.target_id, path: doc.path, layer: doc.layer,
    revision: doc.revision, characters: doc.content.length, human_edited: doc.human_edited };
}
