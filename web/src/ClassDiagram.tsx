/**
 * 类图渲染(零依赖 SVG)。
 *
 * 布局用简化的分层法:被依赖的排上面,同层内按包聚拢。不追求"没有交叉"
 * ——真正的正交布线要一整套算法,而这里的目的是让人**看懂结构**:哪些类、
 * 归哪个包、谁实现谁、谁用谁。线型按关系语义分:实现虚线空心箭头、
 * 组合实线实心菱形、依赖点线。
 *
 * 认不出的语法不画(见 classDiagram.ts):画错的图比不画更害人。
 */

import { useId } from "react";
import {
  layerClasses,
  type ClassEdge,
  type ClassModel,
  type LaidOutNode,
} from "./classModel";

const BOX_WIDTH = 252;
const LINE_HEIGHT = 15;
const HEAD_HEIGHT = 34;
const GAP_X = 26;
const GAP_Y = 60;
const PAD = 18;
/** 一行最多几个盒子:同层十个并排会把画布拉成 2000px 的横条,
 * 得横向滚动才看得全,等于没画。超了就折行,层内关系不变。 */
const ROW_MAX = 4;
/** 成员截断线。定在 6 的时候 NotifyService 的 send() 被折叠进"…还有 2 项"
 * ——读图的人看到的是一个没有入口方法的服务类,这不叫省略,叫误导。
 * 类图的第一价值就是成员;宁可图长一点。 */
const MEMBER_MAX = 16;
/** 单行字符上限。盒子 252px、成员 10.5px,留 12px 左边距,约放得下 40 个字。 */
const MEMBER_CHARS = 40;

const KIND_TAG: Record<LaidOutNode["kind"], string> = {
  class: "C",
  interface: "I",
  enum: "E",
  abstract: "A",
};

interface Placed extends LaidOutNode {
  x: number;
  y: number;
  height: number;
  shown: string[];
}

function place(nodes: LaidOutNode[]): { placed: Placed[]; width: number; height: number } {
  const layers = new Map<number, LaidOutNode[]>();
  for (const node of nodes) {
    layers.set(node.layer, [...(layers.get(node.layer) ?? []), node]);
  }
  const ordered = [...layers.keys()].sort((left, right) => left - right);
  const widest = Math.min(ROW_MAX,
    Math.max(1, ...ordered.map((key) => layers.get(key)!.length)));
  const canvasWidth = PAD * 2 + widest * BOX_WIDTH + (widest - 1) * GAP_X;

  const rows: LaidOutNode[][] = [];
  for (const key of ordered) {
    const group = [...layers.get(key)!].sort((a, b) => a.order - b.order);
    for (let at = 0; at < group.length; at += ROW_MAX) {
      rows.push(group.slice(at, at + ROW_MAX));
    }
  }

  const placed: Placed[] = [];
  let y = PAD;
  for (const group of rows) {
    const rowWidth = group.length * BOX_WIDTH + (group.length - 1) * GAP_X;
    let x = (canvasWidth - rowWidth) / 2;
    let tallest = 0;
    for (const node of group) {
      const shown = node.members.slice(0, MEMBER_MAX);
      const extra = node.members.length - shown.length;
      if (extra > 0) shown.push(`…还有 ${extra} 项`);
      const height = HEAD_HEIGHT + (node.pkg ? LINE_HEIGHT : 0)
        + shown.length * LINE_HEIGHT + (shown.length ? 10 : 6);
      placed.push({ ...node, x, y, height, shown });
      tallest = Math.max(tallest, height);
      x += BOX_WIDTH + GAP_X;
    }
    y += tallest + GAP_Y;
  }
  return { placed, width: canvasWidth, height: y - GAP_Y + PAD };
}

/** 边从下沿出、到上沿进;同层内的边走侧边,免得贴着盒子画。 */
function edgePath(from: Placed, to: Placed): string {
  const fromX = from.x + BOX_WIDTH / 2;
  const toX = to.x + BOX_WIDTH / 2;
  if (to.y > from.y) {
    const y1 = from.y + from.height;
    const y2 = to.y;
    const mid = (y1 + y2) / 2;
    return `M ${fromX} ${y1} C ${fromX} ${mid}, ${toX} ${mid}, ${toX} ${y2}`;
  }
  if (to.y < from.y) {
    const y1 = from.y;
    const y2 = to.y + to.height;
    const mid = (y1 + y2) / 2;
    return `M ${fromX} ${y1} C ${fromX} ${mid}, ${toX} ${mid}, ${toX} ${y2}`;
  }
  const y = from.y + from.height / 2;
  const bow = y + Math.max(from.height, to.height) / 2 + 18;
  return `M ${fromX} ${from.y + from.height} C ${fromX} ${bow}, ${toX} ${bow}, ${toX} ${to.y + to.height}`;
}

const EDGE_CLASS: Record<ClassEdge["kind"], string> = {
  implements: "cd-edge-implements",
  extends: "cd-edge-extends",
  uses: "cd-edge-uses",
  associates: "cd-edge-associates",
  composes: "cd-edge-composes",
  aggregates: "cd-edge-aggregates",
  nests: "cd-edge-nests",
};

export function ClassDiagram({ model }: { model: ClassModel }) {
  const arrow = useId().replace(/:/g, "");
  const { placed, width, height } = place(layerClasses(model));
  const byName = new Map(placed.map((node) => [node.name, node]));

  return (
    <div className="cd-scroll">
      <svg
        className="cd-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label="类图"
      >
        <defs>
          <marker id={`${arrow}-open`} viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="cd-marker-open" />
          </marker>
          <marker id={`${arrow}-dot`} viewBox="0 0 10 10" refX="9" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1.5 L 10 5 L 0 8.5" className="cd-marker-dot" />
          </marker>
          <marker id={`${arrow}-diamond`} viewBox="0 0 12 12" refX="11" refY="6"
                  markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 0 6 L 6 2 L 12 6 L 6 10 z" className="cd-marker-diamond" />
          </marker>
          <marker id={`${arrow}-hollow-diamond`} viewBox="0 0 12 12" refX="11"
                  refY="6" markerWidth="9" markerHeight="9"
                  orient="auto-start-reverse">
            <path d="M 0 6 L 6 2 L 12 6 L 6 10 z"
                  className="cd-marker-hollow-diamond" />
          </marker>
        </defs>

        {model.edges.map((edge, at) => {
          const from = byName.get(edge.from);
          const to = byName.get(edge.to);
          if (!from || !to) return null;
          // 组合的实心菱形画在"整体"那一端(A *-- B 里的 A),不是被包含
          // 的那端——画反了就把包含关系说反了。
          // 菱形画在"整体"那一端(A *-- B 里的 A),不是被包含的那端
          // ——画反了就把包含关系说反了。实心=组合,空心=聚合。
          const diamond = edge.kind === "composes" ? "diamond"
            : edge.kind === "aggregates" ? "hollow-diamond" : undefined;
          const nests = edge.kind === "nests";
          // 依赖和关联都是开放箭头(细 V),继承/实现才是空心三角。
          const marker = edge.kind === "uses" || edge.kind === "associates"
            ? "dot" : "open";
          // 内嵌关系没有方向,不画箭头;PlantUML 那个 ⊕ 端这里用线型区分。
          const end = diamond || nests
            ? undefined : `url(#${arrow}-${marker})`;
          // <title> 只收单个字符串:给它数组 React 直接不渲染,每条边的
          // 悬停说明就这么静静地全都没了。
          const tip = `${edge.from} ${EDGE_WORD[edge.kind]} ${edge.to}`
            + (edge.label ? ` — ${edge.label}` : "");
          return (
            <path
              key={at}
              className={`cd-edge ${EDGE_CLASS[edge.kind]}`}
              d={edgePath(from, to)}
              markerStart={diamond ? `url(#${arrow}-${diamond})` : undefined}
              markerEnd={end}
            >
              <title>{tip}</title>
            </path>
          );
        })}

        {placed.map((node) => (
          <g key={node.name} className={`cd-node cd-${node.kind}`}>
            <rect x={node.x} y={node.y} width={BOX_WIDTH} height={node.height}
                  rx={9} />
            <text className="cd-tag" x={node.x + 12} y={node.y + 21}>
              {KIND_TAG[node.kind]}
            </text>
            <text className="cd-name" x={node.x + 30} y={node.y + 21}>
              {node.name}
            </text>
            {node.pkg && (
              <text className="cd-pkg" x={node.x + 12} y={node.y + 21 + LINE_HEIGHT}>
                {node.pkg}
              </text>
            )}
            <line className="cd-rule" x1={node.x} y1={node.y + HEAD_HEIGHT
              + (node.pkg ? LINE_HEIGHT : 0) - 8}
              x2={node.x + BOX_WIDTH}
              y2={node.y + HEAD_HEIGHT + (node.pkg ? LINE_HEIGHT : 0) - 8} />
            {node.shown.map((member, at) => (
              <text key={at} className="cd-member" x={node.x + 12}
                    y={node.y + HEAD_HEIGHT + (node.pkg ? LINE_HEIGHT : 0)
                       + at * LINE_HEIGHT + 6}>
                {member.length > MEMBER_CHARS
                  ? member.slice(0, MEMBER_CHARS) + "…" : member}
              </text>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

const EDGE_WORD: Record<ClassEdge["kind"], string> = {
  implements: "实现",
  extends: "继承",
  uses: "依赖",
  associates: "关联",
  composes: "组合",
  aggregates: "聚合",
  nests: "内嵌",
};

/** 图例:线型的含义得写出来,不然读图的人得猜。 */
export function ClassDiagramLegend() {
  return (
    <div className="cd-legend">
      <span className="cd-legend-item implements">虚线空心箭头 · 实现</span>
      <span className="cd-legend-item extends">实线空心箭头 · 继承</span>
      <span className="cd-legend-item uses">点线箭头 · 依赖</span>
      <span className="cd-legend-item associates">实线箭头 · 关联</span>
      <span className="cd-legend-item composes">实心菱形 · 组合</span>
      <span className="cd-legend-item aggregates">空心菱形 · 聚合</span>
      <span className="cd-legend-item nests">双线 · 内嵌(内部类)</span>
    </div>
  );
}
