/**
 * 检视账本(问题域,ADR-0007):用户对分析报告(issue-analysis.md)的
 * 检视意见。
 *
 * 存储与锚点整体复用需求流的 annotations.ts(AnnotationStore 的
 * append-only jsonl、坐标+原文快照+要求三元组、reanchor 四态检测)
 * ——同一套检视语义不许两份实现,artifact 恒为分析报告,清单渲染
 * 是唯一的分叉点:单文档、无逐文件分组,护栏原文沿用(它们是
 * 对着弱模型踩出来的契约,不在这儿各写各的)。
 *
 * 闭环刻意从简(ADR-0007):不做逐条回执与逐条裁决——锚点徽标
 * (reanchor 白送)+ 修订后的新版报告 + 分析确认卡上的整体把关。
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnnotationStore,
  orderAnnotations,
  reanchor,
  type AnchorCheck,
  type Annotation,
} from "../annotations.ts";
import { ANALYSIS_DOC_NAME } from "./documents.ts";

/** 检视账本落点(会话工作区根,与 events.jsonl 同层;GateService 的
 * 账本规则只守 issue.json 与 skills/,这里不设硬闸——Agent 改自己的
 * 意见清单骗不到用户,意见原文快照在事件账里另有凭据)。 */
export const REVIEWS_FILE = "reviews.jsonl";

/** 被检视报告的版本快照目录(子目录:顶层 .md 扫描是过程文档页签的
 * 清单,快照不能混进去当页签)。版本投影(analysisVersions.ts)以它为
 * 唯一边界:冻结版只准从这里读。 */
export const REVIEWS_DIR = "reviews";

export function reviewStore(root: string): AnnotationStore {
  return new AnnotationStore(join(root, REVIEWS_FILE));
}

/**
 * 下一个意见号(#261,ADR-0025):单个问题会话内自 1 单调递增、永不
 * 复用、跨批次连续。max 的口径是台账里的**全部历史 add 操作**——软删
 * 的、已送出的都继续占号。读侧口径(list/visible/drafts)都是过滤
 * 语义,哪天过滤规则变了也不能让已发出的号回填:删掉末条(号 5)再
 * 新增,新号必须是 6 不是 5,否则带号的回应会指错条。旧账(功能上线
 * 前)没有号,不占号:新号从 1 起编。
 */
function nextReviewNumber(store: AnnotationStore): number {
  let next = 1;
  for (const operation of store.history()) {
    if (operation.op === "add") {
      next = Math.max(next, (operation.record.seq ?? 0) + 1);
    }
  }
  return next;
}

export function addReview(
  root: string,
  input: { author: string; line: number; anchor: string; note: string; quote?: string; line_end?: number; context_before?: string; context_after?: string },
): Annotation {
  const store = reviewStore(root);
  return store.add({
    author: input.author,
    // artifact/file 恒为分析报告:问题域的检视对象只有它(ADR-0007)。
    artifact: ANALYSIS_DOC_NAME,
    file: ANALYSIS_DOC_NAME,
    line: input.line,
    anchor: input.anchor,
    quote: input.quote, line_end: input.line_end, context_before: input.context_before, context_after: input.context_after,
    note: input.note,
    kind: "doc",
    // 意见号在落账口分配(ADR-0025):台账 append-only,add 记录即
    // 凭据,号随条目永久稳定;展示与 AI 引用统一用「意见N」。
    seq: nextReviewNumber(store),
  });
}

export function dropReview(root: string, id: string, by: string): Annotation {
  return reviewStore(root).drop(id, by);
}

/** 送出前重锚定:意见清单 vs 当前分析报告。reanchor 的读取是注入的
 * (只认分析报告,其余 artifact 按 hit 放行)——需求流的产物扫描
 * 不被牵扯进来。 */
export function anchorChecks(root: string): AnchorCheck[] {
  const reviews = reviewStore(root).visible();
  let text: string | undefined;
  try {
    text = readFileSync(join(root, ANALYSIS_DOC_NAME), "utf-8");
  } catch {
    text = undefined;
  }
  return reanchor(reviews, (artifact) =>
    artifact === ANALYSIS_DOC_NAME ? text : undefined);
}

/** 提交检视:草稿清单 + 送出标记 + 被检视报告的版本快照。 */
export function submitReviews(root: string): Annotation[] {
  const store = reviewStore(root);
  const drafts = store.drafts();
  if (!drafts.length) return [];
  if (existsSync(join(root, ANALYSIS_DOC_NAME))) {
    // 版本快照(ADR-0007 Q10):agent 修订会整份重写报告,快照让意见
    // 锚定的原文永远可对照。写不进不挡提交(fail-open,意见本身带
    // 原文快照,损失的只是全文对照)。
    try {
      mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
      copyFileSync(
        join(root, ANALYSIS_DOC_NAME),
        join(root, REVIEWS_DIR,
          `issue-analysis@r${Date.now().toString(36)}.md`),
      );
    } catch {
      // 快照失败不挡检视。
    }
  }
  store.markSent(drafts.map((item) => item.id), "issue_review");
  // 送出态从台账重放取(不手拼字段):账本是唯一真相。
  const sentIds = new Set(drafts.map((item) => item.id));
  return orderAnnotations(store.list()
    .filter((item) => sentIds.has(item.id)));
}

/**
 * 渲染成给模型的意见清单。护栏与 annotations.ts 的 renderAnnotations
 * 同一份契约原文(逐条落实/只改这些/以原文定位/逐条回话);差异有三:
 * 抬头(单文档、意见数量)、问题域独有的「检视意见回应」段要求
 * (ADR-0025:修订版报告开头按意见号逐条答复,软性章节,不进五章节
 * 机械门票)与收尾(修订完重新 submit_analysis)。
 */
export function renderReviewNotes(
  items: Annotation[],
  title: string,
  round: number,
): string {
  const ordered = orderAnnotations(items);
  const lines: string[] = [
    `这是我人工检视《${title}》分析报告(issue-analysis.md)的结果,`
      + `共 ${ordered.length} 条意见。这是第 ${round} 轮分析——请按意见修订报告与方案。`,
    "",
    "几点要求:",
    "- 这是检视结论,不是征求意见。逐条落实,不要只回复\"已知悉\"。",
    "- 只按这些意见修订。确实要连带改别处,先说清为什么,再动。",
    "- 行号仅为历史参考。每条修改前读取当前文件，以原文为准定位，结合批注时上下文核对；处理上一条后重新核对后续位置，不沿用旧行号。",
    "- 找不到原文或匹配多处时先检查当前实现；无法确认就说明，不猜位置、不把原文消失当作已修复，可继续处理其他意见。",
    "- 逐条回我改了什么。有哪条你认为不该改,说明理由,别默默跳过。",
    // 意见号回应段(#261,ADR-0025):修订版报告开头按意见号逐条答复。
    // 靠提示词护栏执行,不进 submit_analysis 的五章节机械门票。
    "- 修订版报告的开头加一段「检视意见回应」:按意见号逐条答复,"
      + "写清每条改了什么/答了什么。未被采纳或仅是提问的意见也要逐条"
      + "给交代,不许漏号。",
    "",
  ];
  // 清单序号 = 意见号(#261):展示与 AI 引用统一用「意见N」,不再是批次
  // 内 1..N 重新编号——号跨批次连续,带号的回应才能在整个会话内唯一定位。
  // 旧账(功能上线前)没有号:按台账号之后的号续编兜底,不与台账号冲突。
  let fallback = Math.max(0, ...ordered.map((item) => item.seq ?? 0));
  for (const item of ordered) {
    const number = item.seq ?? (fallback += 1);
    // 稳定 id 沿用:它让用户与 Agent 能精确指回同一条意见,不靠猜。
    lines.push(`意见${number}. [${item.id}] 历史第 ${item.line} 行`);
    lines.push(`   批注时原文:${item.quote || item.anchor}`);
    if (item.context_before) lines.push(`   批注时前文:\n${item.context_before}`);
    if (item.context_after) lines.push(`   批注时后文:\n${item.context_after}`);
    lines.push(`   要求:${item.note}`);
  }
  lines.push("");
  lines.push("修订完成后重新 submit_analysis 提交,平台会再次举确认卡等用户过目。");
  return lines.join("\n");
}
