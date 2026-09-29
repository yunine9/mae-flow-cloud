import { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";
import type { SearchableKnowledge, KnowledgeSearchResult } from "./knowledgeSearch.ts";

export function isComponentKnowledge(asset: SearchableKnowledge) {
  return /^---\r?\n[\s\S]*?^schema:\s*"mfc\.component-[^"\r\n]+"/m.test(asset.content);
}

/** 在统一 knowledge 查询内检索组件的明确字段；不建立第二份知识索引。 */
export function searchComponentKnowledge(assets: SearchableKnowledge[], query: string): KnowledgeSearchResult {
  const normalized = query.toLowerCase().trim();
  const terms = [...new Set(normalized.match(/[a-z_][a-z0-9_:.$+-]*|[\p{Script=Han}]{2,}/gu) ?? [])].filter(term => !/^(cpp|cxx|c\+\+|java|c)$/.test(term));
  const language = /c\+\+|\bcpp\b|\bcxx\b/i.test(query) ? "cpp" : /\bjava\b/i.test(query) ? "java" : /\bc\b/i.test(query) ? "c" : undefined;
  const warnings: string[] = [];
  const ranked: Array<{ score: number; hit: KnowledgeSearchResult["hits"][number] }> = [];
  for (const asset of assets.filter(isComponentKnowledge)) {
    try {
      for (const p of publishedComponentParadigms(asset)) {
        if (p.kind !== "paradigm" || p.status !== "recommended" || (language && p.language !== language)) continue;
        const title = `${p.component} ${p.title} ${p.need} ${p.api.join(" ")}`.toLowerCase();
        const extra = `${p.language} ${p.applicability} ${p.replaces.identifiers.join(" ")} ${p.replaces.imports.join(" ")}`.toLowerCase();
        let score = title.includes(normalized) ? 20 : 0;
        for (const term of terms) {
          if (title.includes(term)) score += 8;
          else if (extra.includes(term)) score += 2;
          else if (/^[\p{Script=Han}]+$/u.test(term)) {
            for (let i = 0; i < term.length - 1; i++) if (title.includes(term.slice(i, i + 2))) score++;
          }
        }
        if (!score) continue;
        ranked.push({ score, hit: { id: asset.id, title: asset.title, kind: asset.kind, scope: asset.scope,
          heading: p.title, start_line: p.start_line, end_line: p.end_line, revision: asset.revision,
          productVersions: asset.productVersions, whenToUse: p.applicability,
          summary: `${p.need}；${p.component} / ${p.api.join("、")}；${p.applicability}`,
          versionNote: asset.productVersions.length ? `适用产品版本：${asset.productVersions.join("、")}` : "未限定产品版本，请核对实际依赖。" } });
      }
    } catch (error) { warnings.push(`${asset.title}：组件结构读取失败，${error instanceof Error ? error.message : String(error)}`); }
  }
  ranked.sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id) || (a.hit.start_line ?? 0) - (b.hit.start_line ?? 0));
  return { available: true, hits: ranked.map(row => row.hit), warnings };
}
