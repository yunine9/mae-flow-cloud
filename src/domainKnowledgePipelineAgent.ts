import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { CloudSession } from "./sessionDriver.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import { evidencePreview, executeFile, languageComponentSourceTool } from "./componentResearchTools.ts";
import { extractionSkillMission, extractionSkillTool, type ExtractionSkillSnapshot } from "./knowledgeExtractionSkills.ts";
import { knowledgeMaterialTool, readKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { wxdoubaoTool } from "./wxdoubao.ts";
import { businessKnowledgeEvidenceId, isBusinessKnowledgeEvidence, knowledgeEvidenceTool } from "./domainResearchEvidence.ts";
import { DomainKnowledgePipeline, type KnowledgeWork, type KnowledgeWorkResult } from "./domainKnowledgePipeline.ts";
import { knowledgeStructure, scanKnowledgeCode, validateKnowledgeReferences, type KnowledgeCodeSnapshot } from "./domainKnowledgeCode.ts";
import { IncompleteDomainResearch } from "./domainResearchProgress.ts";
import type { DomainDocumentContent, DomainExecution, KnowledgeRepository } from "./domainKnowledgeTypes.ts";
import type { DomainAgentOptions } from "./domainKnowledgeAgent.ts";

const strings = () => Type.Array(Type.String());
const resultSchema = Type.Object({ findings: Type.String(), document_ids: strings(), open_questions: strings(),
  modules: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), kind: Type.Union([Type.Literal("public"), Type.Literal("business")]), depends_on: strings(), scope: Type.String() }))),
  subfeatures: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), hops: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), questions: Type.String() })) }))),
  cross_items: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), questions: Type.String() }))),
});

export async function runDomainKnowledgePipeline(input: DomainExecution, options: DomainAgentOptions, skill: ExtractionSkillSnapshot) {
  const model = options.model(); if (!model) throw new Error("请在模型网关配置主模型");
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), 48 * 60 * 60_000); timer.unref();
  const root = join(input.root, "knowledge-pipeline", input.turn.id);
  const pipeline = new DomainKnowledgePipeline(join(root, "state.json"), skill.digest, input.turn.pipeline_continue);
  const repositories = input.job.source_repositories ?? input.job.repositories;
  const revisions = { ...input.turn.revisions };
  const sources = new Map<string, { root: string; revision: string }>();
  const source = async (repo: KnowledgeRepository) => {
    if (!sources.has(repo.id)) {
      const prepared = await options.source(repo, input.turn.operator, signal);
      signal.throwIfAborted();
      const revision = revisions[repo.id] ?? prepared.revision;
      revisions[repo.id] = revision; input.update({ revisions: { ...revisions } });
      sources.set(repo.id, { ...prepared, revision });
    }
    return sources.get(repo.id)!;
  };
  try {
    input.update({ stage: "扫描固定版本的源码结构" });
    const snapshots: KnowledgeCodeSnapshot[] = [];
    for (const repository of repositories) snapshots.push(await scanKnowledgeCode(repository, await source(repository), signal));
    const structure = knowledgeStructure(snapshots);
    writeFileSync(join(root, "structure.json"), JSON.stringify(structure), { mode: 0o600 });
    const materials = input.job.material_ids.map(id => readKnowledgeMaterial(join(options.dataDir, "knowledge-materials"), id));
    const phaseFile = (task: KnowledgeWork) => task.phase === "synthesis" ? "phase-synthesis" : `phase-${task.phase}`;
    const session = async (task: KnowledgeWork, reviewResult?: KnowledgeWorkResult) => {
      signal.throwIfAborted();
      const review = !!reviewResult, sessionId = `${task.id}-${review ? "review" : "write"}-${randomUUID()}`;
      const sessionRoot = join(root, "sessions", sessionId), agentDir = join(sessionRoot, "agent");
      mkdirSync(agentDir, { recursive: true }); writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), { mode: 0o600 });
      let result: KnowledgeWorkResult | undefined;
      let verdict: { pass: boolean; feedback: string } | undefined;
      const reads = new Map<string, number>(), sourceReads = new Set<string>(), businessReads = new Set<string>(), saved = new Set<string>();
      const observe = (event: Record<string, unknown>) => {
        signal.throwIfAborted();
        const evidence_id = businessKnowledgeEvidenceId(event);
        const row = { ...event, ...(evidence_id ? { evidence_id } : {}), pipeline_task: task.id, pipeline_session: sessionId };
        input.job.evidence.push(row); input.evidence(row);
        if (evidence_id) businessReads.add(evidence_id);
        if (event.tool === "knowledge_evidence" && event.action === "read" && event.status === "returned") businessReads.add(String(event.evidence_id));
        if (event.tool === "component_source" && event.action === "read" && event.status === "returned") sourceReads.add(`${event.component_id}:${event.path}`);
        return evidence_id;
      };
      const draftTool = defineTool({ name: "knowledge_draft", label: review ? "读取待评审草稿" : "保存知识草稿",
        description: review ? "read 列摘要，id 读取全文；评审不能修改草稿。" : "read 列摘要，id 读取全文；save 保存本任务草稿。稳定编号不超过 100 字符，使用上下文提供的目标编号和 docs_path。保留人工编辑；保存不等于归档。",
        parameters: Type.Object({ action: Type.Union([Type.Literal("read"), ...(!review ? [Type.Literal("save")] : [])]), id: Type.Optional(Type.String()),
          ...(!review ? { document: Type.Optional(Type.Object({ id: Type.String(), title: Type.String(), target_id: Type.String(), path: Type.String(), layer: Type.Union([Type.Literal("domain"), Type.Literal("repository")]), content: Type.String(), sources: Type.String() })) } : {}) }),
        execute: async (_id: string, params: any) => {
          try {
            signal.throwIfAborted();
            const documents = input.read();
            if (params.action === "read") {
              if (params.id) {
                const doc = documents.find(d => d.id === params.id); if (!doc) throw new Error("文档不存在");
                reads.set(doc.id, doc.revision); return reply({ id: doc.id, title: doc.title, content: doc.content, sources: doc.sources, revision: doc.revision });
              }
              return reply(documents.map(d => ({ id: d.id, title: d.title, path: d.path, target_id: d.target_id })));
            }
            if (review) throw new Error("评审只读");
            if (result) throw new Error("任务结果已提交，不能继续改写草稿");
            const doc: DomainDocumentContent | undefined = params.document; if (!doc) throw new Error("缺少文档");
            const owner = pipeline.state.tasks.find(t => t.id !== task.id && (t.document_ids ?? t.result?.document_ids ?? []).includes(doc.id));
            if (owner) throw new Error(`文档由 ${owner.id} 负责，本任务只能引用它`);
            const target = [input.job.knowledge_target, ...input.job.repositories].find(r => r.id === doc.target_id);
            if (!target || !doc.path.startsWith(`${target.docs_path}/`) || /(^|\/)\.\.?($|\/)|[\\\x00-\x1f]/.test(doc.path)) throw new Error("无效的归档路径");
            const refs = await validateKnowledgeReferences(doc.content + "\n" + doc.sources, snapshots, signal);
            if (refs.errors.length) throw new Error(refs.errors.join("；"));
            let baseline: { content: string | null; revision: string } | undefined;
            if (!documents.some(d => d.id === doc.id) && input.job.archive_configured !== false) {
              const prepared = await options.source(target, input.turn.operator, signal);
              const entry = await executeFile("git", ["--literal-pathspecs", "ls-tree", prepared.revision, "--", doc.path], prepared.root, signal);
              if (entry && !/^100644 blob |^100755 blob /.test(entry)) throw new Error("目标路径不是普通文档文件");
              baseline = { content: entry ? await executeFile("git", ["show", `${prepared.revision}:${doc.path}`], prepared.root, signal) : null, revision: prepared.revision };
            }
            input.save(doc, baseline); saved.add(doc.id); pipeline.recordDocument(task.id, doc.id);
            return reply({ saved: true, id: doc.id });
          } catch (error) { return failure(error); }
        },
      });
      const resultTool = defineTool({ name: "knowledge_work_result", label: review ? "提交独立评审结论" : "保存本项任务结果",
        description: review ? "必须先读取所有待评审文档，并亲自读取关键代码引用；pass=false 时 feedback 给出具体位置和修改建议。" : "保存本项结果。inventory 填 modules；plan 填 subfeatures；cross-plan 填 cross_items；其他阶段填写 findings、document_ids、open_questions。hop 的 findings 是供后续组装使用的证据与文档片段。",
        parameters: review ? Type.Object({ pass: Type.Boolean(), feedback: Type.String() }) : resultSchema,
        execute: async (_id: string, params: any) => {
          try {
            signal.throwIfAborted();
            if (JSON.stringify(params).length > 120000) throw new Error("任务结果过长，请保留具体证据与结论，拆分过大的任务");
            scanForSecrets("领域任务结果", Buffer.from(JSON.stringify(params)));
            if (review) {
              if (params.pass) {
                if (reviewResult!.document_ids.some(id => reads.get(id) !== input.read().find(d => d.id === id)?.revision)) throw new Error("尚未读取全部待评审文档全文");
                const contents = reviewResult!.findings + "\n" + input.read().filter(d => reviewResult!.document_ids.includes(d.id)).map(d => d.content + "\n" + d.sources).join("\n");
                const refs = await validateKnowledgeReferences(contents, snapshots, signal);
                if (refs.errors.length) throw new Error(refs.errors.join("；"));
                const files = new Set(refs.checked.filter(r => !r.includes("*")).map(r => r.replace(/:\d+(?:-\d+)?$|#.*$/g, "")));
                const sampled = [...files].filter(ref => {
                  const i = ref.indexOf(":"), repo = snapshots.find(s => s.repository.id === ref.slice(0, i) || s.repository.name === ref.slice(0, i));
                  return repo && sourceReads.has(`${repo.repository.id}:${ref.slice(i + 1)}`);
                });
                if (sampled.length < Math.min(3, files.size)) throw new Error("尚未亲自读取至少三处关键源码；不足三处时全部核对");
                const businessRefs = [...new Set(contents.match(/knowledge-evidence-[a-f0-9]{24}/g) ?? [])];
                if (businessRefs.some(id => !businessReads.has(id))) throw new Error("尚未回读全部引用的上传资料与无线豆包证据");
              } else if (!params.feedback.trim()) throw new Error("退回需要具体修改意见");
              verdict = { pass: params.pass, feedback: params.feedback };
            } else {
              if (params.document_ids.some((id: string) => !saved.has(id))) throw new Error("结果只能引用本会话实际保存的草稿");
              const owned = pipeline.state.tasks.find(t => t.id === task.id)?.document_ids ?? [];
              if (owned.some(id => !params.document_ids.includes(id))) throw new Error("本任务保存过的草稿必须全部列入结果并接受独立评审");
              const refs = await validateKnowledgeReferences(params.findings, snapshots, signal);
              if (refs.errors.length) throw new Error(refs.errors.join("；"));
              const referenced = [...new Set((params.findings + "\n" + input.read().filter(d => params.document_ids.includes(d.id)).map(d => d.sources + "\n" + d.content).join("\n")).match(/knowledge-evidence-[a-f0-9]{24}/g) ?? [])];
              if (referenced.some(id => !input.job.evidence.some(e => e.evidence_id === id && isBusinessKnowledgeEvidence(e)))) throw new Error("引用了本任务没有取得的业务资料证据");
              result = structuredClone(params);
            }
            return reply({ saved: true });
          } catch (error) { return failure(error); }
        },
      });
      const taskTool = defineTool({ name: "knowledge_work", label: "读取持久研究进度",
        description: "省略 id 分页列出小任务摘要；id 读取任务、证据结果与评审意见。避免重复研究已完成项。",
        parameters: Type.Object({ id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
        execute: async (_id: string, params: { id?: string; start?: number; count?: number }) => reply(params.id
          ? pipeline.state.tasks.find(t => t.id === params.id) ?? null
          : { total: pipeline.state.tasks.length, tasks: pipeline.state.tasks.slice(params.start ?? 0, (params.start ?? 0) + (params.count ?? 25)).map(t => ({ id: t.id, title: t.title, phase: t.phase, status: t.status })) }),
      });
      const structureTool = defineTool({ name: "knowledge_structure", label: "读取源码结构与构建依赖",
        description: "省略 repository_id 列各仓摘要；指定仓编号按 start/count 分页读构建单元和静态依赖。候选依赖仍需读取源码核对。",
        parameters: Type.Object({ repository_id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
        execute: async (_id: string, params: { repository_id?: string; start?: number; count?: number }) => {
          if (!params.repository_id) return reply(structure.map(s => ({ repository_id: s.repository_id, revision: s.revision, files: s.files, build_units: s.build_units.length, dependency_edges: s.dependency_edges.length })));
          const row = structure.find(s => s.repository_id === params.repository_id); if (!row) return failure(new Error("仓不在研究范围"));
          const start = params.start ?? 0, count = params.count ?? 25, units = row.build_units.slice(start, start + count);
          return reply({ repository_id: row.repository_id, total: row.build_units.length, build_units: units,
            dependency_edges: row.dependency_edges.filter(e => units.some(u => e.from === `${row.repository_id}:${u.path}`)),
            next_start: start + count < row.build_units.length ? start + count : undefined, note: row.note });
        },
      });
      const tools = [structureTool, extractionSkillTool(skill), draftTool, resultTool, taskTool,
        languageComponentSourceTool(repositories.map(r => ({ ...r, enabled: true, description: "研究范围", languages: ["agnostic"] })), r => source(repositories.find(repo => repo.id === r.id)!), observe),
        knowledgeMaterialTool(materials, join(options.dataDir, "knowledge-materials"), observe),
        wxdoubaoTool(signal, observe, { evidencePaging: true }), knowledgeEvidenceTool(() => input.job.evidence, observe)];
      const instruction = `你是领域知识${review ? "独立评审者，不是作者" : "研究者"}，只处理当前小任务。先用 extraction_skill 读 references/principles.md 和 references/${review ? "phase-review" : phaseFile(task)}.md。通过 knowledge_work read（提供 id）读取依赖任务结果。只用本会话工具，不能调用 Claude CLI、Bash 或写源码。使用 knowledge_work_result 保存结构化结果后结束；普通回复不是完成信号。\n`;
      const prompt = instruction + extractionSkillMission(skill, { task, review_result: reviewResult, repositories, revisions,
        archive_targets: [input.job.knowledge_target, ...input.job.repositories], structure: task.phase === "inventory" ? structure.map(s => ({ repository_id: s.repository_id, revision: s.revision, files: s.files, build_units: s.build_units.length, note: s.note })) : undefined,
        scope: input.job.scope, materials: materials.map(({ sections, ...m }) => ({ ...m, sections: sections.length })), ar_codes: input.job.ar_codes });
      const driver = await CloudSession.create({ taskId: `${input.job.id}-${sessionId}`, workspace: sessionRoot, agentDir,
        resumeSession: false, provider: model.provider, model: model.model, allowedTools: tools.map(t => t.name), extraTools: tools,
        allowHumanQuestions: false, allowSubagents: false,
        eventLog: new EventLog(join(sessionRoot, "events.jsonl"), event => { if (event.kind === "assistant_message") observe({ tool: "research_note", preview: evidencePreview(String(event.payload.text ?? "")) }); }),
        transcript: new TranscriptStore(join(sessionRoot, "transcript.jsonl"), "main"),
        gate: new GateService({ workspace: sessionRoot, cwd: sessionRoot, failClosed: true }), humanGate: new HumanGate(join(sessionRoot, "waiting.json")),
        currentStep: () => task.title, compactAnchor: () => instruction + JSON.stringify(task),
      });
      const abort = () => { void driver.abort().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      let expired = false;
      const sessionTimer = setTimeout(() => { expired = true; abort(); }, 45 * 60_000); sessionTimer.unref();
      try {
        signal.throwIfAborted();
        let outcome = await driver.start(prompt);
        for (let retry = 0; retry < 2 && !result && !verdict && outcome.status === "turn_finished"; retry++) outcome = await driver.startResume("本项任务未保存结构化结果，请继续具体工作并调用 knowledge_work_result。");
        signal.throwIfAborted();
        if (expired || outcome.status !== "turn_finished" || (!result && !verdict)) throw new Error("本项会话未完成，重新使用独立会话执行");
        if (review && verdict?.pass && reviewResult!.document_ids.some(id => reads.get(id) !== input.read().find(d => d.id === id)?.revision)) throw new Error("评审期间草稿发生变化，需要重新核对当前版本");
        writeFileSync(join(sessionRoot, "result.json"), JSON.stringify(verdict ?? result), { mode: 0o600 });
        return { result, verdict };
      } finally { clearTimeout(sessionTimer); signal.removeEventListener("abort", abort); driver.dispose(); }
    };
    return await pipeline.run({ signal,
      changed: state => input.update({ research: { inventory_complete: state.tasks.some(t => t.id === "inventory" && t.status === "done"),
        phase: state.tasks.every(t => t.status === "done") ? "complete" : "research",
        capabilities: state.tasks.map(t => ({ id: t.id, title: t.title, repository_ids: [], state: t.status === "done" ? "researched" : t.status === "failed" ? "blocked" : "pending",
          findings: t.feedback ?? t.result?.findings ?? "", sources: [], document_ids: t.result?.document_ids ?? [] })) } }),
      stage: stage => { input.update({ stage }); input.evidence({ tool: "research_note", preview: stage }); },
      execute: async task => (await session(task)).result!,
      review: async (task, result) => {
        const response = await session(task, result);
        return response.verdict?.pass ? undefined : response.verdict?.feedback || "评审未保存结论";
      },
    });
  } catch (error) {
    if (controller.signal.aborted && !input.signal.aborted) throw new IncompleteDomainResearch("达到连续运行 48 小时上限，研究进度和草稿保留，可接续研究");
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const failure = (error: unknown) => ({ ...reply({ error: error instanceof Error ? error.message : String(error) }), isError: true });
