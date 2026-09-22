import { KnowledgeExtractionSkills } from "./knowledgeExtractionSkills.ts";
import { knowledgeArchiveDefaults } from "./knowledgeArchiveDefaults.ts";
import { generatedAgentRules } from "./knowledgeCleanup.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import {
  componentRepositories,
  saveComponentRepository,
} from "./componentRepositories.ts";
export async function componentResearchRoute(
  request: IncomingMessage,
  response: ServerResponse,
  parts: string[],
  service: TaskService,
  operator: string,
  readBody: (r: IncomingMessage, limit?: number) => Promise<any>,
  json: (r: ServerResponse, status: number, value: any) => unknown,
) {
  try {
    if (parts[0] === "component-repositories") {
      if (request.method === "GET")
        return json(response, 200, {
          components: componentRepositories(service.options.dataDir),
        });
      if (request.method === "POST")
        return json(
          response,
          200,
          saveComponentRepository(
            service.options.dataDir,
            await readBody(request, 16384),
            operator,
          ),
        );
    } else {
      const research = service.getComponentResearch();
      if (parts[1] && parts[2] === "archive") {
        const record = research.get(parts[1]);
        if (record.deleted_at) throw new Error("萃取任务已删除");
        const manager = service.getDomainKnowledgeExtraction();
        const archive = manager.componentArchive(record.id);
        if (request.method === "GET") {
          const defaults = knowledgeArchiveDefaults(new KnowledgeExtractionSkills(service.options.dataDir).current("component").files, "component");
          const source = record.components?.[0] ?? record.component;
          return json(response, 200, { archive: archive ?? null, defaults: {
            repository: source?.repository ?? "", branch: source?.branch || "main",
            directory: defaults.component_directory, filename: defaults.component_filename,
          } });
        }
        if (request.method === "POST") {
          const body = await readBody(request, 24 * 1024 * 1024);
          if (!parts[3]) {
            const prepared = manager.prepareComponent({ ...body, ...research.archiveDraft(record.id, body) }, operator);
            return json(response, 200, await manager.readRemote(prepared.id, prepared.documents[0].id, operator));
          }
          if (!archive) throw new Error("请先准备归档文档");
          const id = archive.id;
          if (parts[3] === "cleanup-template") return json(response, 200, { content: generatedAgentRules(archive, archive.knowledge_target, String(body.path || "AGENTS.md")) });
          if (parts[3] === "cleanup-preview") return json(response, 200, await manager.previewCleanup(id, archive.knowledge_target.id, body, operator));
          if (parts[3] === "cleanup-confirm") return json(response, 200, manager.confirmCleanup(id, body.plan_id, body.confirmed, body.preserve_paths));
          if (parts[3] === "edit") return json(response, 200, manager.edit(id, body, operator));
          if (parts[3] === "remote") return json(response, 200, await manager.readRemote(id, body.document_id, operator));
          if (parts[3] === "reconcile") return json(response, 200, manager.reconcile(id, body, operator));
          if (parts[3] === "publish") return json(response, 200, await manager.publish(id, operator));
          if (parts[3] === "refresh") return json(response, 200, await manager.refresh(id, operator));
          if (parts[3] === "restore") return json(response, 200, manager.restore(id, body.document_id, body.revision, body.base_revision, operator));
        }
        throw new Error("未知组件归档操作");
      }
      if (request.method === "GET" && parts[1] && parts[2] === "document") {
        const content = research.markdown(parts[1]);
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="component-guide.md"', "cache-control": "no-store" });
        return response.end(content);
      }
      if (request.method === "POST" && parts[1] && ["edit-section", "proposal", "restore-section", "begin-update"].includes(parts[2])) {
        const body = await readBody(request, 3 * 1024 * 1024);
        const result = parts[2] === "edit-section" ? research.editSection(parts[1], body, operator)
          : parts[2] === "proposal" ? research.decideProposal(parts[1], body.turn_id, body.decision, operator)
          : parts[2] === "restore-section" ? research.restoreSection(parts[1], body.section_id, body.revision, body.base_revision, operator)
          : research.beginUpdate(parts[1], operator);
        return json(response, 200, result);
      }
      if (request.method === "POST" && parts[1] && parts[2] === "selection") {
        const input = await readBody(request, 1024 * 1024);
        return json(response, 200, research.selectSections(parts[1], input.ids, input.selected));
      }
      if (request.method === "POST" && parts[1] && parts[2] === "review") {
        return json(response, 202, research.review(parts[1], await readBody(request, 128 * 1024), operator));
      }
      if (request.method === "POST" && parts[1] && ["stop", "delete", "retry"].includes(parts[2])) {
        const result = parts[2] === "stop" ? research.stop(parts[1]) : parts[2] === "delete" ? research.remove(parts[1], operator) : research.retry(parts[1], operator);
        return json(response, 200, result);
      }
      if (request.method === "GET")
        return json(
          response,
          200,
          parts[1] ? research.get(parts[1]) : { records: research.list(true) },
        );
      if (request.method === "POST" && !parts[1])
        return json(
          response,
          202,
          research.start(await readBody(request, 8192), operator),
        );
      if (request.method === "POST" && parts[2] === "adopt")
        return json(
          response,
          200,
          research.adopt(
            parts[1],
            await readBody(request, 3 * 1024 * 1024),
            operator,
          ),
        );
    }
    return json(response, 404, { error: "未知组件知识操作" });
  } catch (error) {
    return json(response, 400, {
      error: error instanceof Error ? error.message : "组件知识操作失败",
    });
  }
}
