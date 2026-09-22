import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readKnowledgeMaterial, knowledgeMaterialTool } from "./knowledgeMaterials.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudSession } from "./sessionDriver.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import {
  executeFile,
  checkEc,
  languageComponentSourceTool,
  codeSearchTool,
  evidencePreview,
} from "./componentResearchTools.ts";
import type { ResearchExecution } from "./componentResearch.ts";
import type { ComponentRepository } from "./componentRepositories.ts";
import { jointResearchMission, researchDocumentTool } from "./componentResearchDocumentTool.ts";
import { researchDocumentMarkdown } from "./componentResearchDocument.ts";
import { bundledExtractionSkill, KnowledgeExtractionSkills, extractionSkillMission, extractionSkillTool, type ExtractionSkillSnapshot } from "./knowledgeExtractionSkills.ts";
export const componentResearchMission = (
  component: ComponentRepository, language: string, topic: string, revision: string,
  components: ComponentRepository[] = [component], discoverTopics = false,
  skill: ExtractionSkillSnapshot = bundledExtractionSkill("component"),
) => extractionSkillMission(skill, { mode: "extract", component, components, language, topic, revision,
  scope: discoverTopics ? "全部能力" : "指定主题", output: "最终回复输出 Markdown 草稿；不修改源码、不发布" });
export async function runComponentResearch(
  input: ResearchExecution,
  options: {
    dataDir: string;
    model: () => { provider: string; model: string; json: unknown } | undefined;
    source: (
      component: ComponentRepository,
      operator: string,
      signal?: AbortSignal,
    ) => Promise<{ root: string; revision: string }>;
  },
) {
  const model = options.model();
  if (!model) throw new Error("请在模型网关配置主模型");
  const skill = new KnowledgeExtractionSkills(options.dataDir).pin("component", join(input.root, "skill.json"), input.record.use_latest_skill);
  input.update({ skill: { name: skill.name, digest: skill.digest }, use_latest_skill: false });
  await checkEc(input.signal);
  if (input.signal.aborted) throw new Error("萃取已停止");
  const components = input.record.components ?? [input.record.component];
  const revisions: Record<string, string> = { ...input.record.revisions };
  const readRepositories = new Set<string>((input.record.evidence ?? [])
    .filter(event => event.tool === "component_source" && event.action === "read" && event.status === "returned" && event.component_id)
    .map(event => String(event.component_id)));
  input.update({ stage: "分析语言组件清单" });
  const agentDir = join(input.root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), {
    mode: 0o600,
  });
  let sourceRead = false;
  let callerRead = false;
  const observed = (event: Record<string, unknown>) => {
    if (
      event.tool === "component_source" &&
      event.action === "read" &&
      event.status === "returned"
    )
      { sourceRead = true; if (event.component_id) readRepositories.add(String(event.component_id)); }
    if (
      event.tool === "code_search" &&
      event.action === "read" &&
      event.status === "returned" &&
      Number(event.characters) > 0
    )
      callerRead = true;
    input.update({
      stage: event.tool === "code_search" ? "搜索真实调用" : "阅读组件源码",
    });
    input.evidence(event);
  };
  const resolveSource = async (component: ComponentRepository) => {
    if (input.signal.aborted) throw new Error("萃取已停止");
    const source = await options.source(component, input.review?.operator ?? input.record.operator, input.signal);
    const revision = revisions[component.id] ?? source.revision;
    revisions[component.id] = revision;
    input.update({ revisions: { ...revisions }, ...(components.length === 1 ? { revision } : {}) });
    return { ...source, revision };
  };
  const changesTool = defineTool({ name: "component_changes", label: "组件来源变化", description: "核对增量更新前后、允许范围内的源码补丁。没有旧版本时明确缺少基线。",
    parameters: Type.Object({ component_id: Type.String() }),
    async execute(_id: string, params: { component_id: string }) {
      try {
        const component = components.find(c => c.id === params.component_id), previous = input.review?.previous_revisions?.[params.component_id];
        if (!component || !previous) throw new Error("没有该组件的更新前版本");
        const current = await resolveSource(component);
        const patch = await executeFile("git", ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", `${previous}..${current.revision}`, "--", ...(component.path ? [component.path] : [])], current.root, input.signal);
        return { content: [{ type: "text" as const, text: patch || "源码没有变化" }], details: {} };
      } catch (error) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "比较失败" }], details: {}, isError: true }; }
    },
  });
  const materialTool = knowledgeMaterialTool((input.record.material_ids ?? []).map(id => readKnowledgeMaterial(join(options.dataDir, "knowledge-materials"), id)), join(options.dataDir, "knowledge-materials"));
  const session = await CloudSession.create({
    taskId: input.record.id,
    workspace: input.root,
    agentDir,
    provider: model.provider,
    model: model.model,
    eventLog: new EventLog(join(input.root, "events.jsonl"), event => {
      if (event.kind === "assistant_message") input.evidence({
        tool: "research_note", action: "分析说明", status: "returned",
        preview: evidencePreview(String(event.payload.text ?? "")),
      });
    }),
    transcript: new TranscriptStore(
      join(input.root, "transcript.jsonl"),
      "main",
    ),
    gate: new GateService({
      workspace: input.root,
      cwd: input.root,
      failClosed: true,
    }),
    humanGate: new HumanGate(join(input.root, "waiting.json")),
    allowHumanQuestions: false,
    allowSubagents: false,
    allowedTools: ["component_changes", "knowledge_material", "extraction_skill", "component_source", "code_search", ...(input.record.document ? ["research_document"] : [])],
    extraTools: [
      extractionSkillTool(skill),
      changesTool, materialTool,
      languageComponentSourceTool(components, resolveSource, observed),
      codeSearchTool(observed),
      ...(input.record.document ? [researchDocumentTool(input)] : []),
    ],
    currentStep: () => "组件知识萃取",
    compactAnchor: () => input.record.topic,
  });
  let timedOut = false;
  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, 24 * 60 * 60_000);
  timer.unref();
  try {
    if (input.signal.aborted) throw new Error("萃取已停止");
    const outcome = await session.start(
      (input.record.document ? jointResearchMission(input, skill) + `\n研究语言：${input.record.language}；完整仓库范围：${JSON.stringify(components)}` : componentResearchMission(
        input.record.component,
        input.record.language,
        input.record.topic,
        "通过 component_source 读取时固定并记录",
        components,
        input.record.mode === "component",
        skill,
      )),
    );
    if (timedOut) throw new Error("萃取超过 24 小时，已停止；可查看已有研究记录后重试");
    if (outcome.status !== "turn_finished")
      throw new Error("研究会话未正常完成，请查看执行记录后重试");
    if (!sourceRead && !input.review && !(input.record.document && readRepositories.size))
      throw new Error("没有实际读取组件源码，不能生成有来源的知识草稿，请重试");
    if (input.record.document && !input.review) {
      const missing = components.filter(component => !readRepositories.has(component.id));
      if (missing.length) throw new Error(`联合研究尚未读取这些仓库：${missing.map(component => component.name).join("、")}；已保存章节保留，可继续研究`);
      return researchDocumentMarkdown(input.record.topic, input.readDocument!());
    }
    input.update({ stage: "整理知识草稿" });
    if (input.review) return session.finalReply();
    return (
      (callerRead
        ? ""
        : "> 尚未取得可展开核对的跨仓调用。以下仅为源码分析草稿，不能视为已确认的开发范式。\n\n") +
      session.finalReply()
    );
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    session.dispose();
  }
}
