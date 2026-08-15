/**
 * PlantUML 类图解析。
 *
 * 为什么单独一份:内置渲染器原来只认时序图,模型按批注画了类图,页面上
 * 落到"这段 PlantUML 暂时无法安全绘制"——**用户以为它没画**,其实源码
 * 好好躺在 story.md 里。渲染缺口冒充成模型失职,是最坏的一种误导。
 *
 * 解析器是纯函数,放这儿根测试才钉得住(web/ 没有测试运行器)。
 * 认不出的语法一律忽略,绝不猜:画错的图比不画更害人。
 */

export type NodeKind = "class" | "interface" | "enum" | "abstract";

export interface ClassNode {
  name: string;
  kind: NodeKind;
  /** 所属包(嵌套包用 / 连接);顶层为空串。 */
  pkg: string;
  members: string[];
}

/** 关系语义认这七类,其余按依赖兜底——线型是给人看的,不能瞎标。 */
export type EdgeKind =
  | "implements" | "extends" | "uses" | "associates"
  | "composes" | "aggregates" | "nests";

export interface ClassEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface ClassModel {
  nodes: ClassNode[];
  edges: ClassEdge[];
}

const NODE_HEAD =
  /^(abstract\s+class|class|interface|enum)\s+("([^"]+)"|[\w.$]+)(?:\s+as\s+[\w.$]+)?\s*(\{)?\s*$/i;
const PACKAGE_HEAD = /^package\s+("([^"]+)"|[^\s{]+)\s*(?:<<[^>]*>>\s*)?\{\s*$/i;
const NOTE_HEAD = /^note\s+/i;

/** `A ..|> B : 标签` / `A --> B` / `A *-- B` / `A ..> B` / `A +-- B`(内部类)。
 * `+` 一开始没进箭头字符集,`ConnPool +-- Connection` 这行就被整条丢掉了
 * ——图上少一条关系没有任何提示,比画错更难发现。 */
const EDGE = /^([\w.$"]+)\s+([.\-|<>*o+]{2,})\s+([\w.$"]+)\s*(?::\s*(.*))?$/;

function unquote(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function edgeKind(arrow: string): EdgeKind {
  // 顺序要紧:`..|>` 同时含 `..` 和 `|>`,实现关系必须先判。
  if (arrow.includes("|>")) return arrow.includes("..") ? "implements" : "extends";
  // `+--` 是内部类,不是组合:画成实心菱形会把"语法上嵌在里面"说成
  // "生命周期归它管",两回事。
  if (arrow.includes("+")) return "nests";
  if (arrow.includes("*")) return "composes";
  if (arrow.includes("o")) return "aggregates";
  // UML 里虚线才是依赖,实线是关联(持有引用)。原来把两者一起兜底成
  // uses,同一张图上 7 条关联和 9 条依赖长得一模一样——这正是"画得不像
  // 标准类图,像简化版"的由来:线型不分,结构就读不出来。
  if (arrow.startsWith("..")) return "uses";
  return "associates";
}

/** 只可能出现在类图里的记号。`-->` 两边都用,不算数;这几个不同:
 * 时序图里没有 `class X`,也没有实现/组合/内部类的箭头。 */
const CLASS_ONLY = [
  /^\s*(?:abstract\s+class|class|interface|enum)\s+["\w.$]/im,
  /\.\.\|>|--\|>/,          // 实现 / 继承
  /\s\*--|--\*\s/,          // 组合
  /\so--|--o\s/,            // 聚合
  /\s\+--|--\+\s/,          // 内部类
];

/**
 * 这段源码是不是类图。
 *
 * 存在的理由是一个真事故:渲染器原来"先试时序图,认不出再试类图",而类图
 * 里 `NotifyService --> HandlerRegistry` 这种关系,时序解析器会当成"消息",
 * 两端当成"参与者"——照单全收。于是整张类图被画成一张时序图,页面上还
 * 落款"时序图 · 内置渲染"。用户看到的图从头到尾都不是类图,而类图那边
 * 怎么修都不会上屏。
 *
 * 教训:两个解析器都可能"认得出"同一段源码时,先后顺序不是判定,证据才是。
 */
export function looksLikeClassDiagram(source: string): boolean {
  return CLASS_ONLY.some((mark) => mark.test(source));
}

export function parseClassDiagram(source: string): ClassModel | undefined {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: ClassNode[] = [];
  const edges: ClassEdge[] = [];
  const packages: string[] = [];
  let body: ClassNode | undefined;      // 正在读成员的那个类
  let inNote = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (inNote) {
      if (/^end\s*note$/i.test(line)) inNote = false;
      continue;
    }
    if (NOTE_HEAD.test(line)) {
      // 单行 note(带冒号)不进多行模式
      if (!/:/.test(line)) inNote = true;
      continue;
    }
    if (/^@(start|end)uml/i.test(line) || /^skinparam\b/i.test(line)
        || /^hide\b/i.test(line) || /^'/.test(line)) {
      continue;
    }

    if (body) {
      if (line === "}") { body = undefined; continue; }
      body.members.push(line);
      continue;
    }

    if (line === "}") { packages.pop(); continue; }

    const pack = line.match(PACKAGE_HEAD);
    if (pack) { packages.push(unquote(pack[3] ?? pack[1])); continue; }

    const head = line.match(NODE_HEAD);
    if (head) {
      const kind = /abstract/i.test(head[1])
        ? "abstract"
        : head[1].toLowerCase() as NodeKind;
      const node: ClassNode = {
        name: unquote(head[3] ?? head[2]),
        kind,
        pkg: packages.join("/"),
        members: [],
      };
      nodes.push(node);
      if (head[4]) body = node;
      continue;
    }

    const edge = line.match(EDGE);
    if (edge) {
      edges.push({
        from: unquote(edge[1]),
        to: unquote(edge[3]),
        kind: edgeKind(edge[2]),
        label: edge[4]?.trim() || undefined,
      });
    }
  }

  if (!nodes.length) return undefined;
  // 关系里出现却没声明过的类型补成节点:漏一个节点整张图就断,
  // 而 PlantUML 本来就允许只在关系里出现。
  const known = new Set(nodes.map((node) => node.name));
  for (const edge of edges) {
    for (const name of [edge.from, edge.to]) {
      if (!known.has(name)) {
        known.add(name);
        nodes.push({ name, kind: "class", pkg: "", members: [] });
      }
    }
  }
  return { nodes, edges };
}

export interface LaidOutNode extends ClassNode {
  layer: number;
  order: number;
}

/**
 * 分层:被依赖的排上面,依赖别人的排下面。
 *
 * 用最长路径而不是拓扑序——同一层里的类才是"平级"的,看图的人一眼能
 * 认出"这几个是一类东西"。环(A→B→A)按访问集合截断,不许无限递归:
 * 类图里的环很常见,画不出层次也绝不能把页面转死。
 */
export function layerClasses(model: ClassModel): LaidOutNode[] {
  const byName = new Map(model.nodes.map((node) => [node.name, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of model.edges) {
    if (!byName.has(edge.from) || !byName.has(edge.to)) continue;
    // 继承/实现要反向:UML 约定父类与接口画在上面,实现画在下面。
    // 按依赖方向直接排会把接口压到实现类底下——图是对的但读着是倒的,
    // 而类图的第一价值就是"一眼看出谁是抽象、谁是落地"。
    const inherits = edge.kind === "implements" || edge.kind === "extends";
    const [head, tail] = inherits ? [edge.to, edge.from] : [edge.from, edge.to];
    outgoing.set(head, [...(outgoing.get(head) ?? []), tail]);
  }
  const depth = new Map<string, number>();
  const visit = (name: string, seen: Set<string>): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (seen.has(name)) return 0;              // 环:就地截断
    seen.add(name);
    const next = outgoing.get(name) ?? [];
    const value = next.length
      ? Math.max(...next.map((child) => visit(child, seen))) + 1
      : 0;
    seen.delete(name);
    depth.set(name, value);
    return value;
  };
  for (const node of model.nodes) visit(node.name, new Set());

  const deepest = Math.max(0, ...[...depth.values()]);
  const laid = model.nodes.map((node) => ({
    ...node,
    // 依赖得多的在上:层号翻转,读图从"入口"往"底座"走
    layer: deepest - (depth.get(node.name) ?? 0),
    order: 0,
  }));
  // 同层内按包聚拢,同包的挨着——包是人理解结构的第一把抓手
  const byLayer = new Map<number, LaidOutNode[]>();
  for (const node of laid) {
    byLayer.set(node.layer, [...(byLayer.get(node.layer) ?? []), node]);
  }
  for (const group of byLayer.values()) {
    group.sort((left, right) => left.pkg === right.pkg
      ? left.name.localeCompare(right.name)
      : left.pkg.localeCompare(right.pkg));
    group.forEach((node, at) => { node.order = at; });
  }
  return laid;
}
