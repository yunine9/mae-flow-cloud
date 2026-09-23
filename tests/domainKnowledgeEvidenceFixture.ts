import { join } from "node:path";
import assert from "node:assert/strict";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";
import type { Scene } from "../src/scriptedModel.ts";

export async function businessMaterial(root: string, text = "业务决策：为避免月底结算期间重复扣款，已结算订单不能立即取消，须走冲正流程。历史评审明确这一限制。ORIGINAL_BUSINESS_CONTEXT") {
  const material = await saveKnowledgeMaterial(join(root, "knowledge-materials"), { name: "business-decisions.txt", content_base64: Buffer.from(text).toString("base64"), version: "业务评审 v1" });
  assert.equal(material.state, "ready", material.error); return material;
}

/** 剧本模型只复制真实工具响应中的资料引用编号，不伪造已读取证据。 */
export function useReturnedEvidence(request: Record<string, any>, scenes: Scene[]) {
  const ids = [...new Set(JSON.stringify(request.messages).match(/knowledge-evidence-[a-f0-9]{24}/g) ?? [])];
  for (const scene of scenes) {
    const record = (scene.tool?.input.capability ?? scene.tool?.input.report) as { evidence_ids?: string[] } | undefined;
    if (record) record.evidence_ids = ids;
  }
}
