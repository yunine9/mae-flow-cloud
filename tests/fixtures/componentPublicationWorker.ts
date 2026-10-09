import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { ComponentResearch, type ResearchExecution } from "../../src/componentResearch.ts";
import { DomainKnowledgeExtraction } from "../../src/domainKnowledgeExtraction.ts";

export function componentPublicationExecute(input: ResearchExecution): Promise<string> {
  const repositoryIds = (input.record.components ?? [input.record.component]).map(component => component.id);
  input.update({ revisions: Object.fromEntries(repositoryIds.map(id => [id, "a".repeat(40)])) });
  if (input.review) {
    const section = input.readDocument!().sections.find(section => section.id === input.review!.section_id)!;
    input.editDocument!({ action: "section", section: { ...section, content: `${section.content}\n本轮修订：${input.review.message}` } });
    return Promise.resolve("本轮建议已完成");
  }
  input.editDocument!({ action: "overview", overview: "按源码证据选择组件能力，正式知识与 Git 归档分别记录。" });
  input.editDocument!({ action: "outline", entries: [0, 1, 2].map(index => ({ id: `cap-${index}`, title: `能力 ${index}`, repository_ids: repositoryIds })) });
  for (let index = 0; index < 3; index++) input.editDocument!({ action: "section", section: {
    id: `cap-${index}`, title: `能力 ${index}`, repository_ids: repositoryIds, related_ids: [], content: `能力 ${index} 的边界与失败处理。`,
    interfaces: "include/file.h:1 Close(handle)", integration: "CMake target file，对应 libfile.so。",
    example: "测试夹具示例，未编译验证。\n```cpp\nClose(handle);\n```", sources: "src/file.cpp:1 @ 固定测试版本。",
  } });
  return Promise.resolve("联合草稿已完成");
}

async function runWorker() {
  const [dir, id, window] = process.argv.slice(3), marker = join(dir, "publication-cut.json");
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("组件发布不能运行领域研究"); }, {
    publish: async () => { throw new Error("到达硬崩溃边界前不能开始远端归档"); },
  });
  const research = new ComponentResearch(dir, async () => { throw new Error("已完成草稿不能重新研究"); }, undefined, id => manager.componentArchive(id));
  const rename = fs.renameSync;
  let cut = false;
  // 只替换子进程自己的真实文件系统边界；生产发布流程不接受测试开关。
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const result = rename(from, to), path = String(to);
    let match = window === "formal" && /[\\/]knowledge-documents[\\/]kd-[a-f0-9-]{36}\.json$/.test(path);
    if (path === join(dir, "component-research", id, "record.json")) {
      const record = JSON.parse(fs.readFileSync(path, "utf8"));
      match ||= window === "intent" && !!record.publication_intent && !record.document_id;
      match ||= window === "record" && !record.publication_intent && !!record.document_id && !!record.published_revision;
    }
    if (!cut && match) {
      cut = true;
      fs.writeFileSync(marker, JSON.stringify({ id, window }));
      process.kill(process.pid, "SIGSTOP");
    }
    return result;
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  const deadline = setTimeout(() => { console.error("组件发布子进程超过10秒预算"); process.exit(9); }, 10_000);
  try {
    const publish = (research as unknown as { publish?: (id: string, input: unknown, operator: string) => unknown }).publish;
    if (typeof publish !== "function") throw new Error("组件发布缺少服务端单次 publish 入口");
    await publish.call(research, id, JSON.parse(fs.readFileSync(join(dir, "publication-request.json"), "utf8")), "reviewer");
    throw new Error(`未到达 ${window} 发布硬崩溃边界`);
  } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
  finally { clearTimeout(deadline); await Promise.all([manager.shutdown(), research.shutdown()]); }
}
if (process.argv[2] === "--component-publish-worker") await runWorker();
