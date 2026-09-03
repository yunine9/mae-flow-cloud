/**
 * 记忆的起草与目录摘要(docs/knowledge-memory-design.md §5、§8-3)。
 *
 * 两个便宜的单发模型调用,都无工具、都带预算、都有确定性兜底:
 * - **起草 trigger/scope**:入库那一刻先用模板落盘,这里事后补一句更像人话
 *   的「什么情况下」,并判断范围:one_off(这单特有,只进全文检索)/
 *   local(同一处再改时有用)/ general(全仓通用)。依据不只是意见原文,
 *   还有回执与改动路径——只看原文分不出"这次手滑"和"这里的规矩"。
 * - **目录摘要**:一个目录攒到十几条记忆后,首改目录时把 15 条全推等于没推;
 *   压成一段摘要,明细留给 corpus_search。缓存按成员 id 集合命中。
 *
 * 解析纪律:模型输出不合形状一律按失败处理,模板/确定性兜底顶上;
 * 绝不把一段自由文本当 scope 塞进索引。
 */

import type { MemoryRecord, MemoryScope } from "./taskMemory.ts";
import { MEMORY_TRIGGER_LIMIT } from "./taskMemory.ts";

export const MEMORY_DRAFT_BUDGET_MS = 10_000;
export const MEMORY_DIGEST_BUDGET_MS = 10_000;
/** 单目录超过这个数就推摘要不推明细(§13)。 */
export const MEMORY_DIGEST_THRESHOLD = 15;

const SCOPES: MemoryScope[] = ["one_off", "local", "general"];

export function buildMemoryDraftPrompt(record: MemoryRecord): { system: string; user: string } {
  const system = [
    "你在为一个软件团队的任务记忆库做整理。一条记忆是一个已经闭环的事实:",
    "有人在代码或文档的某处提了意见,Agent 改了,人确认通过;或者构建失败后修好了。",
    "你要做两件事,只回 JSON,不要解释:",
    '{"trigger": "<什么情况下该想起这条,一句话,动作锚定,不超过 40 字>",',
    ' "scope": "one_off" | "local" | "general"}',
    "scope 判断标准:",
    "- one_off:只对这一单成立(如临时数据、这次的手滑、与需求绑定的取舍),下一单改到同一处也用不上。",
    "- local:改到同一个文件/目录时才有用(这里的约定、这块的坑)。",
    "- general:改这个仓库任何地方都可能用到的规矩(命名、提交、依赖、安全底线)。",
    "拿不准时选 local。trigger 用中文,以「改/加/修/写…时」这类动作开头。",
  ].join("\n");
  const user = [
    `来源:${record.source} / 判定者:${record.judged_by}`,
    `位置:${record.paths.join(", ") || "(无路径)"}${record.line ? `:${record.line}` : ""}`,
    record.phase ? `阶段:${record.phase}` : "",
    record.quote ? `原文:\n${record.quote.slice(0, 600)}` : "",
    record.problem ? `问题:\n${record.problem.slice(0, 800)}` : "",
    `结论:\n${record.conclusion.slice(0, 800)}`,
    `现在的模板 trigger:${record.trigger}`,
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

/** 模型回复 → {trigger, scope};形状不对返回 undefined,调用方按起草失败处理。 */
export function parseMemoryDraft(text: string): { trigger: string; scope: MemoryScope } | undefined {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const trigger = String((parsed as { trigger?: unknown }).trigger ?? "")
    .replace(/\s+/g, " ").trim();
  const scope = (parsed as { scope?: unknown }).scope;
  if (!trigger || trigger.length > MEMORY_TRIGGER_LIMIT) return undefined;
  if (!SCOPES.includes(scope as MemoryScope)) return undefined;
  return { trigger, scope: scope as MemoryScope };
}

/** 摘要缓存键:成员 id 集合的稳定串。成员变了就重做,没变就复用。 */
export function digestKey(rows: Array<Pick<MemoryRecord, "id">>): string {
  return rows.map((row) => row.id).sort().join(",");
}

export function buildDirectoryDigestPrompt(
  dir: string,
  rows: MemoryRecord[],
): { system: string; user: string } {
  const system = [
    "你在为一个软件团队的任务记忆库写目录摘要。下面是同一个目录里积累的历史记忆,",
    "每条都是闭环过的事实(意见被改并确认,或构建失败被修好)。",
    "把它们压成一段给编码 Agent 看的摘要:不超过 8 行、每行一条要点,合并重复、去掉一次性的,",
    "每条要点末尾用括号带上最相关的一两个记忆 id。只输出摘要正文,不要标题、不要解释。",
    "措辞是线索不是命令:写「有人要求过 X」,不写「必须 X」。",
  ].join("\n");
  const user = [
    `目录:${dir || "仓库根"}(共 ${rows.length} 条)`,
    ...rows.map((row) => `- (${row.id}) [${row.judged_by === "human" ? "人确认" : "流水线"}`
      + ` · ${row.at.slice(0, 10)} · ${row.paths[0] ?? ""}] ${row.trigger}:`
      + `${row.conclusion.replace(/\s+/g, " ").slice(0, 200)}`),
  ].join("\n");
  return { system, user };
}

/** 确定性兜底摘要:按权重取前几条,其余只报数。 */
export function renderDirectoryDigestFallback(
  dir: string,
  rows: MemoryRecord[],
  top = 5,
): string {
  const head = rows.slice(0, top).map((row) =>
    `- ${row.trigger}:${row.conclusion.replace(/\s+/g, " ").slice(0, 120)}(${row.id})`);
  const rest = rows.length - head.length;
  return [
    ...head,
    rest > 0 ? `- 另有 ${rest} 条,用 corpus_search 带 path_prefix=${dir || "."} 查明细。` : "",
  ].filter(Boolean).join("\n");
}

/** 模型摘要的形状校验:非空、不超 12 行、至少引用一个真实 id;否则用兜底。 */
export function parseDirectoryDigest(text: string, rows: MemoryRecord[]): string | undefined {
  const body = String(text ?? "").trim();
  if (!body) return undefined;
  const lines = body.split("\n").filter((line) => line.trim());
  if (lines.length > 12 || body.length > 1600) return undefined;
  const ids = new Set(rows.map((row) => row.id));
  const cited = body.match(/c-[a-z0-9]+-[a-f0-9]+/g) ?? [];
  if (!cited.some((id) => ids.has(id))) return undefined;
  return lines.join("\n");
}
