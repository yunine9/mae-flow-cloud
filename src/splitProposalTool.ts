/**
 * Agent 在开发中提议拆分(docs/delivery-unit-split-design.md 2026-09-03
 * 勘误):拆不拆是分析的产物,不是下单时的开关——下单的人在信息最少的
 * 时刻判断"大不大"判不准,读完仓的 Agent 才判得准。
 *
 * 工具只做一件事:把"为什么一个 MR 装不下、建议怎么切"交给宿主;宿主
 * 受理后终止当前会话,把本单转成分析拆分单重新启动(澄清→盘点→划分
 * 方向卡→方案→人工确认→按单元建子任务)。受理与拒绝都用一句人话回给
 * 模型,拒绝不抛错。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface SplitProposalInput {
  reason: string;
  suggested_units?: string[];
}

export function createSplitProposalTool(
  onPropose: (input: SplitProposalInput) => string,
) {
  return defineTool({
    name: "propose_split",
    label: "Propose Split",
    description:
      "本单是单仓直接开发任务。你在澄清需求或定规格阶段读完仓、盘出改动面后,"
      + "如果判断改动面大到一个人没法负责任地检视一个 MR(经验线:要动的既有"
      + "位置十来处以上,或横跨互不相关的模块),用它把本单转为「先分析再拆分」:"
      + "平台会终止当前会话,以只读分析现场重新启动,走澄清→改动面盘点→划分"
      + "方向卡→拆分方案→人工确认,再按交付单元生成子任务。调用前不要开始改"
      + "代码;已有推送或 MR 的任务不能再转。",
    promptSnippet: "propose_split:改动面大到一个 MR 装不下时,把本单转为先分析再拆分",
    promptGuidelines: [
      "澄清需求或定规格阶段读完仓、盘出改动面后,如果要动的既有位置多到一个人"
      + "没法负责任地检视一个 MR,在写任何代码之前调用 propose_split;受理后"
      + "立即结束本轮发言,不要再调用任何工具。",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "为什么该拆:列出改动面(要动哪些既有位置、新增哪些模块),说清一个 MR 为什么装不下" }),
      suggested_units: Type.Optional(Type.Array(Type.String(), {
        description: "建议的切法,每项一句话(第一块通常是契约骨架);拿不准可以不给" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const text = onPropose({
        reason: String(params.reason ?? ""),
        suggested_units: Array.isArray(params.suggested_units)
          ? params.suggested_units.map((item: unknown) => String(item)) : undefined,
      });
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
