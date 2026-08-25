/** PlantUML 活动图的零依赖 SVG 渲染。只接收 activityModel 已完整校验的模型。 */

import { useId, type ReactNode } from "react";
import type { ActivityItem, ActivityModel } from "./activityModel";

interface Point { x: number; y: number }
interface Box { x: number; y: number; width: number; height: number }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
interface LayoutResult {
  cursor?: Point;
  y: number;
  bounds: Bounds;
  lastBox?: Box;
}
interface Layers {
  backgrounds: ReactNode[];
  edges: ReactNode[];
  nodes: ReactNode[];
  labels: ReactNode[];
  nextKey: number;
  arrow: string;
}

const MAIN_X = 510;
const BRANCH_GAP = 360;
const EMPTY: Bounds = {
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
};

function lines(text: string): string[] {
  return text.split(/\\n|\n/).map((line) => line.trim()).filter(Boolean);
}

function visualLength(text: string): number {
  return Array.from(text).reduce((sum, char) =>
    sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .58), 0);
}

function union(...values: Bounds[]): Bounds {
  const present = values.filter((value) => Number.isFinite(value.minX));
  if (!present.length) return { ...EMPTY };
  return {
    minX: Math.min(...present.map((value) => value.minX)),
    minY: Math.min(...present.map((value) => value.minY)),
    maxX: Math.max(...present.map((value) => value.maxX)),
    maxY: Math.max(...present.map((value) => value.maxY)),
  };
}

function boxBounds(box: Box, padding = 0): Bounds {
  return {
    minX: box.x - padding,
    minY: box.y - padding,
    maxX: box.x + box.width + padding,
    maxY: box.y + box.height + padding,
  };
}

function key(layers: Layers, prefix: string): string {
  layers.nextKey += 1;
  return `${prefix}-${layers.nextKey}`;
}

function TextLines({ x, y, values, className, anchor = "middle" }: {
  x: number;
  y: number;
  values: string[];
  className: string;
  anchor?: "start" | "middle" | "end";
}) {
  return (
    <text x={x} y={y} className={className} textAnchor={anchor}>
      {values.map((value, index) => (
        <tspan key={`${value}-${index}`} x={x} dy={index === 0 ? 0 : 17}>{value}</tspan>
      ))}
    </text>
  );
}

function pathBetween(from: Point, to: Point): string {
  if (Math.abs(from.x - to.x) < 1) return `M${from.x} ${from.y}V${to.y}`;
  const turnY = from.y + Math.max(0, (to.y - from.y) / 2);
  return `M${from.x} ${from.y}V${turnY}H${to.x}V${to.y}`;
}

function connect(layers: Layers, from: Point | undefined, to: Point, arrow = true) {
  if (!from) return;
  layers.edges.push(
    <path key={key(layers, "flow")} className="puml-flow"
      d={pathBetween(from, to)}
      markerEnd={arrow ? `url(#${layers.arrow})` : undefined} />,
  );
}

function actionSize(text: string): { width: number; height: number; textLines: string[] } {
  const textLines = lines(text);
  const width = Math.min(470, Math.max(190,
    ...textLines.map((line) => visualLength(line) * 7.2 + 38)));
  return { width, height: Math.max(42, textLines.length * 17 + 22), textLines };
}

function layoutSequence(
  items: ActivityItem[],
  x: number,
  fromY: number,
  incoming: Point | undefined,
  layers: Layers,
): LayoutResult {
  let cursor = incoming;
  let y = fromY;
  let bounds = { ...EMPTY };
  let lastBox: Box | undefined;

  for (const item of items) {
    if (item.kind === "start") {
      const centerY = y + 10;
      connect(layers, cursor, { x, y: centerY - 10 });
      layers.nodes.push(<circle key={key(layers, "start")} className="puml-start"
        cx={x} cy={centerY} r="10" />);
      const box = { x: x - 10, y, width: 20, height: 20 };
      bounds = union(bounds, boxBounds(box));
      cursor = { x, y: centerY + 10 };
      lastBox = box;
      y += 48;
      continue;
    }

    if (item.kind === "stop") {
      const centerY = y + 11;
      connect(layers, cursor, { x: cursor?.x ?? x, y: centerY - 11 });
      const stopX = cursor?.x ?? x;
      layers.nodes.push(
        <g key={key(layers, "stop")}>
          <circle className="puml-stop-outer" cx={stopX} cy={centerY} r="11" />
          <circle className="puml-stop-inner" cx={stopX} cy={centerY} r="6" />
        </g>,
      );
      const box = { x: stopX - 11, y, width: 22, height: 22 };
      bounds = union(bounds, boxBounds(box));
      cursor = undefined;
      lastBox = box;
      y += 48;
      continue;
    }

    if (item.kind === "action") {
      const size = actionSize(item.text);
      const box = { x: x - size.width / 2, y, width: size.width, height: size.height };
      connect(layers, cursor, { x, y });
      layers.nodes.push(
        <g key={key(layers, "action")}>
          <rect className="puml-activity" {...box} rx={Math.min(18, box.height / 2)} />
          <TextLines className="puml-activity-text" x={x}
            y={y + (box.height - (size.textLines.length - 1) * 17) / 2 + 4}
            values={size.textLines} />
        </g>,
      );
      bounds = union(bounds, boxBounds(box));
      cursor = { x, y: y + box.height };
      lastBox = box;
      y += box.height + 38;
      continue;
    }

    if (item.kind === "note") {
      const noteLines = lines(item.text);
      const noteWidth = Math.min(420, Math.max(190,
        ...noteLines.map((line) => visualLength(line) * 7 + 34)));
      const noteHeight = Math.max(44, noteLines.length * 17 + 22);
      const anchor = lastBox ?? {
        x: (cursor?.x ?? x) - 10,
        y: (cursor?.y ?? y) - 20,
        width: 20,
        height: 20,
      };
      const rawX = item.position === "right"
        ? anchor.x + anchor.width + 34 : anchor.x - noteWidth - 34;
      const noteX = Math.max(20, rawX);
      const noteY = anchor.y + Math.max(0, (anchor.height - noteHeight) / 2);
      const from = item.position === "right"
        ? { x: anchor.x + anchor.width, y: anchor.y + anchor.height / 2 }
        : { x: anchor.x, y: anchor.y + anchor.height / 2 };
      const to = item.position === "right"
        ? { x: noteX, y: noteY + noteHeight / 2 }
        : { x: noteX + noteWidth, y: noteY + noteHeight / 2 };
      layers.edges.push(<line key={key(layers, "note-link")}
        className="puml-note-link" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />);
      layers.nodes.push(
        <g key={key(layers, "activity-note")}>
          <path className="puml-note"
            d={`M${noteX} ${noteY}h${noteWidth - 13}l13 13v${noteHeight - 13}h-${noteWidth}z`} />
          <path className="puml-note-fold"
            d={`M${noteX + noteWidth - 13} ${noteY}v13h13`} />
          <TextLines className="puml-note-text" x={noteX + 12} y={noteY + 25}
            values={noteLines} anchor="start" />
        </g>,
      );
      bounds = union(bounds, boxBounds({
        x: noteX, y: noteY, width: noteWidth, height: noteHeight,
      }));
      y = Math.max(y, noteY + noteHeight + 22);
      continue;
    }

    if (item.kind === "partition") {
      const top = y;
      const nested = layoutSequence(item.items, x, y + 40, cursor, layers);
      const inner = Number.isFinite(nested.bounds.minX)
        ? nested.bounds : { minX: x - 120, minY: top + 34, maxX: x + 120, maxY: top + 80 };
      const partitionBox: Box = {
        x: Math.max(12, inner.minX - 25),
        y: top,
        width: inner.maxX - Math.max(12, inner.minX - 25) + 25,
        height: Math.max(84, nested.y - top + 4),
      };
      layers.backgrounds.push(
        <g key={key(layers, "partition")}>
          <rect className="puml-partition" {...partitionBox} rx="8" />
          <rect className="puml-partition-tab" x={partitionBox.x} y={partitionBox.y}
            width={Math.min(partitionBox.width, visualLength(item.label) * 7 + 28)}
            height="27" rx="8" />
          <text className="puml-partition-title" x={partitionBox.x + 12}
            y={partitionBox.y + 18}>{item.label}</text>
        </g>,
      );
      bounds = union(bounds, boxBounds(partitionBox), nested.bounds);
      cursor = nested.cursor;
      lastBox = nested.lastBox;
      y = nested.y + 24;
      continue;
    }

    const diamondHalf = Math.min(230, Math.max(105,
      visualLength(item.condition) * 4.2 + 38));
    const diamondTop = y;
    const diamondMiddle = y + 30;
    const diamondBottom = y + 60;
    connect(layers, cursor, { x, y: diamondTop });
    layers.nodes.push(
      <g key={key(layers, "decision")}>
        <path className="puml-decision"
          d={`M${x} ${diamondTop}L${x + diamondHalf} ${diamondMiddle}`
            + `L${x} ${diamondBottom}L${x - diamondHalf} ${diamondMiddle}z`} />
        <TextLines className="puml-decision-text" x={x} y={diamondMiddle + 4}
          values={lines(item.condition)} />
      </g>,
    );
    const branchX = x + Math.max(BRANCH_GAP, diamondHalf + 190);
    const branchY = diamondBottom + 48;
    layers.labels.push(
      <text key={key(layers, "then-label")} className="puml-branch-label"
        x={x - 12} y={diamondBottom + 20} textAnchor="end">
        {item.thenLabel || "是"}
      </text>,
      <text key={key(layers, "else-label")} className="puml-branch-label"
        x={x + diamondHalf + 10} y={diamondMiddle - 8} textAnchor="start">
        {item.elseLabel || "否"}
      </text>,
    );
    const thenBranch = layoutSequence(item.thenItems, x, branchY,
      { x, y: diamondBottom }, layers);
    const elseBranch = layoutSequence(item.elseItems, branchX, branchY,
      { x: x + diamondHalf, y: diamondMiddle }, layers);
    const mergeY = Math.max(thenBranch.y, elseBranch.y) + 6;
    if (thenBranch.cursor) connect(layers, thenBranch.cursor, { x, y: mergeY }, false);
    if (elseBranch.cursor) connect(layers, elseBranch.cursor, { x, y: mergeY }, false);
    const hasMerge = Boolean(thenBranch.cursor || elseBranch.cursor);
    if (hasMerge) {
      layers.nodes.push(<circle key={key(layers, "merge")} className="puml-merge"
        cx={x} cy={mergeY} r="4" />);
      cursor = { x, y: mergeY };
    } else {
      cursor = undefined;
    }
    const decisionBounds: Bounds = {
      minX: x - diamondHalf,
      minY: diamondTop,
      maxX: Math.max(x + diamondHalf, branchX),
      maxY: mergeY + 4,
    };
    bounds = union(bounds, decisionBounds, thenBranch.bounds, elseBranch.bounds);
    lastBox = undefined;
    y = mergeY + 40;
  }

  return { cursor, y, bounds, lastBox };
}

export function ActivityDiagram({ model }: { model: ActivityModel }) {
  const marker = `activity-arrow-${useId().replace(/:/g, "")}`;
  const layers: Layers = {
    backgrounds: [], edges: [], nodes: [], labels: [], nextKey: 0, arrow: marker,
  };
  const top = model.title ? 55 : 24;
  const laid = layoutSequence(model.items, MAIN_X, top, undefined, layers);
  const width = Math.ceil(Math.max(980, laid.bounds.maxX + 34));
  const height = Math.ceil(Math.max(140, laid.y + 20));
  return (
    <svg className="puml-diagram puml-activity-diagram"
      viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PlantUML 活动图">
      <defs>
        <marker id={marker} markerWidth="8" markerHeight="6" refX="7.5" refY="3"
          orient="auto"><path d="M0,0 L8,3 L0,6 z" /></marker>
      </defs>
      {model.title && <text className="puml-activity-title" x="18" y="28">
        {model.title}
      </text>}
      {layers.backgrounds}
      {layers.edges}
      {layers.nodes}
      {layers.labels}
    </svg>
  );
}
