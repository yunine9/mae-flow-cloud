import { useId } from "react";
import type {
  TopologyModel, TopologyNode, TopologyNodeKind,
} from "./topologyModel";

const NODE_WIDTH = 218;
const NODE_HEIGHT = 78;
const MAIN_GAP = 112;
const CROSS_GAP = 34;
const PADDING = 40;

function visualLength(text: string): number {
  return Array.from(text).reduce((sum, char) =>
    sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : .58), 0);
}

function labelLines(label: string): string[] {
  const explicit = label.split(/\\n|\n/).filter(Boolean);
  if (explicit.length > 1 || visualLength(label) <= 24) return explicit;
  const chars = Array.from(label);
  const half = Math.ceil(chars.length / 2);
  return [chars.slice(0, half).join(""), chars.slice(half).join("")];
}

function levelsOf(model: TopologyModel): Map<string, number> {
  const incoming = new Map(model.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(model.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of model.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const level = new Map(model.nodes.map((node) => [node.id, 0]));
  const queue = model.nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    seen.add(id);
    for (const child of outgoing.get(id) ?? []) {
      level.set(child, Math.max(level.get(child) ?? 0, (level.get(id) ?? 0) + 1));
      incoming.set(child, (incoming.get(child) ?? 1) - 1);
      if (!incoming.get(child)) queue.push(child);
    }
  }
  const last = Math.max(0, ...level.values());
  model.nodes.filter((node) => !seen.has(node.id))
    .forEach((node) => level.set(node.id, last + 1));
  return level;
}

const KIND_LABEL: Record<TopologyNodeKind, string> = {
  component: "组件", package: "包", node: "节点", database: "数据",
  cloud: "云", artifact: "制品", folder: "目录", rectangle: "边界",
  queue: "队列", storage: "存储", actor: "角色", usecase: "用例",
  state: "状态", interface: "接口", entity: "实体", generic: "节点",
  start: "开始", end: "结束",
};

function NodeShape({ node, x, y }: { node: TopologyNode; x: number; y: number }) {
  const values = labelLines(node.label);
  const centerY = y - (values.length - 1) * 8;
  if (node.kind === "start" || node.kind === "end") {
    return <g className={`topology-node topology-${node.kind}`}>
      <circle cx={x} cy={y} r="11" />
      {node.kind === "end" && <circle className="topology-end-inner" cx={x} cy={y} r="6" />}
    </g>;
  }
  if (node.kind === "actor") {
    return <g className="topology-node topology-actor">
      <circle cx={x} cy={y - 19} r="8" />
      <path d={`M${x} ${y - 11}V${y + 10}M${x - 15} ${y - 2}H${x + 15}`
        + `M${x} ${y + 10}L${x - 12} ${y + 27}M${x} ${y + 10}L${x + 12} ${y + 27}`} />
      <text x={x} y={y + 45} textAnchor="middle">{node.label}</text>
    </g>;
  }
  const usecase = node.kind === "usecase";
  return <g className={`topology-node topology-kind-${node.kind}`}>
    {usecase
      ? <ellipse cx={x} cy={y} rx={NODE_WIDTH / 2} ry={NODE_HEIGHT / 2} />
      : <rect x={x - NODE_WIDTH / 2} y={y - NODE_HEIGHT / 2}
          width={NODE_WIDTH} height={NODE_HEIGHT} rx={node.kind === "cloud" ? 28 : 10} />}
    <text className="topology-kind" x={x - NODE_WIDTH / 2 + 11}
      y={y - NODE_HEIGHT / 2 + 16}>{KIND_LABEL[node.kind]}</text>
    <text className="topology-label" x={x} y={centerY + 4} textAnchor="middle">
      {values.map((value, index) => <tspan key={index} x={x}
        dy={index ? 17 : 0}>{value}</tspan>)}
    </text>
    {node.group && <text className="topology-group" x={x}
      y={y + NODE_HEIGHT / 2 - 9} textAnchor="middle">归属 · {node.group}</text>}
    {node.notes.length > 0 && <title>{node.notes.join("；")}</title>}
  </g>;
}

export function TopologyDiagram({ model }: { model: TopologyModel }) {
  const marker = `topology-arrow-${useId().replace(/:/g, "")}`;
  const horizontal = model.direction === "LR" || model.direction === "RL";
  const reverse = model.direction === "RL" || model.direction === "BT";
  const levels = levelsOf(model);
  const maxLevel = Math.max(0, ...levels.values());
  const groups = Array.from({ length: maxLevel + 1 }, (_, value) =>
    model.nodes.filter((node) => levels.get(node.id) === value)
      .sort((left, right) => `${left.group}/${left.label}`
        .localeCompare(`${right.group}/${right.label}`)));
  const crossCount = Math.max(1, ...groups.map((items) => items.length));
  const mainSize = PADDING * 2 + (maxLevel + 1) * NODE_WIDTH + maxLevel * MAIN_GAP;
  const crossSize = PADDING * 2 + crossCount * NODE_HEIGHT
    + Math.max(0, crossCount - 1) * CROSS_GAP;
  const titleSpace = model.title ? 38 : 0;
  const width = horizontal ? mainSize : Math.max(620, crossSize);
  const height = (horizontal ? Math.max(190, crossSize) : mainSize) + titleSpace;
  const positions = new Map<string, { x: number; y: number }>();
  groups.forEach((items, rawLevel) => {
    const level = reverse ? maxLevel - rawLevel : rawLevel;
    const occupied = items.length * NODE_HEIGHT
      + Math.max(0, items.length - 1) * CROSS_GAP;
    items.forEach((node, index) => {
      const cross = (crossSize - occupied) / 2 + NODE_HEIGHT / 2
        + index * (NODE_HEIGHT + CROSS_GAP);
      const main = PADDING + NODE_WIDTH / 2 + level * (NODE_WIDTH + MAIN_GAP);
      positions.set(node.id, horizontal
        ? { x: main, y: cross + titleSpace }
        : { x: cross, y: main + titleSpace });
    });
  });

  return <svg className="puml-diagram topology-diagram"
    viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PlantUML 架构拓扑图">
    <defs>
      <marker id={marker} markerWidth="8" markerHeight="6" refX="7.5" refY="3"
        orient="auto"><path d="M0,0 L8,3 L0,6 z" /></marker>
    </defs>
    {model.title && <text className="topology-title" x="18" y="26">{model.title}</text>}
    {model.edges.map((edge, index) => {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      if (edge.from === edge.to) {
        const right = from.x + NODE_WIDTH / 2;
        const loop = `M${right} ${from.y - 10}C${right + 70} ${from.y - 56},`
          + `${right + 70} ${from.y + 56},${right} ${from.y + 10}`;
        return <g key={`${edge.from}-${edge.to}-${index}`}>
          <path className={`topology-edge${edge.dashed ? " dashed" : ""}`}
            d={loop} markerEnd={edge.directed ? `url(#${marker})` : undefined} />
          {edge.label && <text className="topology-edge-label"
            x={right + 72} y={from.y - 2} textAnchor="start">{edge.label}</text>}
        </g>;
      }
      const horizontalEdge = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
      const sign = horizontalEdge ? Math.sign(to.x - from.x) : Math.sign(to.y - from.y);
      const start = horizontalEdge
        ? { x: from.x + sign * NODE_WIDTH / 2, y: from.y }
        : { x: from.x, y: from.y + sign * NODE_HEIGHT / 2 };
      const end = horizontalEdge
        ? { x: to.x - sign * NODE_WIDTH / 2, y: to.y }
        : { x: to.x, y: to.y - sign * NODE_HEIGHT / 2 };
      const path = horizontalEdge
        ? `M${start.x} ${start.y}C${(start.x + end.x) / 2} ${start.y},`
          + `${(start.x + end.x) / 2} ${end.y},${end.x} ${end.y}`
        : `M${start.x} ${start.y}C${start.x} ${(start.y + end.y) / 2},`
          + `${end.x} ${(start.y + end.y) / 2},${end.x} ${end.y}`;
      return <g key={`${edge.from}-${edge.to}-${index}`}>
        <path className={`topology-edge${edge.dashed ? " dashed" : ""}`}
          d={path} markerEnd={edge.directed ? `url(#${marker})` : undefined} />
        {edge.label && <text className="topology-edge-label"
          x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 8}
          textAnchor="middle">{edge.label}</text>}
      </g>;
    })}
    {model.nodes.map((node) => {
      const point = positions.get(node.id)!;
      return <NodeShape key={node.id} node={node} x={point.x} y={point.y} />;
    })}
  </svg>;
}
