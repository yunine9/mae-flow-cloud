/**
 * 迷你 Markdown 渲染(零依赖):只做内核消息实际用到的子集——
 * 表格、**加粗**、`行内代码`、无序列表、标题、段落。
 * React 元素拼装,不走 innerHTML,天然免 XSS;认不出的行原样当
 * 段落展示,渲染器绝不吞内容。
 */

import type { ReactNode } from "react";

/** 行内:**加粗** 与 `代码`。 */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .filter(Boolean)
    .map((piece, index) => {
      if (piece.startsWith("**") && piece.endsWith("**")) {
        return <b key={index}>{piece.slice(2, -2)}</b>;
      }
      if (piece.startsWith("`") && piece.endsWith("`")) {
        return <code key={index} className="md-code">{piece.slice(1, -1)}</code>;
      }
      return piece;
    });
}

function tableCells(row: string): string[] {
  return row.replace(/^\|/, "").replace(/\|$/, "")
    .split("|").map((cell) => cell.trim());
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    // 表格:连续 | 行,第二行是分隔线则去掉它
    if (isTableRow(line)) {
      const rows: string[] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        if (!isDivider(lines[index])) rows.push(lines[index]);
        index += 1;
      }
      const [head, ...body] = rows.map(tableCells);
      blocks.push(
        <table key={key++} className="md-table">
          {head && (
            <thead><tr>
              {head.map((cell, i) => <th key={i}>{inline(cell)}</th>)}
            </tr></thead>
          )}
          <tbody>
            {body.map((cells, r) => (
              <tr key={r}>
                {cells.map((cell, i) => <td key={i}>{inline(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>);
      continue;
    }
    // 列表:连续 -/* 行
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, i) => <li key={i}>{inline(item)}</li>)}
        </ul>);
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      blocks.push(
        <div key={key++} className="md-heading">
          {inline(line.replace(/^#{1,4}\s+/, ""))}
        </div>);
      index += 1;
      continue;
    }
    blocks.push(<p key={key++} className="md-p">{inline(line)}</p>);
    index += 1;
  }
  return <div className="md">{blocks}</div>;
}
