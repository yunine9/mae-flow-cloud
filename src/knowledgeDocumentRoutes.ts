import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import { readKnowledgeDocument, saveKnowledgeDocument } from "./knowledgeDocuments.ts";
import { knowledgeDocumentCatalog } from "./knowledgeDocumentCatalog.ts";

export async function knowledgeDocumentRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  const dir = service.options.dataDir, id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  try {
    if (request.method === "GET" && !id) {
      const catalog = knowledgeDocumentCatalog(dir);
      const documents = catalog.documents.map(({ content, ...doc }) => {
        const asset = catalog.assets.find(a => a.id === doc.id);
        return { ...doc, lines: content.split("\n").length, indexing: !doc.active ? { state: "disabled" }
          : asset ? service.getKnowledgeSearch().documentStatus(asset) : { state: "failed", error: "适用模块已停用，请调整范围。" } };
      });
      return json(response, 200, { documents });
    }
    if (request.method === "GET" && id) {
      const doc = knowledgeDocumentCatalog(dir).documents.find(d => d.id === id);
      if (!doc) throw new Error("知识已停用或不存在");
      return json(response, 200, doc);
    }
    if (request.method === "POST" && id && parts[2] === "search") {
      const body = await readBody(request, 8192), query = String(body.query ?? "").trim();
      if (!query || query.length > 4000) throw new Error("请输入具体问题（最多 4000 字）");
      if (!knowledgeDocumentCatalog(dir).documents.some(d => d.id === id && d.active)) throw new Error("知识已停用或不存在");
      return json(response, 200, await service.getKnowledgeSearch().searchDocument(id, query));
    }
    if (request.method === "POST" && id && parts[2] === "retry") {
      if (!knowledgeDocumentCatalog(dir).documents.some(d => d.id === id && d.active)) throw new Error("知识已停用或不存在");
      service.prepareKnowledgeIndex();
      return json(response, 202, { ok: true });
    }
    if (request.method === "POST" && (!id || parts.length === 2)) {
      const body = await readBody(request, 3 * 1024 * 1024);
      const previous = id ? readKnowledgeDocument(dir, id) : undefined;
      const input = { ...body, source: body.content !== undefined ? undefined : previous?.source };
      if (body.repository_import) {
        const { repository, branch, path } = body.repository_import;
        if (typeof repository !== "string" || typeof branch !== "string" || !branch.trim() || typeof path !== "string") throw new Error("请填写仓库、分支和文件路径");
        // Credentials come from the signed-in user's profile, never from a stored URL.
        if (repository.includes("://") && new URL(repository).password) throw new Error("仓库地址请勿包含密码或令牌");
        const fetched = await service.importKnowledgeFile(repository.trim(), branch.trim(), path.trim(), operator);
        input.content = fetched.content;
        input.title = body.title || path.split("/").at(-1);
        input.source = { repository: repository.trim(), branch: branch.trim(), path: path.trim(), revision: fetched.revision };
      }
      const doc = saveKnowledgeDocument(dir, input, operator, id);
      service.prepareKnowledgeIndex();
      return json(response, id ? 200 : 201, doc);
    }
    return json(response, 404, { error: "未知知识文档操作" });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "知识操作失败" });
  }
}
