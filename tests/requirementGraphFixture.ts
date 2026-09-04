import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 需求分析测试夹具必须和生产契约一样同时签两份产物。集中生成，避免
 * 每个用例各自伪造摘要，最终只测到“字段长得像”而没有测真实字节。 */
export function requirementArtifacts(
  body: string,
  graph: Record<string, unknown>,
  revision = "r1",
): { chain: string; graph: string; chainSha256: string } {
  const chain = `<!-- mae-flow-plan-revision: ${revision} -->\n${body}`;
  const chainSha256 = createHash("sha256").update(chain, "utf-8").digest("hex");
  return {
    chain,
    chainSha256,
    graph: JSON.stringify({
      ...graph,
      plan_revision: revision,
      chain_sha256: chainSha256,
    }),
  };
}

export function writeRequirementArtifacts(
  directory: string,
  ticket: string,
  body: string,
  graph: Record<string, unknown>,
  revision = "r1",
): { chain: string; graph: string; chainSha256: string } {
  const artifacts = requirementArtifacts(body, graph, revision);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `CHAIN-${ticket}.md`), artifacts.chain);
  writeFileSync(join(directory, "requirement-graph.json"), artifacts.graph);
  return artifacts;
}
