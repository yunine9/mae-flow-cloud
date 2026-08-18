/**
 * 批注落点规则(前端纯逻辑,用假 DOM 裁)。
 *
 * 用户实测:"批注功能点不了"。查下来不是权限也不是接口,是三处**一声
 * 不吭的 return**:点在容器上(Markdown 的 `<ul>` 包着带行号的 `<li>`,
 * 点缩进区就落空)、空行的原文快照为空、以及"页面上任何地方有选区就
 * 整块禁用"。三条都不报错、不提示,于是功能看起来就是坏的。
 *
 * 这里钉住修好后的口径:够得着就落到最近一行,够不着由调用方说人话;
 * 划词只认这块材料里的划词。DOM 用假的——规则是纯的,不值得为它拉一个
 * 浏览器进来(真手感由内网实走回报)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorOf, blockedBySelection, pickRow, type RowNode,
} from "../web/src/annotateTargets.ts";

/** 极简假节点:只实现规则用到的那几个 DOM 能力。 */
function node(spec: {
  tag?: string;
  cls?: string;
  line?: number;
  file?: string;
  text?: string;
  code?: string;
  children?: FakeNode[];
}): FakeNode {
  return new FakeNode(spec);
}

class FakeNode implements RowNode {
  dataset: Record<string, string | undefined> = {};
  children: FakeNode[];
  parent?: FakeNode;
  tag: string;
  cls: string;
  private text: string;
  private code?: string;

  constructor(spec: {
    tag?: string; cls?: string; line?: number; file?: string;
    text?: string; code?: string; children?: FakeNode[];
  }) {
    this.tag = spec.tag ?? "div";
    this.cls = spec.cls ?? "";
    this.text = spec.text ?? "";
    this.code = spec.code;
    if (spec.line !== undefined) this.dataset.l = String(spec.line);
    if (spec.file !== undefined) this.dataset.file = spec.file;
    this.children = spec.children ?? [];
    for (const child of this.children) child.parent = this;
  }

  get textContent(): string {
    return this.code ?? [this.text, ...this.children.map((c) => c.textContent)]
      .join("");
  }

  private matches(selector: string): boolean {
    return selector.split(",").map((one) => one.trim()).some((one) => {
      if (one === "[data-l]") return this.dataset.l !== undefined;
      if (one === "[data-file]") return this.dataset.file !== undefined;
      if (one === "[data-code]") return this.code !== undefined;
      if (one.startsWith(".")) return this.cls === one.slice(1);
      return this.tag === one;
    });
  }

  closest(selector: string): FakeNode | null {
    let cursor: FakeNode | undefined = this;
    while (cursor) {
      if (cursor.matches(selector)) return cursor;
      cursor = cursor.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

test("点在行上/行内文字上:都落到那一行", () => {
  const span = node({ tag: "span", text: "push 已发送" });
  const row = node({ tag: "p", cls: "md-p", line: 42, children: [span] });
  const root = node({ cls: "annotatable", children: [row] });
  assert.equal(pickRow(row, root), row);
  assert.equal(pickRow(span, root), row, "点行内的文字也算点这一行");
});

test("点在容器空隙上:退一步取容器里的第一行,不再什么都不发生", () => {
  // Markdown 的列表:行号在 li 上,ul 只是壳。点缩进区/项与项之间的
  // 空隙落到的就是 ul——这正是"点了没反应"的日常来源。
  const first = node({ tag: "li", line: 7, text: "第一条" });
  const list = node({
    tag: "ul", cls: "md-list",
    children: [first, node({ tag: "li", line: 8, text: "第二条" })],
  });
  const root = node({ cls: "annotatable", children: [list] });
  assert.equal(pickRow(list, root), first);
});

test("点在按钮/链接上不抢:那儿有它自己的活", () => {
  const button = node({ tag: "button", text: "展开 12 行未改动内容" });
  const row = node({ tag: "div", line: 3, children: [button] });
  const root = node({ cls: "annotatable", children: [row] });
  assert.equal(pickRow(button, root), undefined);
});

test("够不着任何一行时如实返回 undefined(由 UI 说人话,不是装作没点)", () => {
  const bare = node({ tag: "div", cls: "utility-note", text: "读取中" });
  const root = node({ cls: "annotatable", children: [bare] });
  assert.equal(pickRow(bare, root), undefined);
});

test("锚点:diff 行只取内容,空行退回「第 N 行」而不是放弃", () => {
  const dirty = node({
    tag: "div", line: 28,
    children: [
      node({ tag: "span", text: "28+" }),                 // 行号与 +/− 标记
      node({ tag: "span", code: '  say("push 已发送")' }), // data-code=内容
    ],
  });
  assert.equal(anchorOf(dirty, 28), 'say("push 已发送")',
    "脏原文进模型是噪声,回头重锚定还会整片误报");
  const blank = node({ tag: "p", line: 9, text: "   " });
  assert.equal(anchorOf(blank, 9), "第 9 行", "空行也得能圈,人指的是位置");
  const long = node({ tag: "p", line: 1, text: "长".repeat(200) });
  assert.equal(anchorOf(long, 1).length, 90);
});

test("划词只认这块材料里的:别处残留的选区不许把材料整片锁死", () => {
  const inside = { id: "in" };
  const outside = { id: "out" };
  const contains = (node: unknown) => node === inside;
  const dragging = {
    isCollapsed: false, toString: () => "一段划中的文字", anchorNode: inside,
  };
  assert.equal(blockedBySelection(dragging, contains), true,
    "正在这块材料里划词=在读,不弹编辑框");
  assert.equal(
    blockedBySelection({ ...dragging, anchorNode: outside }, contains), false,
    "别处(决策卡/侧栏/上次搜索)的选区不该让材料点不动");
  assert.equal(blockedBySelection(
    { isCollapsed: true, toString: () => "", anchorNode: inside }, contains),
    false, "点一下产生的折叠光标不算划词");
  assert.equal(blockedBySelection(null, contains), false);
});
