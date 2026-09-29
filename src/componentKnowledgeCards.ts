import { publishedComponentParadigms, type PublishedComponentParadigm } from "./componentKnowledgeDocument.ts";
import type { ComponentParadigm } from "./componentParadigms.ts";
import type { SearchableKnowledge, KnowledgeHit } from "./knowledgeSearch.ts";

export const isComponentKnowledge = (asset: SearchableKnowledge) => /^---\r?\n[\s\S]*?^schema:\s*"mfc\.component-[^"\r\n]+"/m.test(asset.content);
export const componentCardId = (p: ComponentParadigm & { id: string }) => `${p.language}/${p.component}/${p.id}`;
export function componentCardText(p: ComponentParadigm & { id: string; title: string }, document: string, revision: string) {
  const line = (v: string, max = 600) => v.replace(/[\r\n]+/g, " ").slice(0, max);
  return [`# ${p.component} · ${line(p.title, 160)}`, `card-id: ${componentCardId(p)}`, `语言：${p.language}`,
    `要做的事：${line(p.need)}`, `替代的原始写法：${line([...p.replaces.identifiers, ...p.replaces.imports, ...p.replaces.patterns].join("、"))}`,
    `组件与接口：${p.component}（${line(p.api.join("、"))}）`, `适用条件：${line(p.applicability)}`,
    `文档：${document}`, `文档版本：${revision}`].join("\n") + "\n";
}
export interface ComponentCard { source: SearchableKnowledge; paradigm: PublishedComponentParadigm; asset: SearchableKnowledge }
export const componentQueryLanguage = (query: string) => /c\+\+|\bcpp\b|\bcxx\b/i.test(query) ? "cpp" : /\bjava\b/i.test(query) ? "java" : /\bc\b/i.test(query) ? "c" : undefined;
export function componentCards(assets: SearchableKnowledge[]) {
  const cards: ComponentCard[] = [], warnings: string[] = [];
  for (const source of assets.filter(isComponentKnowledge)) {
    try {
      for (const p of publishedComponentParadigms(source)) {
        if (p.kind !== "paradigm" || p.status !== "recommended") continue;
        cards.push({ source, paradigm: p, asset: { ...source,
          id: `component-card:${source.id}:${p.id}`, title: `${p.component} · ${p.title}`, summary: p.need, whenToUse: p.applicability,
          content: componentCardText(p, `${source.id}:${p.start_line}-${p.end_line}`, source.revision) } });
      }
    } catch (e) { warnings.push(`${source.title}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { cards, warnings };
}
export function componentCardHit(card: ComponentCard, retrieval: "memsearch" | "local" | "full"): KnowledgeHit {
  const { source, paradigm: p } = card;
  return { id: source.id, title: source.title, kind: source.kind, scope: source.scope, revision: source.revision,
    productVersions: source.productVersions, whenToUse: p.applicability, heading: p.title, start_line: p.start_line, end_line: p.end_line,
    card_id: componentCardId(p), paradigm_id: p.id, retrieval, summary: `${p.need}；${p.component} / ${p.api.join("、")}；${p.applicability}`,
    contracts: publishedComponentParadigms(source).filter(c => c.kind === "contracts" && c.component === p.component && c.language === p.language && c.status === "recommended")
      .map(c => ({ id: c.document_id, revision: c.document_revision, start_line: c.start_line, end_line: c.end_line })),
    versionNote: source.productVersions.length ? `适用产品版本：${source.productVersions.join("、")}` : "未限定产品版本，请核对实际依赖。" };
}
function tokens(text: string) {
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_:.$+-]*|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(w => /^\p{Script=Han}+$/u.test(w) ? w.length < 2 ? [w] : Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w, ...w.split(/::|\./)]);
}
/** issue 446 的本地 BM25 回退；只用于索引未就绪或 memsearch 故障。 */
export function localComponentCards(cards: ComponentCard[], query: string, limit = 5): KnowledgeHit[] {
  const language = componentQueryLanguage(query);
  const rows = cards.filter(c => !language || c.paradigm.language === language).map(card => ({ card, words: tokens([card.paradigm.need, card.paradigm.title, card.paradigm.component, card.paradigm.api.join(" "), card.paradigm.applicability, ...Object.values(card.paradigm.replaces).flat()].join(" ")) }));
  const terms = [...new Set(tokens(query))].filter(t => !/^(cpp|cxx|c\+\+|java|c)$/.test(t));
  const average = rows.reduce((sum, r) => sum + r.words.length, 0) / (rows.length || 1) || 1;
  return rows.map(row => ({ ...row, score: terms.reduce((sum, term) => {
    const n = rows.filter(r => r.words.includes(term)).length, count = row.words.filter(w => w === term).length;
    return sum + Math.log(1 + (rows.length - n + .5) / (n + .5)) * count * 2.2 / (count + 1.2 * (.25 + .75 * row.words.length / average));
  }, 0) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => componentCardHit(r.card, "local"));
}
