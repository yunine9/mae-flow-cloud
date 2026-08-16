/**
 * 知识块(路线图 #4 的另一半,OpenHands microagents 理念):仓里放
 * 带触发词的小知识文件,命中才注入会话——避免"把全部规范塞进每次
 * 开场"的上下文浪费,也守住"知识在仓不在平台"的路线(换个仓就是
 * 换套知识,平台不做知识库、不做配置面)。
 *
 * 约定:交付仓的 `.mae-flow/knowledge/*.md`,每篇形如
 *
 *     ---
 *     triggers: 数据库, migration, flyway
 *     ---
 *     正文……
 *
 * triggers 为空/缺头 = 常驻知识(每次都注入),这样"团队规范"这类
 * 无条件生效的东西不用硬编一个假触发词。
 *
 * 立场与边界:
 * - 这是上下文材料,不是判定逻辑——知识块说什么都不改变门禁裁决,
 *   内核仍是唯一权威;
 * - 匹配用大小写不敏感的子串(中文没有词边界,子串才是对的粗匹配),
 *   宁可多注入一篇也不漏——注入错顶多废点上下文,漏了才耽误事;
 * - 一切带预算:篇数、单篇字节、注入总字符三道帽,超了如实标注;
 * - fail-open:目录不存在/读不动/格式怪,返回空,任务照跑。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeOptions {
  /** 最多扫多少篇(默认 50)。 */
  maxBlocks?: number;
  /** 单篇读取字节上限(默认 20KB;超长只取头部)。 */
  maxBlockBytes?: number;
  /** 注入总字符上限(默认 8000;知识不许吃光上下文)。 */
  maxOutputChars?: number;
}

export interface KnowledgeResult {
  markdown: string;
  /** 实际注入的篇名(相对 knowledge 目录),供台账/排查用。 */
  used: string[];
  truncated: boolean;
}

const KNOWLEDGE_DIR = join(".mae-flow", "knowledge");

/** 解析头部:只认 `triggers:` 一行,不引 YAML 依赖(零依赖原则)。 */
function parseBlock(text: string): { triggers: string[]; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { triggers: [], body: text.trim() };
  const close = lines.indexOf("---", 1);
  if (close < 0) return { triggers: [], body: text.trim() }; // 头没闭合:当常驻,不炸
  const header = lines.slice(1, close);
  const line = header.find((row) => /^\s*triggers\s*:/i.test(row));
  const triggers = line
    ? line.replace(/^\s*triggers\s*:/i, "")
        .split(/[,,]/).map((word) => word.trim()).filter(Boolean)
    : [];
  return { triggers, body: lines.slice(close + 1).join("\n").trim() };
}

/**
 * 按上下文文本(需求、修复失败日志等)挑出命中的知识块。
 * @param root 工作区根(交付仓的克隆)
 * @param context 用来匹配触发词的文本,通常是需求原文 + 本轮失败详情
 */
export function collectKnowledge(
  root: string,
  context: string,
  options: KnowledgeOptions = {},
): KnowledgeResult {
  const maxBlocks = options.maxBlocks ?? 50;
  const maxBlockBytes = options.maxBlockBytes ?? 20 * 1024;
  const maxOutputChars = options.maxOutputChars ?? 8000;
  const haystack = context.toLowerCase();
  let truncated = false;

  try {
    const dir = join(root, KNOWLEDGE_DIR);
    statSync(dir);
    const names = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort(); // 稳定顺序:同样的仓每次注入同样的开场,便于对拍
    if (names.length > maxBlocks) truncated = true;

    const chosen: { name: string; body: string }[] = [];
    for (const name of names.slice(0, maxBlocks)) {
      try {
        const text = readFileSync(join(dir, name), "utf-8")
          .slice(0, maxBlockBytes);
        const { triggers, body } = parseBlock(text);
        if (!body) continue;
        const hit = triggers.length === 0 // 无触发词=常驻知识
          || triggers.some((word) => haystack.includes(word.toLowerCase()));
        if (hit) chosen.push({ name, body });
      } catch {
        /* 单篇读不动不碍事 */
      }
    }
    if (!chosen.length) return { markdown: "", used: [], truncated };

    const lines = ["# 仓里的知识块(命中触发词才在场;来自仓的 "
      + `${KNOWLEDGE_DIR}/,不是平台配置)`];
    const used: string[] = [];
    let size = lines[0].length;
    for (const { name, body } of chosen) {
      const chunk = `\n\n## ${name}\n${body}`;
      if (size + chunk.length > maxOutputChars) { truncated = true; break; }
      lines.push(chunk);
      size += chunk.length;
      used.push(name);
    }
    if (truncated) {
      lines.push("\n\n(知识块按预算截断,未列出的自行到 "
        + `${KNOWLEDGE_DIR}/ 查阅)`);
    }
    return { markdown: lines.join(""), used, truncated };
  } catch {
    // fail-open:没有知识目录是常态(绝大多数仓都没有),不是错误。
    return { markdown: "", used: [], truncated: false };
  }
}
