/**
 * 批注的"点哪儿算哪一行":纯逻辑,不碰 React,好单测。
 *
 * 单独抽出来是因为它踩过的坑全是**静静地什么也不发生**:点了没反应、
 * 悬停不出图标——用户只会说"批注功能点不了",而代码里三处 `return` 都
 * 不吭声。列一下真实的哑火来源:
 * - 点在容器上而不是行上:Markdown 的列表是 `<ul>` 包 `<li>`,行号挂在
 *   li 上,点到 ul 的内边距/缩进区就什么也不是;段落之间的空隙同理;
 * - 空行/图块的原文快照是空的(anchorOf 返回 ""),于是拒绝开框;
 * - 页面上任意位置残留一段选区就整体禁用(判据是全文档的 selection,
 *   而不是"你刚在这块材料里划了词")。
 *
 * 这里的口径:**尽量把点击落到最近的一行上**,实在落不到就由调用方
 * 说人话(而不是装作没点)。判定与理由都可测,UI 只管照着做。
 */

/** 只依赖这几个 DOM 能力,便于测试里用假节点裁。 */
export interface RowNode {
  dataset: Record<string, string | undefined>;
  textContent: string | null;
  closest(selector: string): RowNode | null;
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): ArrayLike<RowNode>;
  getBoundingClientRect?: () => { top: number; bottom: number };
}

/** 原文快照的长度上限,和内核面板一致:够定位,又不至于把整段搬走。 */
export const ANCHOR_MAX = 90;

/** 原文快照只取"内容"那一段(diff 行里夹着行号与 +/− 标记,整行抓下来
 * 是脏原文,回头重锚定一比一个不中)。空内容不再判死:空行也能圈,
 * 锚点退回"第 N 行"——人指的是位置,不一定是文字。 */
export function anchorOf(row: RowNode, line: number): string {
  const content = row.querySelector("[data-code]") ?? row;
  const text = (content.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return `第 ${line} 行`;
  return text.length > ANCHOR_MAX ? text.slice(0, ANCHOR_MAX) : text;
}

function lineOf(row: RowNode): number {
  const line = Number(row.dataset.l);
  return Number.isFinite(line) && line > 0 ? line : 0;
}

/** 点击/悬停落点 → 该批注哪一行。
 *
 * 顺序:落点自身或祖先带行号 → 落点是容器(ul/div)时取容器里第一行
 * (点列表缩进区就算点第一条,比"什么也不发生"强)→ 都没有则 undefined。
 */
export function pickRow(
  target: RowNode | null | undefined,
  root: RowNode | null | undefined,
): RowNode | undefined {
  if (!target || !root) return undefined;
  // 交互元素(按钮/链接/输入框/编辑框自身)不抢:那儿有它自己的活。
  if (target.closest("button, a, textarea, input, .annot-editor")) {
    return undefined;
  }
  const own = target.closest("[data-l]");
  if (own && lineOf(own)) return own;
  // 落在容器上:退一步取容器内的第一行。Markdown 的 <ul>、diff 的
  // 表体都属于这种"看着是材料、其实不带行号"的壳。
  const inside = target.querySelectorAll?.("[data-l]");
  for (let index = 0; index < (inside?.length ?? 0); index += 1) {
    const candidate = inside![index];
    if (lineOf(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 划词是在读,不是要批注——但只认**这块材料里**的划词。
 *
 * 原来判据是"文档里任何地方有选区就不开框",于是在别处(决策卡、
 * 侧栏、甚至上一次搜索留下的高亮)残留一段选中文本,材料就整片点不动,
 * 表现正是"批注功能点不了"。选区还必须是真的划开了(非折叠)。
 */
export function blockedBySelection(selection: {
  isCollapsed?: boolean;
  toString(): string;
  anchorNode?: unknown;
} | null | undefined, contains: (node: unknown) => boolean): boolean {
  if (!selection) return false;
  if (selection.isCollapsed) return false;
  if (!selection.toString().trim()) return false;
  return contains(selection.anchorNode);
}
