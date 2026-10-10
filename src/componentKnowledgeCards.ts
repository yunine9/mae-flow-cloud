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

/** 接入配置由正式指南统一提供；导航中的其他用法不能成为当前卡片的检索内容。 */
function componentGuideIntroduction(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const selected: string[] = [];
  let fence = "";
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
    } else if (marker) fence = marker[1];
    else if (/^ {0,3}##\s+用法导航\s*#*\s*$/.test(line) || /^<a id="component-[a-z0-9-]+"><\/a>$/.test(line)) break;
    selected.push(line);
  }
  return selected.join("\n").trim();
}

export function componentCards(assets: SearchableKnowledge[]) {
  const cards: ComponentCard[] = [], warnings: string[] = [];
  for (const source of assets.filter(isComponentKnowledge)) {
    try {
      const introduction = componentGuideIntroduction(source.content), lines = source.content.split(/\r?\n/);
      for (const p of publishedComponentParadigms(source)) {
        if (p.kind !== "paradigm" || p.status !== "recommended") continue;
        const usage = lines.slice(p.start_line - 1, p.end_line).join("\n");
        cards.push({ source, paradigm: p, asset: { ...source,
          id: `component-card:${source.id}:${p.id}`, title: `${p.component} · ${p.title}`, summary: p.need, whenToUse: p.applicability,
          content: [componentCardText(p, `${source.id}:${p.start_line}-${p.end_line}`, source.revision), introduction, usage].join("\n\n") } });
      }
    } catch (e) { warnings.push(`${source.title}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { cards, warnings };
}
export function componentCardHit(card: ComponentCard, retrieval: "memsearch" | "local" | "full"): KnowledgeHit {
  const { source, paradigm: p } = card;
  const excerpt = (value: string, max: number) => {
    const text = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim(), omitted = "…（已省略，详见原文）";
    return text.length <= max ? text : text.slice(0, max - omitted.length) + omitted;
  };
  // 保留完整版本值，超出摘要容量时省略后续值，不能把截短的值当作实际版本。
  const productVersions: string[] = [];
  for (const version of source.productVersions) {
    if (JSON.stringify([...productVersions, version]).length > 600) break;
    productVersions.push(version);
  }
  const versionsOmitted = productVersions.length < source.productVersions.length;
  return { id: source.id, title: excerpt(source.title, 160), kind: source.kind, scope: excerpt(source.scope, 240), revision: source.revision,
    productVersions, whenToUse: excerpt(p.applicability, 240), heading: excerpt(p.title, 160), start_line: p.start_line, end_line: p.end_line,
    card_id: componentCardId(p), paradigm_id: p.id, retrieval,
    summary: excerpt(`${p.need}；${p.component} / ${p.api.join("、")}`, 440) + "；仅摘要，完整接口、条件和约束请读原文。",
    contracts: publishedComponentParadigms(source).filter(c => c.kind === "contracts" && c.component === p.component && c.language === p.language && c.status === "recommended")
      .slice(0, 3).map(c => ({ id: c.document_id, revision: c.document_revision, start_line: c.start_line, end_line: c.end_line })),
    versionNote: source.productVersions.length ? excerpt(`适用产品版本：${productVersions.join("、")}`, 160)
      + (versionsOmitted ? "；版本列表已省略，完整范围请读原文。" : "") : "未限定产品版本，请核对实际依赖。" };
}
function tokens(text: string) {
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_:.$+-]*|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(w => /^\p{Script=Han}+$/u.test(w) ? w.length < 2 ? [w] : Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w, ...w.split(/::|\./)]);
}
/** 索引未就绪或 memsearch 故障时，在相同的正式用法正文上做本地 BM25 检索。 */
export function localComponentCards(cards: ComponentCard[], query: string, limit = 5): KnowledgeHit[] {
  const language = componentQueryLanguage(query);
  const documents = new Map<string, number>();
  const rows = cards.filter(c => !language || c.paradigm.language === language).map(card => {
    const words = tokens(card.asset.content), counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys()) documents.set(word, (documents.get(word) ?? 0) + 1);
    return { card, counts, length: words.length };
  });
  const terms = [...new Set(tokens(query))].filter(t => !/^(cpp|cxx|c\+\+|java|c)$/.test(t));
  const average = rows.reduce((sum, r) => sum + r.length, 0) / (rows.length || 1) || 1;
  return rows.map(row => ({ ...row, score: terms.reduce((sum, term) => {
    const n = documents.get(term) ?? 0, count = row.counts.get(term) ?? 0;
    return sum + Math.log(1 + (rows.length - n + .5) / (n + .5)) * count * 2.2 / (count + 1.2 * (.25 + .75 * row.length / average));
  }, 0) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => componentCardHit(r.card, "local"));
}
