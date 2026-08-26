/**
 * PlantUML 活动图的保守解析器。
 *
 * 前端没有 PlantUML 服务，只能渲染我们确实理解的语法。这里宁可返回
 * 明确的行号与原因，也不忽略陌生语句后画出一张语义残缺的“成功”图。
 */

export type ActivityItem =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "action"; text: string }
  | { kind: "note"; position: "left" | "right"; text: string }
  | { kind: "partition"; label: string; items: ActivityItem[] }
  | {
      kind: "decision";
      condition: string;
      thenLabel: string;
      thenItems: ActivityItem[];
      elseLabel: string;
      elseItems: ActivityItem[];
    };

export interface ActivityModel {
  title: string;
  items: ActivityItem[];
}

export interface ActivityParseIssue {
  line: number;
  message: string;
}

export interface ActivityParseResult {
  model?: ActivityModel;
  issue?: ActivityParseIssue;
}

interface SourceLine {
  text: string;
  line: number;
}

class ActivityParseFailure extends Error {
  constructor(readonly line: number, message: string) {
    super(message);
  }
}

const IF_LINE = /^if\s*\((.*)\)\s*then\s*\((.*)\)\s*$/i;
const ELSE_LINE = /^else(?:\s*\((.*)\))?\s*$/i;
const PARTITION_LINE = /^partition\s+(?:"([^"]+)"|(.+?))\s*\{\s*$/i;
const NOTE_INLINE = /^note\s+(left|right)\s*:\s*(.*)$/i;
const NOTE_BLOCK = /^note\s+(left|right)\s*$/i;

function sourceLines(source: string): { title: string; lines: SourceLine[] } {
  let title = "";
  const lines: SourceLine[] = [];
  source.replace(/\r\n?/g, "\n").split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (!text || text.startsWith("'") || /^@(?:start|end)uml(?:\s+\S+)?$/i.test(text)) {
      return;
    }
    const named = text.match(/^title\s+(.+)$/i);
    if (named) {
      title = named[1].trim();
      return;
    }
    // 纯展示指令不改变流程语义，可以安全忽略；带块的 skinparam 仍会
    // 落到未知语法，避免误吞随后的大括号。
    if (/^(?:hide|show)\b/i.test(text)
      || (/^skinparam\b/i.test(text) && !/\{\s*$/.test(text))) return;
    lines.push({ text, line: index + 1 });
  });
  return { title, lines };
}

function parseItems(
  lines: SourceLine[],
  from: number,
  allowedStops: ReadonlySet<"}" | "else" | "endif">,
): { items: ActivityItem[]; at: number; stop?: "}" | "else" | "endif" } {
  const items: ActivityItem[] = [];
  let at = from;
  while (at < lines.length) {
    const current = lines[at];
    const { text } = current;
    let stop: "}" | "else" | "endif" | undefined;
    if (text === "}") stop = "}";
    else if (/^endif\s*$/i.test(text)) stop = "endif";
    else if (ELSE_LINE.test(text)) stop = "else";
    if (stop) {
      if (!allowedStops.has(stop)) {
        throw new ActivityParseFailure(current.line, `意外出现 ${text}`);
      }
      return { items, at, stop };
    }

    if (/^start$/i.test(text)) {
      items.push({ kind: "start" });
      at += 1;
      continue;
    }
    if (/^(?:stop|end)$/i.test(text)) {
      items.push({ kind: "stop" });
      at += 1;
      continue;
    }

    const action = text.match(/^:(.*);$/);
    if (action) {
      items.push({ kind: "action", text: action[1].trim() });
      at += 1;
      continue;
    }

    const inlineNote = text.match(NOTE_INLINE);
    if (inlineNote) {
      items.push({
        kind: "note",
        position: inlineNote[1].toLowerCase() as "left" | "right",
        text: inlineNote[2].trim(),
      });
      at += 1;
      continue;
    }
    const blockNote = text.match(NOTE_BLOCK);
    if (blockNote) {
      const body: string[] = [];
      const opening = current;
      at += 1;
      while (at < lines.length && !/^end\s+note$/i.test(lines[at].text)) {
        body.push(lines[at].text);
        at += 1;
      }
      if (at >= lines.length) {
        throw new ActivityParseFailure(opening.line, "note 缺少 end note");
      }
      items.push({
        kind: "note",
        position: blockNote[1].toLowerCase() as "left" | "right",
        text: body.join("\\n"),
      });
      at += 1;
      continue;
    }

    const partition = text.match(PARTITION_LINE);
    if (partition) {
      const nested = parseItems(lines, at + 1, new Set(["}"]));
      if (nested.stop !== "}") {
        throw new ActivityParseFailure(current.line, "partition 缺少右大括号 }");
      }
      items.push({
        kind: "partition",
        label: (partition[1] ?? partition[2]).trim(),
        items: nested.items,
      });
      at = nested.at + 1;
      continue;
    }

    const condition = text.match(IF_LINE);
    if (condition) {
      const yes = parseItems(lines, at + 1, new Set(["else", "endif"]));
      if (!yes.stop) {
        throw new ActivityParseFailure(current.line, "if 缺少 endif");
      }
      let elseLabel = "";
      let elseItems: ActivityItem[] = [];
      let next = yes.at;
      if (yes.stop === "else") {
        elseLabel = lines[yes.at].text.match(ELSE_LINE)?.[1]?.trim() ?? "";
        const no = parseItems(lines, yes.at + 1, new Set(["endif"]));
        if (no.stop !== "endif") {
          throw new ActivityParseFailure(current.line, "else 分支缺少 endif");
        }
        elseItems = no.items;
        next = no.at;
      }
      items.push({
        kind: "decision",
        condition: condition[1].trim(),
        thenLabel: condition[2].trim(),
        thenItems: yes.items,
        elseLabel,
        elseItems,
      });
      at = next + 1;
      continue;
    }

    // `else` / `endif` / `}` 已在上方单独处理；来到这里的一定是我们
    // 无法忠实解释的活动图语句，不能静默忽略。
    throw new ActivityParseFailure(current.line,
      `暂不支持活动图语句“${text}”`);
  }
  return { items, at };
}

function walk(items: ActivityItem[]): ActivityItem[] {
  return items.flatMap((item) => {
    if (item.kind === "partition") return [item, ...walk(item.items)];
    if (item.kind === "decision") {
      return [item, ...walk(item.thenItems), ...walk(item.elseItems)];
    }
    return [item];
  });
}

export function looksLikeActivity(source: string): boolean {
  return source.replace(/\r\n?/g, "\n").split("\n").some((raw) => {
    const line = raw.trim();
    // bare `end` 同时是时序图 alt/opt/loop/par/group 的闭合符，不能独自
    // 作为活动图证据。活动图内部仍把 end 当 stop 解析；合法且受支持的
    // 活动图还会有 start、动作、partition 或 if 等明确证据。
    return /^(?:start|stop)$/i.test(line) || /^:.*;$/s.test(line)
      || PARTITION_LINE.test(line) || IF_LINE.test(line);
  });
}

export function inspectActivity(source: string): ActivityParseResult {
  const prepared = sourceLines(source);
  try {
    const parsed = parseItems(prepared.lines, 0, new Set());
    if (parsed.stop || parsed.at !== prepared.lines.length) {
      const line = prepared.lines[parsed.at]?.line ?? 1;
      throw new ActivityParseFailure(line, "活动图结构没有完整闭合");
    }
    const all = walk(parsed.items);
    if (!all.some((item) => item.kind === "start")
      || !all.some((item) => item.kind === "stop")
      || !all.some((item) => item.kind === "action" || item.kind === "decision")) {
      return { issue: { line: 1, message: "活动图需要 start、流程步骤和 stop" } };
    }
    return { model: { title: prepared.title, items: parsed.items } };
  } catch (error) {
    if (error instanceof ActivityParseFailure) {
      return { issue: { line: error.line, message: error.message } };
    }
    return { issue: { line: 1, message: "活动图解析失败" } };
  }
}

export function parseActivity(source: string): ActivityModel | undefined {
  return inspectActivity(source).model;
}
