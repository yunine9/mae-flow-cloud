import { readConsolidationAudit, readConsolidationSource } from "./knowledgeConsolidationAudit.ts";
import { exportKnowledge } from "./knowledgeExport.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TaskService } from "./taskService.ts";
import { readKnowledgeDocument, saveKnowledgeDocument, listKnowledgeDocuments, type KnowledgeDocument } from "./knowledgeDocuments.ts";
import { knowledgeDocumentCatalog } from "./knowledgeDocumentCatalog.ts";

export async function knowledgeDocumentRoute(request: IncomingMessage, response: ServerResponse, parts: string[], service: TaskService,
  operator: string, readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  const dir = service.options.dataDir, id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  try {
    if (id === "consolidation") {
      const manager=service.getKnowledgeConsolidation();
      if(request.method==="GET") {
        if(parts[2]==="jobs" && parts[3]) {
          if(parts[4]==="source"&&parts.length===7)return json(response,200,readConsolidationSource(dir,parts[3],parts[5],decodeURIComponent(parts[6])));
          if(parts.length===4)return json(response,200,readConsolidationAudit(dir,parts[3]));
          return json(response,404,{error:"未知记录操作"});
        }
        return json(response,200,manager.view());
      }
      if(request.method==="POST") {
        const body=await readBody(request,3*1024*1024);
        const action=parts[2];
        if(action==="run"||action==="retry")return json(response,202,manager.start(operator));
        if(action==="stop")return json(response,200,manager.stop());
        if(action==="settings")return json(response,200,manager.settings(body,operator));
        if(parts[3]&&["edit","adopt","discard","withdraw"].includes(parts[3]))return json(response,200,manager.act(action,parts[3],body,operator));
      }
      return json(response,404,{error:"未知知识整理操作"});
    }
    if (request.method === "POST" && id === "export" && parts.length === 2) {
      const body = await readBody(request, 256 * 1024);
      const archive = exportKnowledge(dir, body.ids);
      response.writeHead(200, {"Content-Type":"application/zip", "Content-Disposition":"attachment; filename=mae-knowledge.zip", "Cache-Control":"no-store", "Content-Length":archive.length});
      response.end(archive);
      return;
    }
    if (request.method === "POST" && id === "search" && parts.length === 2) {
      const body = await readBody(request, 8192), query = String(body.query ?? "").trim();
      if (!query || query.length > 4000) throw new Error("请输入具体问题（最多 4000 字）");
      const result = await service.getKnowledgeSearch().searchLibrary(query);
      const catalog = knowledgeDocumentCatalog(dir);
      return json(response, 200, { ...result, hits: result.hits.map(hit => {
        const doc = catalog.documents.find(d => d.id === hit.id);
        return { ...hit, source: doc && "source" in doc ? doc.source : undefined, technologies: doc?.technologies ?? [] };
      }) });
    }
    if (request.method === "POST" && ["repository-tree", "repository-import"].includes(id ?? "")) {
      const body = await readBody(request, 256 * 1024);
      const { repository, branch, revision, paths } = body;
      if (typeof repository !== "string" || typeof branch !== "string" || !branch.trim()) throw new Error("请填写仓库与分支");
      const importing = id === "repository-import";
      if (importing && (typeof revision !== "string" || !/^[a-f0-9]{40,64}$/.test(revision)
        || !Array.isArray(paths) || paths.some(p => typeof p !== "string"))) throw new Error("请先读取文件树并勾选文档");
      const tree = await service.importKnowledgeTree(repository.trim(), importing ? revision : branch.trim(), importing ? paths : undefined, operator);
      if (!importing) return json(response, 200, { revision: tree.revision, paths: tree.paths });
      const documents: KnowledgeDocument[] = [], errors = [...tree.errors];
      const same = (a: string[] = [], b: string[] = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      for (const entry of tree.files) {
        try {
          // Same source and applicability updates in place; same basename elsewhere stays separate.
          const previous = listKnowledgeDocuments(dir).find(d => d.source?.repository === repository.trim()
            && d.source.branch === branch.trim() && d.source.path === entry.path && d.scope === (body.scope ?? "platform")
            && same(d.module_ids, body.scope === "module" ? body.module_ids : [])
            && same(d.repositories, body.scope === "repository" ? body.repositories : [])
            && same(d.technologies, body.technologies) && same(d.product_versions, body.product_versions));
          documents.push(saveKnowledgeDocument(dir, { ...body, title: entry.path.split("/").at(-1), content: entry.content,
            source: { repository: repository.trim(), branch: branch.trim(), path: entry.path, revision: tree.revision } }, operator, previous?.id));
        } catch (error) { errors.push({path:entry.path,error:error instanceof Error ? error.message : "保存失败"}); }
      }
      service.prepareKnowledgeIndex();
      return json(response, 200, { documents, errors });
    }
    if (request.method === "GET" && !id) {
      const catalog = knowledgeDocumentCatalog(dir);
      const documents = catalog.documents.map(({ content, ...doc }) => {
        const asset = catalog.assets.find(a => a.id === doc.id);
        return { ...doc, lines: content.split("\n").length, indexing: doc.form === "skill" ? { state: "native" } : !doc.active ? { state: "disabled" }
          : asset ? service.getKnowledgeSearch().documentStatus(asset) : catalog.sourceIds.has(doc.id) ? { state: "source", error: "原始资料保留；检索使用已采纳专题或当前有效来源。" } : { state: "failed", error: "适用模块已停用，请调整范围。" } };
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
      if (!knowledgeDocumentCatalog(dir).documents.some(d => d.id === id && d.active && d.form !== "skill")) throw new Error("该资料不可检索；Skill 通过原生技能机制加载");
      return json(response, 200, await service.getKnowledgeSearch().searchDocument(id, query));
    }
    if (request.method === "POST" && id && parts[2] === "retry") {
      if (!knowledgeDocumentCatalog(dir).documents.some(d => d.id === id && d.active && d.form !== "skill")) throw new Error("知识已停用或不存在");
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
