/** Agent 的仓库记忆检索、展开和主动记录。仓库由宿主固定，索引不可用不阻断正本读写。 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryScope } from "./taskMemory.ts";
import type { MemorySearchHit } from "./memorySidecar.ts";

export interface MemoryToolBackend {
  repo: string;
  write?(input: { trigger: string; conclusion: string; paths: string[]; scope: MemoryScope }, callId: string): Promise<{ id: string }> | { id: string };
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
    const who = hit.judged_by === "human" ? "人确认" : hit.judged_by === "agent" ? "Agent 记录" : hit.judged_by === "pipeline" ? "流水线" : "来源未注明";
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
      "检索本仓的任务记忆:闭环经验与主动记录(闭环的检视意见、"
      + "修好的构建失败、人或 Agent 记下的约定)。返回最多 8 条,每条带记忆 id、"
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

  const write = defineTool({
    name: "corpus_write", label: "记录仓库记忆",
    description: "保存当前仓库可复用的经验、构建方法或约定。直接入库，标记为 Agent 记录，不代表人工确认或验证通过。不存凭据、令牌或整段日志。仓库与任务来源由宿主固定。",
    parameters: Type.Object({
      trigger: Type.String({ minLength: 1, maxLength: 80, description: "什么情况下用这条经验" }),
      conclusion: Type.String({ minLength: 1, maxLength: 1900, description: "经验结论及适用条件；未验证的猜测请明确说明" }),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      scope: Type.Optional(Type.Union([Type.Literal("one_off"), Type.Literal("local"), Type.Literal("general")])),
    }),
    async execute(callId: string, params: any) {
      if (!backend.write) return ok("当前会话未配置记忆写入。");
      const record = await backend.write({ trigger: String(params.trigger ?? "").trim(),
        conclusion: String(params.conclusion ?? "").trim(), paths: params.paths ?? [],
        scope: params.scope ?? "local" }, callId);
      return ok(`已保存记忆 ${record.id}（Agent 记录）。可用 corpus_expand 读取；语义索引异步更新。`);
    },
  });
  return backend.write ? [search, expand, write] : [search, expand];
}
