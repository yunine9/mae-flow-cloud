import { createHash } from "node:crypto";
import type { Scene } from "../src/scriptedModel.ts";
export function componentPipelineScript(repositoryId: string, path: string, revision: string, callerContent: string) {
  const script: Scene[] = [], offsets: Record<string, number> = {};
  const call = (name: string, input: Record<string, unknown>) => script.push({ tool: { name, input } });
  const usage = `everycode-${createHash("sha256").update(JSON.stringify(["consumer", "src/use.cpp", 1, 30, callerContent])).digest("hex").slice(0, 24)}`;
  for (const [id, phase] of [["inventory", "inventory"], ["plan-pool", "plan"], ["contracts-pool", "contracts"], ["paradigm-pool-submit", "paradigm"], ["pitfalls-pool", "pitfalls"], ["index-pool", "index"], ["synthesis", "synthesis"]]) {
    offsets[id] = script.length;
    call("extraction_skill", { path: "references/api-boundary.md" });
    call("component_source", { action: "read", component_id: repositoryId, path, start: 1, end: 1 });
    call("code_search", { action: "kw", query: "Close" });
    call("code_search", { action: "read", repository: "consumer", path: "src/use.cpp", start: 1, end: 30 });
    const writes = !["inventory", "plan", "synthesis"].includes(phase);
    if (writes) call("research_document", { action: "section", section: { id, title: id, repository_ids: [repositoryId], content: "明确资源释放顺序", interfaces: "Close", integration: "真实依赖", example: "未编译\n```cpp\nClose(handle);\n```", related_ids: [], paradigm: {
      kind: phase, component: "pool", language: "cpp", status: "recommended", need: "安全释放资源", api: ["Close"], applicability: "本次版本", replaces: { identifiers: [], imports: [], patterns: [] },
      evidence: [{ repository_id: repositoryId, path, revision, start: 1, end: 1 }], usage_evidence: [usage], open_questions: [],
    } } });
    if (phase === "synthesis") call("research_document", { action: "overview", overview: "组件选择和使用指南" });
    call("component_work_result", { findings: `核对 \`${repositoryId}:${path}:1\``, open_questions: [],
      ...(phase === "inventory" ? { components: [{ id: "pool", title: "资源管理", repository_ids: [repositoryId], scope: path }] } : {}),
      ...(phase === "plan" ? { paradigms: [{ id: "submit", title: "释放资源", need: "安全释放" }] } : {}) });
    script.push({ text: "本项已完成" });
    call("extraction_skill", { path: "references/api-boundary.md" });
    call("component_source", { action: "read", component_id: repositoryId, path, start: 1, end: 1 });
    call("research_document", { action: "read", ...(writes ? { id } : {}) });
    if (writes) call("component_work", { evidence_id: usage });
    call("component_work_result", { pass: true, feedback: "已回查源码与真实调用" });
    script.push({ text: "评审完成" });
  }
  return { script, offsets };
}
