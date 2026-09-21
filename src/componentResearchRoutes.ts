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
      if (request.method === "GET" && parts[1] && parts[2] === "document") {
        const content = research.markdown(parts[1]);
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="component-guide.md"', "cache-control": "no-store" });
        return response.end(content);
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
