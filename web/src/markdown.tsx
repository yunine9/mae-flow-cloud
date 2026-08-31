/**
 * 迷你 Markdown 渲染(零依赖):只做内核消息实际用到的子集——
 * 表格、**加粗**、`行内代码`、无序列表、标题、段落。
 * React 元素拼装,不走 innerHTML,天然免 XSS;认不出的行原样当
 * 段落展示,渲染器绝不吞内容。
 */

import type { ReactNode } from "react";
import { MermaidFlow } from "./MermaidFlow";
import { PlantUml } from "./PlantUml";

/** 行内:**加粗**、`代码`、[文字](链接),以及帮助中心用的少量重点色:
 * {{blue|操作重点}} / {{green|成功结果}} / {{red|风险警告}}。颜色语法
 * 仍由 React 拼元素,不开放任意 HTML 或 CSS。链接只认站内路径与
 * http(s)——其余原样当文本,渲染器不背安全锅。 */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\{\{(?:blue|green|red)\|[^}]+\}\})/g)
    .filter(Boolean)
    .map((piece, index) => {
      if (piece.startsWith("**") && piece.endsWith("**")) {
        return <b key={index}>{piece.slice(2, -2)}</b>;
      }
      if (piece.startsWith("`") && piece.endsWith("`")) {
        return <code key={index} className="md-code">{piece.slice(1, -1)}</code>;
      }
      const emphasis = piece.match(/^\{\{(blue|green|red)\|([^}]+)\}\}$/);
      if (emphasis) {
        return <strong key={index}
          className={`md-emphasis tone-${emphasis[1]}`}>{emphasis[2]}</strong>;
      }
      const link = piece.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link && (/^\//.test(link[2]) || /^https?:\/\//.test(link[2]))) {
        return (
          <a key={index} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
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
  // 需求正文不一定只带 Unix 换行。从工单、富文本或旧系统粘贴时，
  // 可能混入裸 CR、Unicode line/paragraph separator。若只按 \n 切，
  // 一条有序列表会跨过这些分隔符：宽松初筛认成列表，后续逐行解析
  // 却拿不到 match，最终把整张任务页炸掉。这里先把所有文本换行统一
  // 切开；正文再脏也只能降级展示，不能影响进入任务。
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    // 每个块带上源文件行号(data-l,1 起)。批注要落成 `story.md:42`
    // 而不是"第三段那里"——没有这个锚,文档批注就只能让模型猜。
    // 内核面板用的是同一个属性名,两边的批注语义因此对得上。
    const at = index + 1;
    // fenced code:PlantUML 直接画图,其余语言至少按代码块如实呈现。
    const fence = line.match(/^\s*```([^`]*)\s*$/);
    if (fence) {
      const language = fence[1].trim().toLowerCase();
      const source: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        source.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(language === "plantuml"
        ? <div key={key++} className="md-uml" data-l={at}>
            <PlantUml source={source.join("\n")} />
          </div>
        : language === "mermaid"
          ? <div key={key++} className="md-uml" data-l={at}>
              <MermaidFlow source={source.join("\n")} />
            </div>
        : <pre key={key++} className="md-block-code" data-l={at}>
            <code>{source.join("\n")}</code>
          </pre>);
      continue;
    }
    // 表格:连续 | 行,第二行是分隔线则去掉它
    if (isTableRow(line)) {
      const rows: string[] = [];
      while (index < lines.length && isTableRow(lines[index])) {
        if (!isDivider(lines[index])) rows.push(lines[index]);
        index += 1;
      }
      const [head, ...body] = rows.map(tableCells);
      blocks.push(
        <table key={key++} className="md-table" data-l={at}>
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
      // 列表的锚点落在每个 li 上,不是整个 ul:清单里人要指的是某一条,
      // "这个列表有问题"对模型等于没说。
      const items: Array<{ text: string; at: number }> = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push({
          text: lines[index].replace(/^\s*[-*]\s+/, ""),
          at: index + 1,
        });
        index += 1;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, i) => (
            <li key={i} data-l={item.at}>{inline(item.text)}</li>
          ))}
        </ul>);
      continue;
    }
    // 有序列表:连续 "1." / "1)" 行。内核与 CHAIN 文档满篇编号步骤,
    // 不认它们的后果就是整屏"没渲染的文本"(内网实锤)。编号用原文的,
    // 不让浏览器重排——文档里"步骤 3"必须和屏上的 3 对得上。
    const firstOrderedItem = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (firstOrderedItem) {
      const items: Array<{ mark: string; text: string; at: number }> = [];
      let match: RegExpMatchArray | null = firstOrderedItem;
      while (index < lines.length && match) {
        items.push({ mark: match[1], text: match[2], at: index + 1 });
        index += 1;
        match = index < lines.length
          ? lines[index].match(/^\s*(\d+)[.)]\s+(.*)$/)
          : null;
      }
      blocks.push(
        <ol key={key++} className="md-list md-ordered">
          {items.map((item, i) => (
            <li key={i} value={Number(item.mark)} data-l={item.at}>
              {inline(item.text)}
            </li>
          ))}
        </ol>);
      continue;
    }
    // 分隔线:--- / *** / ___ 单独成行。
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" data-l={at} />);
      index += 1;
      continue;
    }
    // 引用块:连续 > 行
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote" data-l={at}>
          {quoted.map((row, i) => <p key={i} className="md-p">{inline(row)}</p>)}
        </blockquote>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      // 层级进 class:满篇标题长一个样,文档结构就看不出来了。
      blocks.push(
        <div key={key++}
          className={`md-heading md-h${Math.min(heading[1].length, 4)}`}
          data-l={at}>
          {inline(heading[2])}
        </div>);
      index += 1;
      continue;
    }
    // 缩进代码(≥4 空格,无围栏):模型手写的示例/日志常这么排,摊成
    // 段落会丢缩进变成一锅粥,按代码块如实呈现。
    if (/^ {4,}\S/.test(line)) {
      const source: string[] = [];
      while (index < lines.length
             && (/^ {4,}\S/.test(lines[index]) || !lines[index].trim())) {
        if (!lines[index].trim() && !(index + 1 < lines.length
            && /^ {4,}\S/.test(lines[index + 1]))) break;
        source.push(lines[index].replace(/^ {4}/, ""));
        index += 1;
      }
      blocks.push(
        <pre key={key++} className="md-block-code" data-l={at}>
          <code>{source.join("\n")}</code>
        </pre>);
      continue;
    }
    blocks.push(<p key={key++} className="md-p" data-l={at}>{inline(line)}</p>);
    index += 1;
  }
  return <div className="md">{blocks}</div>;
}
