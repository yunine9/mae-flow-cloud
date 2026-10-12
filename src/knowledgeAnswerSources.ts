import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listBusinessModules } from "./businessModuleLibrary.ts";
import { componentRepositories, type ComponentRepository } from "./componentRepositories.ts";
import { componentCards, componentUsageDocument } from "./componentKnowledgeCards.ts";
import { codeSearchTool, ecBinary, languageComponentSourceTool } from "./componentResearchTools.ts";
import { readKnowledgeMaterial, type KnowledgeMaterial } from "./knowledgeMaterials.ts";
import { wxdoubaoTool, wxdoubaoConfig } from "./wxdoubao.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { KnowledgeProcessError, runKnowledgeCommand } from "./knowledgeProcess.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { repoSlug } from "./taskMemory.ts";
import type { KnowledgeRepository } from "./domainKnowledgeTypes.ts";
import type { KnowledgeSearch, KnowledgeContext } from "./knowledgeSearch.ts";
import type { KnowledgeAnswerExecution, KnowledgeAnswerEvidence } from "./knowledgeAnswerTypes.ts";

export type { KnowledgeRepository } from "./domainKnowledgeTypes.ts";
type SourceOptions = {
  dataDir: string;
  search: KnowledgeSearch;
  source?: (repository: KnowledgeRepository, operator: string, signal?: AbortSignal) => Promise<{ root: string; revision: string }>;
};
const PAGE = 16_000;
const MAX_EVIDENCE = 180_000;
const reply = (data: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) }], details: {}, ...(isError ? { isError: true } : {}),
});
const textOf = (result: any): string => result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function executeEveryCode(file: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    return await runKnowledgeCommand(file, args, { cwd, signal, timeoutMs: 30_000, maxBytes: 1024 * 1024,
      env: { ...process.env, EC_DEBUG: "0", GIT_TERMINAL_PROMPT: "0" } });
  } catch (error) {
    const code = error instanceof KnowledgeProcessError ? error.code : "execution";
    const message = code === "cancelled" ? "Every Code 操作已取消"
      : code === "timeout" ? "Every Code 操作超时，请缩小范围后重试"
      : code === "output_limit" ? "Every Code 返回内容过大，请缩小搜索或读取范围"
      : code === "ENOENT" ? "ec 工具未安装或路径错误"
      : code === "EACCES" ? "当前服务账户无权执行 ec，请检查工具执行权限"
      : "Every Code 调用失败，请检查工具配置、凭据和网络";
    throw Object.assign(new Error(message), { code });
  }
}
const pageEnd = (text: string, start: number, size = PAGE) => {
  let end = Math.min(text.length, start + size);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return end;
};
function materialEvidenceScope(material: KnowledgeMaterial): string {
  const scope = String(material.scope || "资料范围未说明").slice(0, 500);
  const warnings = (Array.isArray(material.warnings) ? material.warnings : []).map(String);
  const shown = warnings.slice(0, 4).map((warning, index) => `解析警告 ${index + 1}：${warning.length > 300 ? warning.slice(0, 300) + "…（警告正文已省略）" : warning}`);
  const omitted = warnings.length > shown.length ? `；另有 ${warnings.length - shown.length} 条解析警告未展开，完整记录保存在该资料元数据中` : "";
  const images = Array.isArray(material.images) ? material.images.length : 0;
  return `${scope}；依据为本页解析文本${images ? `；${images} 张图片尚未读取，不能推断图中条件` : ""}`
    + (shown.length ? `；${shown.join("；")}${omitted}` : "");
}
function moduleRepositories(dataDir: string) {
  return listBusinessModules(dataDir).modules.filter(m => m.status === "active").flatMap(m => m.repositories.map(repository => ({
    id: `module:${m.id}:${digest(repository).slice(0, 12)}`, name: `${m.name} · ${repoSlug(repository)}`,
    repository, branch: "", path: "", docs_path: "", module_id: m.id,
  })));
}

/** 只列团队登记来源；目录不会准备仓库，也不会遍历上传资料目录。 */
export function knowledgeAnswerSourceCatalog(dataDir: string, search?: KnowledgeSearch) {
  const modules = listBusinessModules(dataDir);
  const sources = componentRepositories(dataDir).filter(r => r.enabled);
  let wireless: { available: boolean; note: string };
  try { wxdoubaoConfig(); wireless = { available: true, note: "按问题查询无线通用背景；返回资料的原始文档与版本需要另行核实。" }; }
  catch { wireless = { available: false, note: "无线豆包未完整配置；其他来源仍可查询。" }; }
  const catalog = search?.catalog({ repo: "", repositories: [], moduleIds: [] }, true);
  const ec = ecBinary(), ecConfigured = isAbsolute(ec) ? existsSync(ec)
    : (process.env.PATH ?? "").split(delimiter).some(path => existsSync(join(path, ec)) || process.platform === "win32" && existsSync(join(path, ec + ".exe")));
  return {
    modules: modules.modules.filter(m => m.status === "active").map(m => ({ id: m.id, name: m.name, repositories: m.repositories })),
    repositories: [...sources.map(r => ({ ...r, kind: "component" as const })),
      ...moduleRepositories(dataDir).map(r => ({ ...r, kind: "module" as const, branch_note: "读取远端默认分支的当前提交，并在本次问答中固定版本。" }))],
    documents: (catalog?.assets ?? []).map(a => ({ id: a.id, title: a.title, module_ids: a.applicability?.modules ?? [], revision: a.revision })),
    sources: [
      { kind: "knowledge" as const, label: "团队正式知识", available: !!search, detail: "已发布文档、组件用法和采纳经验；索引服务状态在查询时确认。" },
      { kind: "code" as const, label: "登记代码仓", available: sources.length + moduleRepositories(dataDir).length > 0, detail: "按需读取固定提交；网络和仓库权限在实际读取时确认。" },
      { kind: "everycode" as const, label: "Every Code", available: ecConfigured, detail: ecConfigured ? "本机工具已配置；服务连通性及权限在查询时确认，未返回提交版本时保持未知。" : "本机 Every Code 工具尚未安装或配置。" },
      { kind: "wireless" as const, label: "无线豆包", available: wireless.available, detail: wireless.note },
      { kind: "material" as const, label: "原始资料", available: true, detail: "仅读取用户提问时明确提供的资料编号，不枚举其他上传资料。" },
    ],
    material_note: "原始资料只读取提问时明确提供的 material_ids；不枚举其他上传资料。",
    warnings: [...modules.warnings, ...(catalog?.warnings ?? [])],
  };
}

/** 多来源共同保存当次实际返回的正文；搜索与目录只用于定位。 */
export function createKnowledgeAnswerSources(input: KnowledgeAnswerExecution, options: SourceOptions): {
  tools: ToolDefinition<any, any>[]; description: string;
} {
  const selected = input.record.context ?? {};
  const registered = componentRepositories(options.dataDir).filter(r => r.enabled);
  const moduleSources = moduleRepositories(options.dataDir);
  const selectedModules = new Set(selected.module_ids ?? []);
  const selectedRepositories = new Set(selected.repository_ids ?? []);
  const explicitScope = selectedModules.size > 0 || selectedRepositories.size > 0;
  const repositories = [...registered, ...moduleSources.filter(r => !explicitScope || selectedModules.has(r.module_id)
    || selectedRepositories.has(r.id))];
  const permitted = selectedRepositories.size ? repositories.filter(r => selectedRepositories.has(r.id)
    || ("module_id" in r && selectedModules.has(String(r.module_id)))) : repositories;
  const context: KnowledgeContext = {
    repo: permitted[0] ? repoSlug(permitted[0].repository) : "", repositories: permitted.map(r => r.repository),
    moduleIds: [...selectedModules], productVersion: selected.product_version,
  };
  const allKnowledge = !selectedModules.size && !selectedRepositories.size;
  const reference = selected.document_id ? options.search.read(context, selected.document_id, allKnowledge) : undefined;
  if (selected.document_id && !reference) input.warn("指定参考文档不可读或不在本次范围，请核对文档与所选范围");
  const referenceCandidate = reference ? { id: reference.id, title: reference.title.slice(0, 200), revision: reference.revision,
    scope: reference.scope.slice(0, 500), paradigms: componentCards([reference]).cards.slice(0, 12).map(card => ({ id: card.paradigm.id, title: card.paradigm.title.slice(0, 200) })) } : undefined;
  let evidenceChars = input.record.evidence.reduce((sum, e) => sum + e.content.length, 0);
  const check = () => { if (input.signal.aborted) throw new Error("知识调查已取消"); };
  const save = (value: Omit<KnowledgeAnswerEvidence, "id" | "digest" | "retrieved_at">) => {
    check();
    if (!value.content.trim()) throw new Error("来源未返回可读正文，不能生成引用");
    if (evidenceChars + value.content.length > MAX_EVIDENCE) throw new Error("本次已读资料达到预算，请根据现有依据回答并说明尚未确认的问题");
    scanForSecrets("知识问答依据", Buffer.from(value.content));
    const evidence = input.addEvidence(value);
    evidenceChars += value.content.length;
    return evidence;
  };
  const guard = (tool: ToolDefinition<any, any>): ToolDefinition<any, any> => ({ ...tool,
    async execute(id, args, _signal, onUpdate, ctx) {
      try { check(); return await tool.execute(id, args, input.signal, onUpdate, ctx); }
      catch (error) { const message = error instanceof Error ? error.message : "来源查询未完成"; input.warn(message); return reply(message, true); }
    },
  });
  const knowledge = defineTool({
    name: "knowledge_search", label: "查阅团队知识",
    description: "list 浏览正式文档和组件用法，search 查相关候选；目录与摘要不算已读正文。read 使用 id 与 revision，普通文档按行分页；组件提供 paradigm_id 连同公共配置整体读取，按 next_offset 续读到 complete=true。文档修订不是产品版本，不同模块规则不可混用。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")]),
      query: Type.Optional(Type.String({ maxLength: 4000 })), id: Type.Optional(Type.String()), revision: Type.Optional(Type.String()),
      paradigm_id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })), end_line: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })), scope: Type.Optional(Type.Literal("components")),
    }),
    async execute(_id, args: any) {
      if (args.action === "search") {
        if (!args.query?.trim()) throw new Error("请提供要调查的具体问题 query");
        const result = await options.search.search(context, args.query, args.limit ?? 8, args.scope === "components", allKnowledge);
        for (const warning of result.warnings) input.warn(warning);
        return reply({ ...result, note: "这些是候选摘要；需 read 实际正文后才能引用。未命中不代表相关知识不存在。" });
      }
      if (args.action === "list") {
        const catalog = options.search.catalog(context, allKnowledge), start = args.offset ?? 0;
        const cards = componentCards(catalog.assets).cards;
        const rows = catalog.assets.map(a => ({ id: a.id, title: a.title, scope: a.scope, revision: a.revision,
          product_versions: a.productVersions, when_to_use: a.whenToUse,
          paradigms: cards.filter(c => c.source.id === a.id).map(c => ({ id: c.paradigm.id, title: c.paradigm.title, need: c.paradigm.need })) }));
        const page: typeof rows = [];
        for (const row of rows.slice(start, start + (args.limit ?? 12))) {
          const safe = { ...row, title: row.title.slice(0, 200), scope: row.scope.slice(0, 500),
            when_to_use: row.when_to_use.slice(0, 1000), paradigms: row.paradigms.slice(0, 12) };
          if (JSON.stringify([...page, safe]).length > PAGE) break;
          page.push(safe);
        }
        if (!page.length && start < rows.length) throw new Error("目录条目过大，请按具体问题搜索或使用已知文档编号读取");
        return reply({ documents: page, total: rows.length, next_offset: start + page.length < rows.length ? start + page.length : null,
          warnings: catalog.warnings, note: "仅目录，未读取正文。" });
      }
      const asset = options.search.read(context, args.id, allKnowledge);
      if (!asset) throw new Error("文档不存在、已停用或不在当前问题范围，请重新查目录");
      if (!args.revision || args.revision !== asset.revision) throw new Error("需要当前 revision；文档已更新时须重新定位，不能沿用旧行号");
      if (args.paradigm_id) {
        if (args.start_line !== undefined || args.end_line !== undefined) throw new Error("组件整体用法使用 offset 续读，不同时指定行号");
        const document = componentUsageDocument(asset, args.paradigm_id), start = args.offset ?? 0;
        if (!document) throw new Error("正式文档没有该用法，请重新查询");
        if (!Number.isSafeInteger(start) || start < 0 || start >= document.text.length) throw new Error("用法 offset 无效，请用上一页 next_offset");
        const end = pageEnd(document.text, start), content = document.text.slice(start, end);
        const evidence = save({ kind: "knowledge", title: `${asset.title} · ${args.paradigm_id}`, content,
          source_id: asset.id, revision: asset.revision, scope: asset.scope, location: `用法 ${args.paradigm_id}，字符 ${start}–${end}`,
          truncated: end < document.text.length });
        return reply({ evidence_id: evidence.id, revision: asset.revision, content, offset: start, next_offset: end < document.text.length ? end : null,
          complete: end === document.text.length, total_characters: document.text.length,
          note: "共同配置与用法的各页需从 offset=0 连续读完；末页不能单独证明已读完整。文档修订不是依赖版本。" });
      }
      if (args.offset !== undefined) throw new Error("普通文档按行读取；组件整体用法才使用 offset");
      const lines = asset.content.split(/\r?\n/), start = args.start_line ?? 1;
      if (!Number.isSafeInteger(start) || start < 1 || start > lines.length || args.end_line !== undefined && args.end_line < start) throw new Error("读取范围无效");
      const end = Math.min(lines.length, args.end_line ?? start + 159, start + 399);
      const delivered: string[] = [];
      let characters = 0;
      for (let i = start - 1; i < end; i++) {
        const line = `${i + 1}: ${lines[i]}`;
        if (characters + line.length + 1 > PAGE) break;
        delivered.push(line); characters += line.length + 1;
      }
      if (!delivered.length) throw new Error("单行内容过长，无法完整读取；请使用原始资料分段读取并说明未核实范围");
      const last = start + delivered.length - 1, content = delivered.join("\n");
      const evidence = save({ kind: "knowledge", title: asset.title, content, source_id: asset.id,
        revision: asset.revision, scope: `${asset.scope}；适用产品版本：${asset.productVersions.join("、") || "未知，需核对正文"}；适用条件：${asset.whenToUse}`,
        start_line: start, end_line: last, truncated: last < lines.length });
      return reply({ evidence_id: evidence.id, content, revision: asset.revision, scope: asset.scope,
        product_versions: asset.productVersions, when_to_use: asset.whenToUse,
        start_line: start, end_line: last, total_lines: lines.length, next_line: last < lines.length ? last + 1 : null });
    },
  });

  type Stored = { text: string; evidence: Omit<KnowledgeAnswerEvidence, "id" | "digest" | "retrieved_at" | "content"> };
  const retained = new Map<string, Stored>();
  const returnedPages = new Map<string, string>();
  let retainedChars = 0;
  const retain = (key: string, value: Stored) => {
    const previous = retained.get(key);
    if (previous) return;
    const available = 512_000 - retainedChars;
    if (available < PAGE) throw new Error("本次工具回复已达到保存预算，请缩小问题范围或根据现有依据回答");
    if (value.text.length > available) {
      value = { ...value, text: value.text.slice(0, pageEnd(value.text, 0, available - 100))
        + "\n工具回复超过本次保存预算，后续内容未保留；请缩小查询范围重新查阅。",
        evidence: { ...value.evidence, truncated: true } };
      input.warn("工具回复超过保存预算，只能核对已保留片段，后续内容尚未取得");
    }
    retainedChars += value.text.length; retained.set(key, value);
  };
  const deliverStored = (key: string, start = 0) => {
    const stored = retained.get(key);
    if (!stored || !Number.isSafeInteger(start) || start < 0 || start >= stored.text.length) throw new Error("回复编号或 offset 无效，只能回读本次实际取得的资料");
    const end = pageEnd(stored.text, start), content = stored.text.slice(start, end);
    const evidence = save({ ...stored.evidence, content, location: `${stored.evidence.location ?? "工具实际回复"}，字符 ${start}–${end}`,
      truncated: !!stored.evidence.truncated || end < stored.text.length });
    returnedPages.set(evidence.id, key);
    return reply({ evidence_id: evidence.id, content, next_offset: end < stored.text.length ? end : null,
      total_characters: stored.text.length, complete: end === stored.text.length,
      note: "引用仅支持本页实际返回内容；后续未读部分不可当作依据。" });
  };
  const ec = codeSearchTool(() => {}, { captureRead: true, executor: executeEveryCode });
  const everycode: ToolDefinition<any, any> = { ...ec, label: "Every Code 代码搜索",
    description: ec.description + " 搜索摘要不算已读源码；read 返回未确认提交版本的参考代码，不能当作当前项目版本。内容截断会明确提示，请缩小行范围继续读取。",
    async execute(id, args: any, signal, onUpdate, ctx) {
      const events: Record<string, unknown>[] = [];
      const tool = codeSearchTool(value => { events.push(value); }, { captureRead: true, executor: executeEveryCode });
      const result = await tool.execute(id, args, signal, onUpdate, ctx), text = textOf(result);
      const event = events.at(-1);
      if ((result as any).isError || event?.status !== "returned") {
        input.warn("Every Code 查询未完成；不能据此认定没有相关代码"); return result;
      }
      if (args.action !== "read") return reply({ content: text.slice(0, PAGE), truncated: text.length >= PAGE || Number(event.characters) > 30_000,
        note: "代码查询候选，尚未展开正文。返回过长请缩小搜索范围。" });
      const content = String(event.content ?? text);
      const key = `everycode:${digest(JSON.stringify([args.repository, args.path, args.start, args.end, content]))}`;
      const clipped = Number(event.characters) > content.length;
      retain(key, { text: "Every Code 实际返回；提交版本未确认，只能作为参考，关键实现需核对固定版本源码。\n" + content
        + (clipped ? "\n上游返回已截断，未取得后续内容；请缩小 start/end 重新读取。" : ""),
        evidence: { kind: "everycode", title: `${args.repository} / ${args.path}`, repository: args.repository,
          path: args.path, scope: "Every Code 有权访问的代码；提交版本未确认", truncated: clipped } });
      return deliverStored(key);
    },
  };

  const wirelessBase = wxdoubaoTool(input.signal, () => {}, { evidencePaging: true });
  const wireless: ToolDefinition<any, any> = { ...wirelessBase,
    async execute(id, args: any, signal, onUpdate, ctx) {
      let wirelessKey: string | undefined;
      const tool = wxdoubaoTool(input.signal, event => {
        if (event.status === "failed") { input.warn(String(event.error)); return; }
        if (event.status !== "available") return;
        const text = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        wirelessKey = `wireless:${digest(text)}`;
        retain(wirelessKey, { text: "无线豆包背景回复；未核验原始文档和版本，不能证明本系统需求、设计或历史原因。\n" + text,
          evidence: { kind: "wireless", title: "无线豆包背景资料", scope: "无线通用背景；原始文档未核验" } });
        return wirelessKey;
      }, { evidencePaging: true });
      const result = await tool.execute(id, args, signal, onUpdate, ctx);
      if (wirelessKey) return deliverStored(wirelessKey);
      if (!(result as any).isError) return reply({ state: "empty", note: "本次无线豆包未返回背景资料，不代表相关规则不存在。" });
      return result;
    },
  };

  const snapshots = new Map<string, { root: string; revision: string }>();
  const preparations = new Map<string, Promise<{ root: string; revision: string }>>();
  const sourceRows: ComponentRepository[] = permitted.map(r => ({ ...r, languages: "languages" in r ? r.languages : [],
    description: "description" in r ? r.description : "本次可访问的业务模块仓库", enabled: true }));
  const prepare = async (repository: ComponentRepository) => {
    check();
    if (!options.source) throw new Error("源码读取服务未配置；已发布知识与其他来源仍可查询");
    const key = JSON.stringify([repositoryIdentity(repository.repository), repository.branch]);
    if (!preparations.has(key)) preparations.set(key, (async () => {
      const source = await options.source!({ ...repository, docs_path: "" }, input.record.owner, input.signal);
      check();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.revision)) throw new Error("源码服务未返回完整提交版本，不能生成实现依据");
      return source;
    })().catch(error => { preparations.delete(key); throw error; }));
    const source = await preparations.get(key)!;
    snapshots.set(repository.id, source);
    return source;
  };
  const codeBase = languageComponentSourceTool(sourceRows, prepare, () => {});
  const code: ToolDefinition<any, any> = { ...codeBase,
    async execute(id, args: any, signal, onUpdate, ctx) {
      const events: Record<string, unknown>[] = [];
      const tool = languageComponentSourceTool(sourceRows, prepare, value => { events.push(value); });
      const result = await tool.execute(id, args, signal, onUpdate, ctx);
      const event = events.at(-1);
      if ((result as any).isError || event?.status !== "returned") {
        input.warn("指定仓库读取未完成；不能据此认定源码不存在"); return result;
      }
      const text = textOf(result);
      if (args.action !== "read") return reply({ content: text.slice(0, PAGE), truncated: text.length > PAGE,
        note: "仅定位结果，请展开源码后引用；本次仓库提交保持固定。" });
      const source = snapshots.get(String(event.repository_id));
      if (!source) throw new Error("缺少固定源码版本");
      const rows = text.split("\n").filter(line => /^\d+:/.test(line)), delivered: string[] = [];
      let characters = 0;
      for (const row of rows) { if (characters + row.length + 1 > PAGE) break; delivered.push(row); characters += row.length + 1; }
      if (!delivered.length) throw new Error("源码返回没有可完整读取的行，请核对路径和范围");
      const start = Number(/^(\d+):/.exec(delivered[0])![1]), end = Number(/^(\d+):/.exec(delivered.at(-1)!)![1]);
      const content = delivered.join("\n"), truncated = delivered.length < rows.length || /^返回内容已截断|^后续从 \d+ 行读取/m.test(text);
      const repository = permitted.find(r => r.id === event.repository_id);
      const evidence = save({ kind: "code", title: `${event.repository_id} / ${event.path}`, content,
        source_id: String(event.repository_id), repository: String(event.repository), path: String(event.path), revision: source.revision,
        start_line: start, end_line: end, truncated, scope: `${repository?.name ?? event.repository_id}；本次固定提交的已登记仓库；不含未提交工作区修改` });
      return reply({ evidence_id: evidence.id, content, revision: source.revision, start_line: start, end_line: end,
        next_line: truncated ? end + 1 : null, note: "只认可实际返回的行；返回末行不代表整个文件已读完。" });
    },
  };

  const materialRoot = join(options.dataDir, "knowledge-materials"), materials = new Map<string, KnowledgeMaterial>();
  for (const id of selected.material_ids ?? []) {
    try {
      const value = readKnowledgeMaterial(materialRoot, id);
      if (value.id !== id || !/^[a-f0-9]{64}$/.test(value.digest) || !Array.isArray(value.sections)
        || value.sections.some(s => typeof s.location !== "string" || typeof s.text !== "string")) throw new Error("资料记录损坏");
      materials.set(id, value);
    }
    catch { input.warn(`指定资料 ${id} 不存在或不可读`); }
  }
  const material = defineTool({
    name: "knowledge_material", label: "查阅明确提供的原始资料",
    description: "仅访问本次提问明确提供的资料编号。省略 id 列章节；read 指定 id、section（从1开始）及offset，按next_offset续读。未填写业务版本为未知，上传时间不代表版本。图片未读不能推断图中内容。",
    parameters: Type.Object({ id: Type.Optional(Type.String()), section: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args: any) {
      if (!args.id) return reply({ materials: [...materials.values()].map(m => ({ id: m.id, name: m.name, scope: m.scope, version: m.version || null,
        state: m.state, warnings: m.warnings, sections: m.sections.map((s, i) => ({ section: i + 1, location: s.location, characters: s.text.length })),
        images_not_read: m.images?.map(i => i.path) ?? [] })) });
      const value = materials.get(args.id);
      if (!value) throw new Error("资料不在用户本次明确提供的范围，不能访问其他上传资料");
      if (value.state !== "ready") throw new Error("资料解析失败，不能据此回答；请补充可读资料");
      const section = value.sections[(args.section ?? 1) - 1], start = args.offset ?? 0;
      if (!section || !Number.isSafeInteger(start) || start < 0 || start >= section.text.length) throw new Error("资料章节或 offset 无效");
      const end = pageEnd(section.text, start), content = section.text.slice(start, end);
      const evidence = save({ kind: "material", title: value.name, content, source_id: value.id, revision: value.version || undefined,
        scope: materialEvidenceScope(value), location: `${section.location}，字符 ${start}–${end}；原文件 SHA256=${value.digest}`, truncated: end < section.text.length });
      return reply({ evidence_id: evidence.id, content, version: value.version || null, location: section.location,
        next_offset: end < section.text.length ? end : null, next_section: (args.section ?? 1) < value.sections.length ? (args.section ?? 1) + 1 : null,
        note: "只读到该章节本页；资料上传时间不证明业务版本，图片内容尚未核验。" });
    },
  });
  const evidence = defineTool({
    name: "knowledge_evidence", label: "回读本次调查依据",
    description: "按 evidence_id 回读本次实际收到的工具回复；长 Every Code 或豆包回复用上次 next_offset 续读，每页生成实际引用编号。不会访问其他问答或全局资料。",
    parameters: Type.Object({ evidence_id: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args: any) {
      const key = returnedPages.get(args.evidence_id);
      if (key) return deliverStored(key, args.offset ?? 0);
      const saved = input.record.evidence.find(e => e.id === args.evidence_id);
      if (!saved) throw new Error("该编号不属于本次实际已读依据");
      const start = args.offset ?? 0;
      if (!Number.isSafeInteger(start) || start < 0 || start >= saved.content.length) throw new Error("依据 offset 无效");
      const end = pageEnd(saved.content, start);
      return reply({ ...saved, content: saved.content.slice(start, end), next_offset: end < saved.content.length ? end : null });
    },
  });
  const sourceDirectory = defineTool({
    name: "knowledge_sources", label: "浏览本次可读源码来源",
    description: "按页查看本次有权读取的源码仓目录，用返回 id 调 component_source；不接受任意仓库地址。",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args: any) {
      const start = args.offset ?? 0, page = permitted.slice(start, start + 12);
      return reply({ repositories: page.map(r => ({ id: r.id, name: r.name, repository: r.repository, branch: r.branch || "远端默认分支", path: r.path })),
        total: permitted.length, next_offset: start + page.length < permitted.length ? start + page.length : null });
    },
  });
  const description = "可按问题选择正式知识、Every Code、固定版本源码、无线背景和用户明确提供的资料；没有固定来源优先级。"
    + "问当前实现需核对明确版本代码；问业务规则需核对适用模块、条件与原始资料。搜索摘要只是入口，只有实际读到的正文生成引用。"
    + "无线豆包只能补无线通用背景；工具回复没有原文或版本时保持未知。不同模块、版本和资料来源出现冲突应分别说明。"
    + `本次源码来源 ${permitted.length} 个，用 knowledge_sources 分页查看。`
    + (referenceCandidate ? `用户明确参考的文档定位信息（尚未读取正文，仍需 knowledge_search.read）：${JSON.stringify(referenceCandidate)}。` : "")
    + `本次明确资料：${JSON.stringify([...materials.keys()])}。外部服务失败或索引未就绪不能当作相关知识不存在。`;
  return { tools: [knowledge, everycode, code, wireless, material, evidence, sourceDirectory].map(guard), description };
}
