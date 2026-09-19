import type {
  ConsolidationState,
  KnowledgeTopic,
  TopicVersion,
} from "./knowledgeConsolidationTypes.ts";
export type {
  KnowledgeApplicability,
  ConsolidationState,
  ConsolidationJob,
  KnowledgeTopic,
  TopicVersion,
} from "./knowledgeConsolidationTypes.ts";
/** Durable topical drafts and published Markdown. Originals remain authoritative. */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SearchableKnowledge } from "./knowledgeSearch.ts";
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function applicabilityKey(asset: SearchableKnowledge): string {
  const a = asset.applicability;
  // Unstructured legacy scopes are kept apart; the model cannot widen them.
  return digest(
    a
      ? Object.fromEntries(
          Object.entries({ ...a, localPaths: a.localPaths ?? [] }).map(
            ([k, v]) => [k, [...v].sort()],
          ),
        )
      : { scope: asset.scope, versions: asset.productVersions },
  );
}
export const sourceRevision = (asset: SearchableKnowledge) =>
  digest([asset.revision, asset.content, applicabilityKey(asset)]);
export const consolidationRoot = (dir: string) =>
  join(dir, "knowledge-consolidation");
export function readConsolidation(dir: string): ConsolidationState {
  const path = join(consolidationRoot(dir), "state.json");
  if (!existsSync(path))
    return {
      settings: {
        enabled: true,
        time: "03:00",
        timezone: "Asia/Shanghai",
        operator: "system",
      },
      groups: {},
      topics: [],
      jobs: [],
    };
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (
    !state ||
    !Array.isArray(state.topics) ||
    !Array.isArray(state.jobs) ||
    !state.settings ||
    !state.groups
  )
    throw new Error(
      "知识整理记录无法读取，请检查 state.json；原始知识不受影响",
    );
  return state;
}
export function writeConsolidation(dir: string, state: ConsolidationState) {
  const root = consolidationRoot(dir);
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o640 });
  renameSync(tmp, join(root, "state.json"));
}
export function sourcesCurrent(
  topic: TopicVersion,
  assets: SearchableKnowledge[],
) {
  const current = new Map(assets.map((a) => [a.id, sourceRevision(a)]));
  return (
    topic.sources.length > 0 &&
    topic.sources.every((s) => current.get(s.id) === s.revision)
  );
}
export function topicMarkdown(
  version: TopicVersion,
  topic?: KnowledgeTopic,
): string {
  const scope = topic
    ? `\n\n## 适用范围（整理记录）\n\n${topic.scope}\n\n\`\`\`json\n${JSON.stringify(topic.applicability ?? {}, null, 2)}\n\`\`\``
    : "";
  return (
    `${version.content}${scope}\n\n---\n\n## 整理来源\n\n` +
    version.sources
      .map(
        (s) =>
          `- ${s.title}（${s.id}，版本 ${s.revision.slice(0, 12)}）：${s.sections.join("、") || "全文"}`,
      )
      .join("\n") +
    "\n"
  );
}
/** Called after context filtering. A topic only exists where ALL its sources are valid and accessible. */
export function consolidateSearchCatalog(
  dir: string,
  assets: SearchableKnowledge[],
): SearchableKnowledge[] {
  const suppressed = new Set<string>(),
    guides: SearchableKnowledge[] = [];
  let topics: KnowledgeTopic[];
  try {
    topics = readConsolidation(dir).topics;
  } catch {
    return assets;
  }
  for (const topic of topics) {
    const p = topic.published;
    if (!p || !Array.isArray(p.sources) || !sourcesCurrent(p, assets)) continue;
    guides.push({
      id: topic.id,
      title: p.title,
      kind: "document",
      scope: topic.scope,
      applicability: topic.applicability,
      summary: p.summary,
      whenToUse: p.summary,
      content: topicMarkdown(p, topic),
      revision: digest(p),
      productVersions: topic.productVersions,
    });
    for (const source of p.sources) if (source.full) suppressed.add(source.id);
  }
  return [...guides, ...assets.filter((a) => !suppressed.has(a.id))];
}
