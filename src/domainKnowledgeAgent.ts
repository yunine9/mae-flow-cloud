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

export interface DomainAgentOptions {
  dataDir: string;
  model: () => { provider: string; model: string; json: unknown } | undefined;
  source: (repository: KnowledgeRepository, operator: string, signal?: AbortSignal) => Promise<{ root: string; revision: string }>;
}
export async function runDomainKnowledge(input: DomainExecution, options: DomainAgentOptions) {
  const model = options.model();
  if (!model) throw new Error("请在模型网关配置主模型");
  const skill = new KnowledgeExtractionSkills(options.dataDir).pin("domain", join(input.root, "skill.json"), input.turn.use_latest_skill && !input.turn.skill);
  input.update({ skill: { name: skill.name, digest: skill.digest } });
  const sources = new Map<string, Promise<{ root: string; revision: string }>>(), revisions: Record<string, string> = { ...input.turn.revisions };
  const source = (repository: KnowledgeRepository) => {
    if (!sources.has(repository.id)) sources.set(repository.id, options.source(repository, input.turn.operator, input.signal).then(value => {
      if (input.signal.aborted) throw new Error("研究已停止");
      const revision = revisions[repository.id] ?? value.revision; revisions[repository.id] = revision;
      input.update({ revisions: { ...revisions } }); return { root: value.root, revision };
    }));
    return sources.get(repository.id)!;
  };
  const researchRepositories = input.job.source_repositories ?? input.job.repositories;
  const repositories = researchRepositories.map(repo => ({ ...repo, languages: ["agnostic"], description: "本次业务研究范围", enabled: true }));
  const readSources = new Set<string>(input.job.evidence.filter(event => event.tool === "component_source" && event.action === "read" && event.status === "returned" && event.revision === revisions[String(event.component_id)]).map(event => String(event.component_id)));
  const sourceTool = languageComponentSourceTool(repositories, row => source(researchRepositories.find(r => r.id === row.id)!), event => {
    if (event.action === "read" && event.status === "returned") readSources.add(String(event.component_id));
    input.evidence(event);
  });
  const documentTool = defineTool({
    name: "knowledge_draft", label: "保存领域知识草稿",
    description: "read 列出本次文档，id 读取全文；save 保存新文档或本轮选中文档的修订建议。目标编号 domain 为知识仓，repo-* 为对应业务仓；新文件使用默认文档目录，已有文件保持用户设置的完整路径（可能是根目录 AGENTS.md）。不能更换已有文件路径、修改源码、创建 MR 或直接采纳建议。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("save")]), id: Type.Optional(Type.String()),
      document: Type.Optional(Type.Object({ id: Type.String(), title: Type.String(), target_id: Type.String(), path: Type.String(), layer: Type.Union([Type.Literal("domain"), Type.Literal("repository")]), content: Type.String(), sources: Type.String() })) }),
    async execute(_id: string, params: { action: "read" | "save"; id?: string; document?: DomainDocumentContent }) {
      try {
        if (params.action === "read") {
          const docs = input.read();
          const data = params.id ? docs.find(d => d.id === params.id) : docs.map(({ content, history, base_content, ...doc }) => ({ ...doc, characters: content.length }));
          if (!data) throw new Error("文档不在本次研究范围");
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
  const tools = [extractionSkillTool(skill), sourceTool, codeSearchTool(input.evidence), documentTool, knowledgeMaterialTool(materials, join(options.dataDir, "knowledge-materials")), changesTool,
    wxdoubaoTool(input.signal, input.evidence)];
  const agentDir = join(input.root, "agent"); mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), { mode: 0o600 });
  const session = await CloudSession.create({ taskId: `${input.job.id}-${input.turn.id}`, workspace: input.root, agentDir,
    resumeSession: true,
    provider: model.provider, model: model.model, allowedTools: tools.map(t => t.name), extraTools: tools, allowHumanQuestions: false, allowSubagents: false,
    eventLog: new EventLog(join(input.root, "events.jsonl"), event => { if (event.kind === "assistant_message") input.evidence({ tool: "research_note", preview: evidencePreview(String(event.payload.text ?? "")) }); }),
    transcript: new TranscriptStore(join(input.root, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace: input.root, cwd: input.root, failClosed: true }), humanGate: new HumanGate(join(input.root, "waiting.json")),
    currentStep: () => "领域知识萃取", compactAnchor: () => input.job.scope,
  });
  let timedOut = false;
  const abort = () => { void session.abort().catch(() => undefined); };
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, 24 * 60 * 60_000); timer.unref();
  try {
    if (input.signal.aborted) throw new Error("研究已停止");
    const outcome = await session.start(extractionSkillMission(skill, {
      mode: input.turn.mode, title: input.job.title, scope: input.job.scope, repositories: researchRepositories, archive_targets: input.job.repositories, archive_configured: input.job.archive_configured, knowledge_target: input.job.knowledge_target,
      revisions, previous_revisions: input.turn.previous_revisions, selected_document_ids: input.turn.document_ids, message: input.turn.message,
      materials: materials.map(({ sections, ...m }) => ({ ...m, sections: sections.length })), ar_codes: input.job.ar_codes,
      documents: input.read().map(({ history, base_content, ...doc }) => doc),
      history: input.job.turns.filter(t => t.id !== input.turn.id && t.document_ids.some(id => input.turn.document_ids.includes(id))),
    }));
    if (timedOut) throw new Error("研究超过 24 小时，已有草稿保留");
    if (outcome.status !== "turn_finished") throw new Error("研究会话未正常完成");
    if (input.turn.mode === "extract") {
      const observed = readSources;
      if (repositories.some(repo => !observed.has(repo.id))) throw new Error("部分业务仓尚未读取，已保存草稿保留，请继续研究");
    }
    return session.finalReply();
  } finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); session.dispose(); }
}
