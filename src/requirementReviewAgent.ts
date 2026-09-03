import { relative, resolve, sep } from "node:path";
import {
  renderAnnotations,
  type Annotation,
} from "./annotations.ts";
import type { GateContract, GateDecision } from "./gateService.ts";

export const REQUIREMENT_REVIEW_DOCUMENT = "requirement.md";
export const REQUIREMENT_REVIEW_RECEIPTS = "receipts.json";

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
): GateContract {
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
        ? { action: "allow" }
        : denied(`本会话只允许读取 ${REQUIREMENT_REVIEW_DOCUMENT} 和回执文件，已阻止：${value}`);
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
    "当前工作目录里只有本轮可编辑副本和宿主账本。",
    `需求文档：${REQUIREMENT_REVIEW_DOCUMENT}`,
    `逐条回执：${REQUIREMENT_REVIEW_RECEIPTS}`,
    "",
    "请这样处理：",
    `1. 用 Read 按意见里的行号和原文定位读取 ${REQUIREMENT_REVIEW_DOCUMENT}；文档很长时分段读，不要把全文复述到回复里。`,
    `2. 用 Edit 修改 ${REQUIREMENT_REVIEW_DOCUMENT}。只改意见指向的内容；未被意见要求改变的段落必须保留。禁止用 Write 重写整篇文档。`,
    "3. 意见明确就直接改；确实不同意或存在歧义时保留原文，不要猜。",
    `4. 最后用 Write 创建 ${REQUIREMENT_REVIEW_RECEIPTS}，内容必须是 JSON 数组，且每个意见 id 恰好一条：`,
    '[{"annotation_id":"<id>","outcome":"fixed|not_fixed|needs_clarification","summary":"改了什么或为什么没改","evidence":["requirement.md:行号"]}]',
    "fixed 只用于已经真正落到文件里的修改；summary 必须是人能复核的一两句话。",
    "写完回执就收口。最终回复只需简要说明完成情况，不要输出完整文档或回执 JSON。",
    "",
    "## 本轮人工检视意见",
    renderAnnotations(input.annotations, input.ticket),
  ].join("\n");
}
