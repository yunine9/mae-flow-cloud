/**
 * 给 Agent 的记忆检索工具(docs/knowledge-memory-design.md §8)。
 *
 * 宿主替 Agent 在三个时刻推送记忆;这两个工具只给它追问用——不指望它
 * 记得主动查,所以 promptGuidelines 写的是动作锚定的触发("改一个没改过的
 * 目录之前"),不是"需要时使用"。
 *
 * 边界:repo 由宿主按任务固定,Agent 传不了;结果封顶;检索不可用时如实
 * 说"暂不可用",绝不空转等待(sidecar 自带预算)。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemorySearchHit } from "./memorySidecar.ts";

export interface MemoryToolBackend {
  repo: string;
  search(input: { query: string; pathPrefix?: string; limit?: number })
    : Promise<MemorySearchHit[] | undefined>;
  expand(memoryId: string): Promise<string | undefined>;
  /** 足迹:查了什么、命中了谁、展开了哪条。旁路,回调自己兜错。 */
  onUse?(event: { moment: "search" | "expand"; query?: string; ids: string[] }): void;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function renderMemoryHits(hits: MemorySearchHit[]): string {
  if (!hits.length) return "没有命中的记忆。";
  return hits.map((hit) => {
    const who = hit.judged_by === "human" ? "人确认" : "流水线";
    const where = hit.paths?.[0]
      ? `${hit.paths[0]}${hit.line ? `:${hit.line}` : ""}` : "本仓";
    const when = (hit.at ?? "").slice(0, 10);
    const snippet = (hit.snippet ?? "").replace(/^##\s*\S+\s*/, "")
      .replace(/\s+/g, " ").slice(0, 200);
    return `- (${hit.id}) [${who}${when ? ` · ${when}` : ""} · ${where}] ${snippet}`;
  }).join("\n");
}

export function createMemoryTools(backend: MemoryToolBackend) {
  const search = defineTool({
    name: "corpus_search",
    label: "Corpus Search",
    description:
      "检索本仓的任务记忆:过去的单子里被人或流水线关掉的环(闭环的检视意见、"
      + "修好的构建失败、人圈选记下的约定)。返回最多 8 条,每条带记忆 id、"
      + "判定者、日期、位置和一句结论。它们是线索不是规则,与现状冲突以现状和"
      + "内核指令为准。想看整条记录用 corpus_expand。",
    promptSnippet: "corpus_search:查本仓历史记忆(闭环意见/构建坑/人记下的约定)",
    promptGuidelines: [
      "改一个本会话还没改过的目录之前、修一个报错之前、对某个约定拿不准的时候,"
      + "先用 corpus_search 查这个仓的历史记忆;结果里的 id 可用 corpus_expand 看全文。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "用自然语言描述你在做什么或卡在哪" }),
      path_prefix: Type.Optional(Type.String({
        description: "只看这个路径前缀下的记忆,如 src/main/java/com/x/filter" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    async execute(_toolCallId: string, params: any) {
      const query = String(params.query ?? "").trim();
      if (!query) return ok("query 不能为空。");
      const hits = await backend.search({
        query,
        pathPrefix: params.path_prefix ? String(params.path_prefix) : undefined,
        limit: Math.min(Number(params.limit ?? 8) || 8, 8),
      });
      if (!hits) {
        return ok("记忆检索暂不可用(旁路进程未就绪或超时);按现状继续,不要重试等待。");
      }
      backend.onUse?.({ moment: "search", query, ids: hits.map((hit) => hit.id) });
      return ok(renderMemoryHits(hits));
    },
  });

  const expand = defineTool({
    name: "corpus_expand",
    label: "Corpus Expand",
    description: "按记忆 id 取整条记录(什么情况下 / 原文 / 问题 / 结论)。",
    parameters: Type.Object({
      memory_id: Type.String({ description: "corpus_search 结果里的 id,如 c-xxxx-xxxxxx" }),
    }),
    async execute(_toolCallId: string, params: any) {
      const id = String(params.memory_id ?? "").trim();
      if (!/^c-[a-z0-9]+-[a-f0-9]+$/.test(id)) return ok("memory_id 形状不对。");
      const content = await backend.expand(id);
      if (!content) return ok(`记忆 ${id} 取不到(不存在或检索暂不可用)。`);
      backend.onUse?.({ moment: "expand", ids: [id] });
      return ok(content);
    },
  });

  return [search, expand];
}
