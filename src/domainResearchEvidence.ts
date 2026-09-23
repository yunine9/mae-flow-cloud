import { createHash } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function isBusinessKnowledgeEvidence(event: Record<string, unknown>): boolean {
  return (event.tool === "business_knowledge" && event.action !== "ar_mr_diff" && event.status === "available")
    || (event.tool === "knowledge_material" && event.status === "returned");
}

export function knowledgeEvidenceTool(records: () => Array<Record<string, unknown>>) {
  return defineTool({ name: "knowledge_evidence", label: "回查业务资料证据",
    description: "按业务检索或上传资料返回的 evidence_id 回查原记录。业务检索原文按字符分页，start 从 1 开始、count 默认 8000，最多 16000；资料记录给出原始资料编号和章节/图片位置，再用 knowledge_material 读取原文。压缩或接续后无需猜测旧来源。",
    parameters: Type.Object({ evidence_id: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }),
    async execute(_id: string, params: { evidence_id: string; start?: number; count?: number }) {
      const event = records().find(e => e.evidence_id === params.evidence_id && isBusinessKnowledgeEvidence(e));
      if (!event) return { content: [{ type: "text" as const, text: "该证据不在本次研究已读取的业务资料中" }], details: {}, isError: true };
      const { result, ...location } = event;
      const text = result === undefined ? "" : typeof result === "string" ? result : JSON.stringify(result);
      const start = params.start ?? 1, count = params.count ?? 8000;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...location, ...(text ? { content: text.slice(start - 1, start - 1 + count), total_characters: text.length,
        next_start: start + count <= text.length ? start + count : undefined } : {}) }) }], details: {} };
    },
  });
}

/** 为实际返回的业务资料分配引用编号；相同资料重复读取沿用编号。 */
export function businessKnowledgeEvidenceId(event: Record<string, unknown>): string | undefined {
  if (!isBusinessKnowledgeEvidence(event)) return undefined;
  const source = event.tool === "business_knowledge"
    ? [event.tool, event.action, event.query, event.result]
    : [event.tool, event.material_id, event.digest, event.locations, event.image_path];
  return `knowledge-evidence-${createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 24)}`;
}
