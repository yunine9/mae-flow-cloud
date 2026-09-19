/** Reviewable evidence only: fixed inputs/outputs and tool actions, never model thinking or credentials. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  consolidationRoot,
  readConsolidation,
} from "./knowledgeConsolidationStore.ts";
import type {
  ConsolidationAuditDetail,
  ConsolidationTrace,
  ConsolidationAuditResult,
  KnowledgeTopic,
} from "./knowledgeConsolidationTypes.ts";
import type { SearchableKnowledge } from "./knowledgeSearch.ts";
export function saveConsolidationEvidence(
  root: string,
  name: "before.json" | "results.json" | "execution.json",
  value: unknown,
) {
  const temp = join(root, `${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(value), { mode: 0o640 });
  renameSync(temp, join(root, name));
}
export function recordConsolidationTrace(
  root: string,
  event: Omit<ConsolidationTrace, "at">,
) {
  appendFileSync(
    join(root, "actions.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
    { mode: 0o640 },
  );
}
function jobRoot(dir: string, id: string) {
  if (
    !/^kc-[a-f0-9-]{36}$/.test(id) ||
    !readConsolidation(dir).jobs.some((j) => j.id === id)
  )
    throw new Error("整理记录不存在");
  return join(consolidationRoot(dir), "runs", id);
}
function read<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}
export function readConsolidationAudit(
  dir: string,
  id: string,
): ConsolidationAuditDetail {
  const root = jobRoot(dir, id),
    job = readConsolidation(dir).jobs.find((j) => j.id === id)!;
  const groups = existsSync(root)
    ? readdirSync(root)
        .filter((k) => /^[a-f0-9]{64}$/.test(k))
        .map((key) => {
          const path = join(root, key),
            sources = read<SearchableKnowledge[]>(
              join(path, "sources.json"),
              [],
            );
          const actionsPath = join(path, "actions.jsonl");
          const actions: ConsolidationTrace[] = existsSync(actionsPath)
            ? readFileSync(actionsPath, "utf8")
                .split("\n")
                .flatMap((line) => {
                  if (!line) return [];
                  try {
                    return [JSON.parse(line)];
                  } catch {
                    return [];
                  }
                })
            : [];
          return {
            key,
            scope: sources[0]?.scope ?? "",
            sources: sources.map(({ content, path: sourcePath, ...s }) => ({
              ...s,
              characters: content.length,
            })),
            before: read<KnowledgeTopic[]>(join(path, "before.json"), []),
            results: read<ConsolidationAuditResult[] | undefined>(
              join(path, "results.json"),
              undefined,
            ),
            execution: read<
              | { provider: string; model: string; instruction: string }
              | undefined
            >(join(path, "execution.json"), undefined),
            actions,
          };
        })
    : [];
  return { job, groups };
}
export function readConsolidationSource(
  dir: string,
  id: string,
  group: string,
  sourceId: string,
) {
  const root = jobRoot(dir, id);
  if (!/^[a-f0-9]{64}$/.test(group)) throw new Error("整理范围不存在");
  const source = read<SearchableKnowledge[]>(
    join(root, group, "sources.json"),
    [],
  ).find((s) => s.id === sourceId);
  if (!source) throw new Error("当时的来源快照不存在");
  return {
    id: source.id,
    title: source.title,
    content: source.content,
    revision: source.revision,
    scope: source.scope,
  };
}
