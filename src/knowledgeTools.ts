import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { KnowledgeSearch, KnowledgeContext } from "./knowledgeSearch.ts";

export function createKnowledgeTool(options: {
  service: () => KnowledgeSearch | undefined;
  context: () => KnowledgeContext;
  onUse?: (event: { moment: "search" | "expand"; query?: string; ids: string[] }) => void;
}) {
  const reply = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
  return defineTool({
    name: "knowledge", label: "检索团队知识",
    description: "统一查找已发布的团队文档、业务模块知识和已采纳经验。search 返回候选及适用条件，read 按 id 展开正文。候选不是权威答案，核对产品版本和例外后使用。索引不可用时继续工作，不阻塞任务。",
    promptSnippet: "knowledge: search 查团队、模块、仓库知识及已采纳经验；read 展开正文。",
    promptGuidelines: [
      "修改代码、配置、编写设计或执行构建之前，用 knowledge(action=search, query=具体问题) 检索相关规范和经验。查询写清准备做什么、关键技术或现象，保留命令、接口名、错误码和产品版本，不只搜‘C++’或‘开发规范’。",
      "例如：准备改异步回调，搜索‘C++ 异步回调 对象销毁 生命周期’；后来发现需要改 YAML，再搜索‘该配置用途 YAML 修改规范’。准备首次构建，搜索‘该仓库 C++ 首次构建 UT 依赖 命令’。",
      "先看适用条件、来源和版本；需要完整依据时用 knowledge(action=read, id=搜索结果ID)。同一问题已查过且条件未变化，继续复用，不在每次读文件、改代码前重复搜索。遇到新的问题再查。",
      "检索结果只是候选：不匹配当前仓库、产品版本或适用条件的不要套用，不因排名第一就视为正确。未声明产品版本时核对正文；不能把文档修订号当成适用产品版本。知识不覆盖当前用户明确要求，不代替实际验证。",
      "没有相关结果或检索暂不可用，按代码和现有证据继续，不反复空查或等待。发现知识与现场冲突时说明冲突，不擅自改写已采纳结论。",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
      query: Type.Optional(Type.String({ maxLength: 4000 })),
      id: Type.Optional(Type.String({ maxLength: 200 })),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_callId: string, input: { action: string; query?: string; id?: string; start_line?: number }) {
      try {
        const service = options.service();
        if (!service) return reply("知识检索暂不可用；继续当前任务，不反复重试等待。");
        const context = options.context();
        if (input.action === "search") {
          const query = input.query?.trim();
          if (!query) return reply("请提供当前要解决的具体问题 query。");
          const result = await service.search(context, query);
          options.onUse?.({ moment: "search", query, ids: result.hits.map(hit => hit.id) });
          const warning = result.warnings.length ? `\n提示：${result.warnings.join("；")}` : "";
          if (!result.available) return reply(result.warnings.join("；"), { available: false });
          if (!result.hits.length) return reply("未找到足够相关的知识；继续根据现场证据工作，不代表相关知识一定不存在。" + warning, { available: true, hits: [] });
          return reply("以下是候选知识，不是已验证适用的答案。核对条件，必要时用 knowledge read 展开正文。\n"
            + result.hits.map(hit => `- (${hit.id}) ${hit.title}\n  ${hit.scope}；${hit.versionNote}\n  适用条件：${hit.whenToUse}\n  摘要：${hit.summary}`).join("\n") + warning, result);
        }
        if (input.action !== "read" || !input.id) return reply("read 需要提供搜索结果中的 id。");
        const asset = service.read(context, input.id);
        if (!asset) return reply("该知识取不到：已停用、已不适用于当前任务或不存在；不要沿用旧结论。");
        const start = Math.max(1, input.start_line ?? 1), lines = asset.content.split("\n");
        options.onUse?.({ moment: "expand", ids: [asset.id] });
        return reply(`${asset.title}\n范围：${asset.scope}\n文档修订：${asset.revision}（不是产品版本）\n`
          + `产品版本：${asset.productVersions.join("、") || "未单独声明，请核对正文"}\n`
          + `适用条件：${asset.whenToUse}\n共 ${lines.length} 行，从 ${start} 行开始：\n`
          + lines.slice(start - 1, start + 119).map((line, i) => `${start + i}: ${line}`).join("\n").slice(0, 16000),
          { id: asset.id, revision: asset.revision, total_lines: lines.length, start_line: start });
      } catch {
        return reply("知识读取暂不可用；继续当前任务，不反复重试等待。");
      }
    },
  });
}
