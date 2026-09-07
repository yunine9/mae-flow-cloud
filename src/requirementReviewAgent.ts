import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  renderAnnotations,
  TASK_REQUIREMENT_ARTIFACT,
  REQUIREMENT_GRAPH_ARTIFACT,
  type Annotation,
} from "./annotations.ts";
import type { GateContract, GateDecision } from "./gateService.ts";
import type { RequirementDocumentMeta } from "./requirementDocument.ts";
import { materializeRequirementAssets } from "./requirementBundle.ts";
import { isReviewAssetPath, materializeReviewAssets } from "./reviewAssets.ts";

export const REQUIREMENT_REVIEW_DOCUMENT = "requirement.md";
export const REQUIREMENT_REVIEW_RECEIPTS = "receipts.json";

/** 分析开始后原文是输入基线；后续意见落实到分析产物或实现。 */
export function requirementAnnotationInstructions(annotations: Annotation[]): string | undefined {
  const instructions: string[] = [];
  if (annotations.some((item) => item.artifact === TASK_REQUIREMENT_ARTIFACT)) {
    instructions.push("需求文档已经确认并锁定。不要修改需求文档；请把这条"
      + "检视意见落实到当前分析产物、方案或后续实现中，并逐条说明处理结果。");
  }
  if (annotations.some((item) => item.artifact === REQUIREMENT_GRAPH_ARTIFACT)) {
    instructions.push("这些意见直接锚在模块拆分图上。不要只改图或只改说明："
      + "请同步修订 CHAIN 文档与 requirement-graph.json，为两份产物换用"
      + "同一个全新 plan_revision，最后重新计算并写入 chain_sha256。"
      + "方案级意见作用于整体切法，模块级意见作用于指定模块，依赖级意见"
      + "作用于指定边；如果人的意见仍有多种会导致不同拆法的理解，再用一张"
      + "明确的问题卡说明差异，否则按最直接的理解落实。");
  }
  return instructions.length ? instructions.join("\n\n") : undefined;
}

/** 修订副本保留原文中的图片路径，必须由宿主把附件一并准备好。 */
export function prepareRequirementReviewWorkspace(
  taskWorkspace: string,
  reviewRoot: string,
  requirement: string,
  meta: RequirementDocumentMeta | undefined,
): void {
  mkdirSync(reviewRoot, { recursive: true });
  writeFileSync(join(reviewRoot, REQUIREMENT_REVIEW_DOCUMENT), requirement,
    { encoding: "utf-8", mode: 0o600 });
  materializeRequirementAssets(taskWorkspace, reviewRoot, meta);
  // 图片是本轮输入；复制失败由修订会话报告失败，不让 Agent 猜图或用 Bash 补救。
  materializeReviewAssets(taskWorkspace, reviewRoot);
}

function denied(reason: string): GateDecision {
  return { action: "deny", reason };
}

function relativeTarget(workspace: string, value: string): string {
  const target = resolve(workspace, value.replaceAll("\\", "/"));
  return relative(workspace, target).split(sep).join("/");
}

/**
 * 需求原文返工是一个最小权限的文件编辑会话：正文只能 Edit，回执只能
 * Write。尤其不能用 Write 重放整篇正文——长文会再次退化成受模型输出
 * 上限约束的传输协议，也可能用半截输出覆盖一份完整原文。
 */
export function createRequirementReviewGateContract(
  workspace: string,
  meta?: RequirementDocumentMeta,
): GateContract {
  const requirementImages = new Set(meta?.assets?.map((asset) => asset.path));
  return (tool, value) => {
    if (tool === "Bash") {
      return denied(
        "需求原文修改不需要执行命令。请停止调用 Bash，只用 Read/Edit 修改 "
        + `${REQUIREMENT_REVIEW_DOCUMENT}，再用 Write 写 ${REQUIREMENT_REVIEW_RECEIPTS}。`,
      );
    }
    const target = relativeTarget(workspace, value);
    if (tool === "Read") {
      return target === REQUIREMENT_REVIEW_DOCUMENT
          || target === REQUIREMENT_REVIEW_RECEIPTS
          || isReviewAssetPath(target) || requirementImages.has(target)
        ? { action: "allow" }
        : denied(`本会话只允许读取 ${REQUIREMENT_REVIEW_DOCUMENT}、回执和需求附图，已阻止：${value}`);
    }
    if (tool === "Edit" || tool === "MultiEdit") {
      return target === REQUIREMENT_REVIEW_DOCUMENT
        ? { action: "allow" }
        : denied(`本会话只允许编辑 ${REQUIREMENT_REVIEW_DOCUMENT}，已阻止：${value}`);
    }
    if (tool === "Write") {
      return target === REQUIREMENT_REVIEW_RECEIPTS
        ? { action: "allow" }
        : denied(
          `禁止用 Write 覆盖需求原文；只可用 Edit 修改 ${REQUIREMENT_REVIEW_DOCUMENT}。`
          + `Write 只用于 ${REQUIREMENT_REVIEW_RECEIPTS}。`,
        );
    }
    return undefined;
  };
}

/** 使命只带意见和文件名，不再把整篇正文塞进一问一答。 */
export function requirementReviewMission(input: {
  annotations: Annotation[];
  ticket: string;
}): string {
  return [
    "你是需求文档编辑 Agent，只负责落实本轮人工检视意见。",
    "当前工作目录包含本轮可编辑副本、回执和只读图片附件。",
    `需求文档：${REQUIREMENT_REVIEW_DOCUMENT}`,
    `逐条回执：${REQUIREMENT_REVIEW_RECEIPTS}`,
    "正文和意见引用的图片已由宿主按原相对路径准备；有 inspect_image 时用它查看，否则用 Read。不要修改图片或用 Bash 复制文件。图片缺失或无法识别时如实记录 needs_clarification，不得猜测图片内容。",
    "",
    "请这样处理：",
    `1. 用 Read 按意见里的行号和原文定位读取 ${REQUIREMENT_REVIEW_DOCUMENT}；文档很长时分段读，不要把全文复述到回复里。`,
    `2. 用 Edit 修改 ${REQUIREMENT_REVIEW_DOCUMENT}。只改意见指向的内容；未被意见要求改变的段落必须保留。禁止用 Write 重写整篇文档。`,
    "3. 意见明确就直接改；确实不同意或存在歧义时保留原文，不要猜。",
    `4. 最后用 Write 创建 ${REQUIREMENT_REVIEW_RECEIPTS}，内容必须是 JSON 数组，且每个意见 id 恰好一条：`,
    '[{"annotation_id":"<id>","outcome":"fixed|not_fixed|needs_clarification","summary":"改了什么或为什么没改","evidence":["requirement.md:行号"]}]',
    "fixed 只用于已经真正落到文件里的修改；summary 必须是人能复核的一两句话（不能只写「已处理」），且必须带 evidence 指出改在哪一行。",
    "写完回执就收口。最终回复只需简要说明完成情况，不要输出完整文档或回执 JSON。",
    "",
    "## 本轮人工检视意见",
    renderAnnotations(input.annotations, input.ticket),
  ].join("\n");
}
