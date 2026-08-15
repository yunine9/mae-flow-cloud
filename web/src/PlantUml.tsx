import { useId, type ReactNode } from "react";
import { ClassDiagram, ClassDiagramLegend } from "./ClassDiagram";
import { looksLikeClassDiagram, parseClassDiagram } from "./classModel";

interface Participant {
  alias: string;
  label: string;
}

type DiagramRow =
  | { kind: "message"; from: string; to: string; text: string; dashed: boolean }
  | { kind: "note"; targets: string[]; position: "left" | "right" | "over"; lines: string[] }
  | { kind: "group"; group: string; label: string }
  | { kind: "else"; label: string }
  | { kind: "end" };

interface SequenceModel {
  participants: Participant[];
  rows: DiagramRow[];
}

const declaration = /^(?:participant|actor|boundary|control|entity|database)\s+(?:"([^"]+)"|(\S+))(?:\s+as\s+(\S+))?/i;
const message = /^(\S+)\s*(--?>|--?>>|->>|<-{1,2}|<<--?)\s*(\S+)\s*(?::\s*(.*))?$/;
const noteStart = /^note\s+(left|right|over)(?:\s+of)?\s+([^:]+?)(?:\s*:\s*(.*))?$/i;
const groupStart = /^(alt|opt|loop|par|group)\s*(.*)$/i;

function cleanLabel(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

export function parseSequence(source: string): SequenceModel | undefined {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const participants: Participant[] = [];
  const rows: DiagramRow[] = [];
  const aliases = new Map<string, string>();

  const ensure = (alias: string) => {
    const clean = cleanLabel(alias);
    if (!participants.some((item) => item.alias === clean)) {
      participants.push({ alias: clean, label: aliases.get(clean) ?? clean });
    }
    return clean;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || /^@(?:start|end)uml$/i.test(line) || /^autonumber$/i.test(line)
      || /^(?:activate|deactivate|skinparam|hide|show)\b/i.test(line)
      || line.startsWith("'")) continue;

    const declared = line.match(declaration);
    if (declared) {
      const label = cleanLabel(declared[1] ?? declared[2]);
      const alias = cleanLabel(declared[3] ?? label);
      aliases.set(alias, label);
      if (!participants.some((item) => item.alias === alias)) {
        participants.push({ alias, label });
      }
      continue;
    }

    const note = line.match(noteStart);
    if (note) {
      const body: string[] = [];
      if (note[3]) body.push(note[3].trim());
      if (!note[3]) {
        while (index + 1 < lines.length && !/^end\s+note$/i.test(lines[index + 1].trim())) {
          index += 1;
          body.push(lines[index].trim());
        }
        if (index + 1 < lines.length) index += 1;
      }
      const targets = note[2].split(",").map((value) => ensure(value.trim()));
      rows.push({
        kind: "note",
        targets,
        position: note[1].toLowerCase() as "left" | "right" | "over",
        lines: body.filter(Boolean),
      });
      continue;
    }

    const group = line.match(groupStart);
    if (group) {
      rows.push({ kind: "group", group: group[1].toLowerCase(), label: group[2].trim() });
      continue;
    }
    if (/^else(?:\s|$)/i.test(line)) {
      rows.push({ kind: "else", label: line.replace(/^else\s*/i, "") });
      continue;
    }
    if (/^end$/i.test(line)) {
      rows.push({ kind: "end" });
      continue;
    }

    const sent = line.match(message);
    if (sent) {
      let from = ensure(sent[1]);
      let to = ensure(sent[3]);
      if (sent[2].startsWith("<")) [from, to] = [to, from];
      rows.push({
        kind: "message",
        from,
        to,
        text: sent[4]?.trim() ?? "",
        dashed: sent[2].includes("--"),
      });
    }
  }

  return participants.length >= 1 && rows.some((row) => row.kind === "message")
    ? { participants, rows }
    : undefined;
}

function visualLength(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .58), 0);
}

function textLines(text: string): string[] {
  return text.split(/\\n|\n/).filter((line) => line.length > 0);
}

function SvgText({ x, y, lines, className, anchor = "middle" }: {
  x: number;
  y: number;
  lines: string[];
  className?: string;
  anchor?: "start" | "middle";
}) {
  return (
    <text x={x} y={y} className={className} textAnchor={anchor}>
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 0 : 15}>{line}</tspan>
      ))}
    </text>
  );
}

interface PlacedRow {
  row: DiagramRow;
  y: number;
  height: number;
}

interface Frame {
  start: number;
  end: number;
  group: string;
  label: string;
  depth: number;
  branches: Array<{ y: number; label: string }>;
}

function SequenceDiagram({ model }: { model: SequenceModel }) {
  const marker = useId().replace(/:/g, "");
  const arrow = `arrow-${marker}`;
  const returnArrow = `return-${marker}`;
  const headWidths = model.participants.map((item) =>
    Math.max(112, Math.min(230, visualLength(item.label.replace(/\\n/g, " ")) * 7.2 + 30)));
  const gaps = model.participants.slice(1).map(() => 172);
  for (const row of model.rows) {
    if (row.kind !== "message" || row.from === row.to) continue;
    const from = model.participants.findIndex((item) => item.alias === row.from);
    const to = model.participants.findIndex((item) => item.alias === row.to);
    const span = Math.max(1, Math.abs(to - from));
    const needed = Math.min(320, visualLength(row.text.replace(/\\n/g, " ")) * 6.5 + 45) / span;
    for (let index = Math.min(from, to); index < Math.max(from, to); index += 1) {
      gaps[index] = Math.max(gaps[index], needed);
    }
  }
  const positions: number[] = [];
  let cursor = 28 + headWidths[0] / 2;
  model.participants.forEach((_, index) => {
    positions.push(cursor);
    if (index < gaps.length) cursor += Math.max(
      gaps[index],
      (headWidths[index] + headWidths[index + 1]) / 2 + 30,
    );
  });
  const width = Math.ceil(positions.at(-1)! + headWidths.at(-1)! / 2 + 28);

  const placed: PlacedRow[] = [];
  const frames: Frame[] = [];
  const stack: Frame[] = [];
  let y = 82;
  for (const row of model.rows) {
    let height = 0;
    if (row.kind === "message") height = Math.max(46, textLines(row.text).length * 15 + 30);
    if (row.kind === "note") height = Math.max(44, row.lines.length * 16 + 26);
    if (row.kind === "group") height = 30;
    if (row.kind === "else") height = 34;
    if (row.kind === "end") height = 14;
    placed.push({ row, y, height });
    if (row.kind === "group") {
      const frame: Frame = { start: y + 2, end: 0, group: row.group, label: row.label, depth: stack.length, branches: [] };
      frames.push(frame);
      stack.push(frame);
    } else if (row.kind === "else") {
      stack.at(-1)?.branches.push({ y: y + 8, label: row.label });
    } else if (row.kind === "end") {
      const frame = stack.pop();
      if (frame) frame.end = y + 8;
    }
    y += height;
  }
  const diagramBottom = y + 24;
  stack.forEach((frame) => { frame.end = diagramBottom; });
  const height = diagramBottom + 54;

  const participantX = (alias: string) => positions[
    model.participants.findIndex((item) => item.alias === alias)
  ] ?? positions[0];

  const frameNodes: ReactNode[] = frames.map((frame, index) => {
    const inset = 10 + frame.depth * 8;
    const tabWidth = Math.max(46, frame.group.length * 7 + 22);
    return (
      <g key={`frame-${index}`}>
        <rect className="puml-frame" x={inset} y={frame.start} width={width - inset * 2} height={Math.max(28, frame.end - frame.start)} rx="5" />
        <path className="puml-frame-tab" d={`M${inset} ${frame.start}h${tabWidth}v20l-8 7h-${tabWidth - 8}z`} />
        <text className="puml-keyword" x={inset + 9} y={frame.start + 15}>{frame.group}</text>
        {frame.label && <text className="puml-frame-label" x={inset + tabWidth + 8} y={frame.start + 16}>{frame.label}</text>}
        {frame.branches.map((branch, branchIndex) => (
          <g key={`branch-${branchIndex}`}>
            <line className="puml-frame-divider" x1={inset} y1={branch.y} x2={width - inset} y2={branch.y} />
            <text className="puml-frame-label" x={inset + 10} y={branch.y + 16}>[{branch.label || "else"}]</text>
          </g>
        ))}
      </g>
    );
  });

  return (
    <svg className="puml-diagram" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PlantUML 时序图">
      <defs>
        <marker id={arrow} markerWidth="7" markerHeight="5" refX="6.5" refY="2.5" orient="auto"><path d="M0,0 L7,2.5 L0,5 z" /></marker>
        <marker id={returnArrow} markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path className="puml-open-arrow" d="M.5,.5 L8,3.5 L.5,6.5" /></marker>
      </defs>
      {frameNodes}
      {model.participants.map((participant, index) => (
        <g key={participant.alias}>
          <line className="puml-lifeline" x1={positions[index]} y1="62" x2={positions[index]} y2={diagramBottom} />
          <rect className="puml-participant" x={positions[index] - headWidths[index] / 2} y="12" width={headWidths[index]} height="42" rx="6" />
          <SvgText className="puml-participant-text" x={positions[index]} y={textLines(participant.label).length > 1 ? 29 : 37} lines={textLines(participant.label)} />
          <rect className="puml-participant" x={positions[index] - headWidths[index] / 2} y={diagramBottom} width={headWidths[index]} height="38" rx="6" />
          <SvgText className="puml-participant-text" x={positions[index]} y={diagramBottom + 24} lines={[participant.label.replace(/\\n/g, " ")]} />
        </g>
      ))}
      {placed.map(({ row, y: rowY }, index) => {
        if (row.kind === "message") {
          const from = participantX(row.from);
          const to = participantX(row.to);
          const labelLines = textLines(row.text);
          if (from === to) {
            return (
              <g key={`row-${index}`}>
                <path className={`puml-message${row.dashed ? " is-return" : ""}`} markerEnd={`url(#${row.dashed ? returnArrow : arrow})`} d={`M${from} ${rowY + 18}h42v22h-37`} />
                <SvgText className="puml-message-text" x={from + 48} y={rowY + 12} lines={labelLines} anchor="start" />
              </g>
            );
          }
          return (
            <g key={`row-${index}`}>
              <line className={`puml-message${row.dashed ? " is-return" : ""}`} x1={from} y1={rowY + 24} x2={to} y2={rowY + 24} markerEnd={`url(#${row.dashed ? returnArrow : arrow})`} />
              <SvgText className="puml-message-text" x={(from + to) / 2} y={rowY + 16 - (labelLines.length - 1) * 7} lines={labelLines} />
            </g>
          );
        }
        if (row.kind === "note") {
          const anchors = row.targets.map(participantX);
          const center = (Math.min(...anchors) + Math.max(...anchors)) / 2;
          const noteWidth = Math.min(330, Math.max(150, ...row.lines.map((line) => visualLength(line) * 7 + 28)));
          let x = center - noteWidth / 2;
          if (row.position === "right") x = anchors[0] + 20;
          if (row.position === "left") x = anchors[0] - noteWidth - 20;
          x = Math.max(8, Math.min(width - noteWidth - 8, x));
          const noteHeight = Math.max(34, row.lines.length * 16 + 18);
          return (
            <g key={`row-${index}`}>
              <path className="puml-note" d={`M${x} ${rowY + 5}h${noteWidth - 12}l12 12v${noteHeight - 12}h-${noteWidth}z`} />
              <path className="puml-note-fold" d={`M${x + noteWidth - 12} ${rowY + 5}v12h12`} />
              <SvgText className="puml-note-text" x={x + 12} y={rowY + 25} lines={row.lines} anchor="start" />
            </g>
          );
        }
        return null;
      })}
    </svg>
  );
}

export function PlantUml({ source }: { source: string }) {
  // 谁来画由证据定,不由先后定。原来是"先试时序图,认不出再试类图",
  // 结果类图里的 `A --> B` 被时序解析器当成消息全盘收下,整张类图被画成
  // 时序图还落款"时序图 · 内置渲染"——类图那边怎么修都不会上屏。
  const classes = looksLikeClassDiagram(source)
    ? parseClassDiagram(source) : undefined;
  const model = classes ? undefined : parseSequence(source);
  return (
    <figure className="plantuml-figure">
      {model ? (
        <SequenceDiagram model={model} />
      ) : classes ? (
        <>
          <ClassDiagram model={classes} />
          <ClassDiagramLegend />
        </>
      ) : (
        <div className="plantuml-unsupported">
          <strong>这段 PlantUML 暂时无法安全绘制</strong>
          <span>已保留源码，避免把不支持的语法画错。</span>
        </div>
      )}
      <figcaption>{model ? "时序图 · 内置渲染"
        : classes ? "类图 · 内置渲染" : "PlantUML 源码"}</figcaption>
      <details className="plantuml-source">
        <summary>查看 PlantUML 源码</summary>
        <pre><code>{source}</code></pre>
      </details>
    </figure>
  );
}
