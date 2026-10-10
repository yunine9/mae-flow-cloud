import type { PublishedComponentParadigm } from "./componentKnowledgeDocument.ts";

export interface ComponentCodeObservation { path?: string; text: string; tool: string; callId?: string }
export interface ComponentAssociation {
  paradigm: PublishedComponentParadigm;
  kind: "api" | "replacement";
  symbols: string[];
  observation: ComponentCodeObservation;
}

const MAX_OBSERVATIONS = 64;
const MAX_TEXT_LENGTH = 128 * 1024;
const MAX_TOTAL_LENGTH = 512 * 1024;
const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
const NAME = `${IDENTIFIER}(?:\\s*(?:::|\\.)\\s*${IDENTIFIER})*`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalize = (name: string) => name.replace(/\s+/g, "").replaceAll("::", ".");

function languages(path: string | undefined): string[] {
  if (!path) return [];
  if (path.endsWith(".C")) return ["cpp"];
  if (/\.(?:cpp|cc|cxx|hpp|hh|hxx)$/i.test(path)) return ["cpp"];
  if (/\.c$/.test(path)) return ["c"];
  if (/\.h$/i.test(path)) return ["c", "cpp"];
  return /\.java$/i.test(path) ? ["java"] : [];
}

/** 仅提取签名里的完整名称；不会把 Pool.submit 降为 submit，也不解释模板或运算符。 */
function apiName(signature: string): string | undefined {
  if (signature.length > 2000) return undefined;
  const prefix = signature.split("(", 1)[0].trim();
  const match = new RegExp(`(?:^|\\s|[*&])(${NAME})$`).exec(prefix);
  return match ? normalize(match[1]) : undefined;
}

function replacementName(value: string): string | undefined {
  return value.length <= 2000 && new RegExp(`^${NAME}$`).test(value) ? normalize(value) : undefined;
}

function precedingCharacter(code: string, index: number) {
  while (index > 0 && /\s/.test(code[index - 1])) index--;
  return code[index - 1];
}

/** 只关联当前片段中写明的简单类型与成员调用，不解析别名、返回类型或跨作用域绑定。 */
function explicitInstanceMembers(code: string): Set<string> {
  const declarations = new Map<string, { types: Set<string>; start: number }>();
  const reserved = new Set(["return", "throw", "new", "delete", "case", "break", "continue", "yield", "else", "using", "import", "package"]);
  const declaration = new RegExp(`(?<![\\p{L}\\p{N}_$:.])(${NAME})(?:\\s+(?:const|volatile))*\\s*(?:[*&]+\\s*|\\s+)(${IDENTIFIER})\\s*(?=[=;,){}])`, "gu");
  for (const match of code.matchAll(declaration)) {
    let type = normalize(match[1]);
    if (reserved.has(type)) continue;
    const before = precedingCharacter(code, match.index!);
    if (before === "." || before === ":" || before === ">") continue;
    if (type === "auto" || type === "var") {
      const initializer = new RegExp(`^=\\s*(?:new\\s+)?(${NAME})\\s*(?=[({])`).exec(code.slice(match.index! + match[0].length));
      type = initializer ? normalize(initializer[1]) : "<unknown>";
    }
    const current = declarations.get(match[2]);
    if (current) current.types.add(type);
    else declarations.set(match[2], { types: new Set([type]), start: match.index! + match[0].length });
  }
  const members = new Set<string>();
  const call = new RegExp(`(?<![\\p{L}\\p{N}_$:.])(${IDENTIFIER})\\s*(?:\\.|->)\\s*(${IDENTIFIER})\\s*\\(`, "gu");
  for (const match of code.matchAll(call)) {
    const declared = declarations.get(match[1]);
    if (!declared || declared.types.size !== 1 || declared.start >= match.index!) continue;
    const before = precedingCharacter(code, match.index!);
    if (before === "." || before === ":" || before === ">") continue;
    members.add(`${[...declared.types][0]}.${match[2]}`);
  }
  return members;
}

/** 保留换行和字符位置，方便将真正的 include 与字符串中的伪指令区分开。 */
function codeText(text: string) {
  const code: string[] = [], commentsRemoved: string[] = [];
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  let cursor = 0, copied = 0;
  while (cursor < text.length) {
    let end = cursor, comment = false;
    if (text.startsWith("//", cursor)) {
      let newline = text.indexOf("\n", cursor + 2);
      while (newline >= 0 && text[text[newline - 1] === "\r" ? newline - 2 : newline - 1] === "\\") {
        newline = text.indexOf("\n", newline + 1);
      }
      end = newline < 0 ? text.length : newline; comment = true;
    } else if (text.startsWith("/*", cursor)) {
      const close = text.indexOf("*/", cursor + 2);
      end = close < 0 ? text.length : close + 2; comment = true;
    } else {
      const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(text.slice(cursor, cursor + 24));
      if (raw) {
        const close = text.indexOf(`)${raw[1]}"`, cursor + raw[0].length);
        end = close < 0 ? text.length : close + raw[1].length + 2;
      } else if (text.startsWith('"""', cursor)) {
        const close = text.indexOf('"""', cursor + 3);
        end = close < 0 ? text.length : close + 3;
      } else if (text[cursor] === '"' || text[cursor] === "'") {
        const quote = text[cursor]; end = cursor + 1;
        while (end < text.length) {
          if (text[end] === "\\") { end = Math.min(text.length, end + 2); continue; }
          if (text[end++] === quote) break;
        }
      }
    }
    if (end > cursor) {
      code.push(text.slice(copied, cursor), blank(text.slice(cursor, end)));
      commentsRemoved.push(text.slice(copied, cursor), comment ? blank(text.slice(cursor, end)) : text.slice(cursor, end));
      cursor = copied = end;
    } else cursor++;
  }
  code.push(text.slice(copied)); commentsRemoved.push(text.slice(copied));
  return { code: code.join(""), commentsRemoved: commentsRemoved.join("") };
}

function evidence(text: string, language: string[], observeInstances: boolean) {
  const cleaned = codeText(text), lines = cleaned.code.split(/\r?\n/);
  const original = cleaned.commentsRemoved.split(/\r?\n/), imports = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (language.includes("c") || language.includes("cpp")) {
      if (/^\s*#\s*include\b/.test(lines[i])) {
        const include = /^\s*#\s*include\s*(<[^<>\s]+>|"[^"\r\n]+")\s*$/.exec(original[i]);
        if (include) imports.add(include[1]);
        lines[i] = "";
      }
    } else if (/^\s*import\b/.test(lines[i])) {
      const declaration = /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*(?:[A-Za-z_$][\w$]*|\*))+)\s*;\s*$/.exec(lines[i]);
      if (declaration) imports.add(declaration[1].replace(/\s+/g, ""));
      lines[i] = "";
    }
  }
  // 整个限定名作为一个词，other.Pool.submit 不会降成 Pool.submit。
  const codeName = /(?<![\p{L}\p{N}_$])[\p{L}_$][\p{L}\p{N}_$]*(?:\s*(?:::|\.)\s*[\p{L}_$][\p{L}\p{N}_$]*)*/gu;
  const code = lines.join("\n"), symbols = new Set((code.match(codeName) ?? []).map(normalize));
  // 检索输出可能拼接不连续行，不能据此建立实例声明与调用之间的联系。
  return { symbols, imports, members: observeInstances ? explicitInstanceMembers(code) : new Set<string>() };
}

/** 返回代码关联候选，不解析类型别名、组件归属或依赖适用性。数组末尾视为最新观测。 */
export function associateComponentKnowledge(
  paradigms: PublishedComponentParadigm[], observations: ComponentCodeObservation[],
): ComponentAssociation[] {
  const candidates = paradigms.filter(p => p.kind === "paradigm" && p.status === "recommended")
    .map(paradigm => ({ paradigm,
      apis: paradigm.api.flatMap(symbol => { const name = apiName(symbol); return name ? [{ name, symbol }] : []; }),
      replacements: paradigm.replaces.identifiers.flatMap(symbol => { const name = replacementName(symbol); return name ? [{ name, symbol }] : []; }),
    }));
  const found = new Map<string, { association: ComponentAssociation; index: number }>();
  let total = 0;
  for (let index = observations.length - 1; index >= Math.max(0, observations.length - MAX_OBSERVATIONS); index--) {
    const observation = observations[index], language = languages(observation.path);
    // 超大观测整体跳过；截断标识符可能把 Pool.submitLater 误认成 Pool.submit。
    if (!language.length || !observation.text || observation.text.length > MAX_TEXT_LENGTH
      || total + observation.text.length > MAX_TOTAL_LENGTH) continue;
    total += observation.text.length;
    const tokens = evidence(observation.text, language, ["read", "write", "edit"].includes(observation.tool.toLowerCase()));
    for (const { paradigm, apis, replacements } of candidates) {
      if (!language.includes(paradigm.language)) continue;
      const api = apis.filter(item => tokens.symbols.has(item.name) || tokens.members.has(item.name)).map(item => item.symbol);
      const replaced = api.length ? [] : [
        ...replacements.filter(item => tokens.symbols.has(item.name)).map(item => item.symbol),
        ...paradigm.replaces.imports.filter(symbol => tokens.imports.has(symbol)),
      ];
      if (!api.length && !replaced.length) continue;
      const kind = api.length ? "api" : "replacement";
      const key = JSON.stringify([paradigm.document_id, paradigm.document_revision, paradigm.id]);
      const previous = found.get(key);
      if (previous && (previous.association.kind === "api" || kind === "replacement")) continue;
      found.set(key, { index, association: { paradigm, kind,
        symbols: [...new Set(api.length ? api : replaced)].sort(compare), observation } });
    }
  }
  return [...found.values()].sort((a, b) =>
    (a.association.kind === b.association.kind ? 0 : a.association.kind === "api" ? -1 : 1)
    || b.index - a.index
    || compare(JSON.stringify([a.association.paradigm.document_id, a.association.paradigm.id, a.association.paradigm.document_revision]),
      JSON.stringify([b.association.paradigm.document_id, b.association.paradigm.id, b.association.paradigm.document_revision])))
    .map(item => item.association);
}
