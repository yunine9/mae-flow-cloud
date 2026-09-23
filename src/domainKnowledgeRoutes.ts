import { generatedAgentRules } from "./knowledgeCleanup.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { TaskService } from "./taskService.ts";
import { readKnowledgeMaterial, saveKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";

export async function domainKnowledgeRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  try {
    const materialRoot = join(service.options.dataDir, "knowledge-materials");
    if (parts[0] === "knowledge-materials") {
      if (request.method === "POST" && !parts[1]) {
        const body = await readBody(request, 29 * 1024 * 1024), controller = new AbortController();
        const abort = () => controller.abort(); response.once("close", abort);
        try { const { sections, ...material } = await saveKnowledgeMaterial(materialRoot, body, controller.signal); return json(response, 201, { ...material, sections: sections.length }); }
        finally { response.removeListener("close", abort); }
      }
      if (request.method === "GET" && parts[1]) return json(response, 200, readKnowledgeMaterial(materialRoot, parts[1]));
    } else {
      const manager = service.getDomainKnowledgeExtraction();
      if (request.method === "GET") return json(response, 200, parts[1] ? manager.get(parts[1]) : { records: manager.list(), knowledge_target: readKnowledgeRepoConfig(service.options.dataDir) ?? null });
      if (request.method === "POST") {
        const body = await readBody(request, 3 * 1024 * 1024);
        if (!parts[1]) return json(response, 202, manager.create(body, operator));
        const id = parts[1];
        if (parts[2] === "source-cleanup") return json(response, 200, await manager.sourceCleanupAction(id, parts[3], body, operator));
        if (parts[2] === "cleanup-template") {
          const job = manager.get(id), target = [job.knowledge_target, ...job.repositories].find(t => t.id === body.target_id);
          if (!target) throw new Error("请选择规范文件的目标仓");
          return json(response, 200, { content: generatedAgentRules(job, target, String(body.path || "AGENTS.md")) });
        }
        if (parts[2] === "cleanup-preview") return json(response, 200, await manager.previewCleanup(id, body.target_id, body, operator));
        if (parts[2] === "cleanup-confirm") return json(response, 200, manager.confirmCleanup(id, body.plan_id, body.confirmed, body.preserve_paths));
        if (parts[2] === "issue") return json(response, 200, manager.setIssueNumber(id, body.issue_no));
        if (parts[2] === "archive-targets") return json(response, 200, manager.configureArchive(id, body));
        if (parts[2] === "run") return json(response, 202, manager.run(id, body, operator));
        if (parts[2] === "resume") return json(response, 202, manager.resume(id, operator, body.use_latest_skill === true));
        if (parts[2] === "stop") return json(response, 200, manager.stop(id));
        if (parts[2] === "delete") return json(response, 200, manager.remove(id, operator));
        if (parts[2] === "edit") return json(response, 200, manager.edit(id, body, operator));
        if (parts[2] === "proposal") return json(response, 200, manager.decide(id, body.turn_id, body.document_id, body.decision, operator));
        if (parts[2] === "restore") return json(response, 200, manager.restore(id, body.document_id, body.revision, body.base_revision, operator));
        if (parts[2] === "selection") return json(response, 200, manager.select(id, body.ids, body.selected));
        if (parts[2] === "remote") return json(response, 200, await manager.readRemote(id, body.document_id, operator));
        if (parts[2] === "reconcile") return json(response, 200, manager.reconcile(id, body, operator));
        if (parts[2] === "publish") return json(response, 200, await manager.publish(id, operator));
        if (parts[2] === "refresh") return json(response, 200, await manager.refresh(id, operator));
      }
    }
    return json(response, 404, { error: "未知知识萃取操作" });
  } catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : "知识萃取操作失败" }); }
}
