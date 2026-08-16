/**
 * repo map(路线图 #4,Aider 理念的零依赖版):给会话开场一张
 * "这个仓长什么样"的排序地图——大仓(内网巨型 Java 仓)里,模型
 * 拿着地图找文件,比全仓乱 grep 省一半轮次。
 *
 * 立场与边界(诚实清单口径):
 * - 这是上下文材料,不是判定逻辑——地图错了顶多慢,不会假绿;
 * - 零依赖:不引 tree-sitter(原生构建在内网 WSL 是负担),用每语言
 *   一条正则抽顶层符号。**它是近似**:注释里的假符号、罕见写法会
 *   漏/误,够用即可,不追求语法级精确;
 * - 一切扫描带预算:文件数、单文件字节、总毫秒三道帽,超了如实
 *   truncated=true,绝不无限扫(不卡死红线);
 * - fail-open:任何一步炸了返回空地图,任务照常跑——地图是加餐。
 *
 * 排序:引用扇入(别的文件提到我的主符号/文件名几次)为主,
 * 符号数为辅——被全仓引用的核心类排最前,模型先看骨架再看血肉。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, extname, join, relative } from "node:path";

export interface RepoMapOptions {
  /** 进入地图的文件数上限(默认 1500;超出按扇入截断)。 */
  maxFiles?: number;
  /** 单文件读取字节上限(默认 200KB;超长文件只读头部)。 */
  maxFileBytes?: number;
  /** 总时间预算毫秒(默认 3000;到点带着已有结果收工)。 */
  budgetMs?: number;
  /** 输出 markdown 的字符上限(默认 12000;地图不许吃光上下文)。 */
  maxOutputChars?: number;
}

export interface RepoMapResult {
  markdown: string;
  fileCount: number;
  truncated: boolean;
}

/** 每语言一条顶层符号正则:m 多行锚定行首附近,粗而稳。 */
const SYMBOL_PATTERNS: Record<string, RegExp> = {
  ".java": /^[ \t]*(?:public|protected)?[ \t]*(?:final[ \t]+|abstract[ \t]+|static[ \t]+)*(?:class|interface|enum|record)[ \t]+(\w+)|^[ \t]{2,8}(?:public|protected)[ \t][^=;{]*?(\w+)[ \t]*\([^;]*\)[ \t]*(?:throws[^{]*)?\{/gm,
  ".ts": /^export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?(?:function|class|interface|const|enum|type)[ \t]+(\w+)/gm,
  ".tsx": /^export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?(?:function|class|const)[ \t]+(\w+)/gm,
  ".js": /^(?:export[ \t]+)?(?:async[ \t]+)?(?:function|class)[ \t]+(\w+)/gm,
  ".py": /^[ \t]*(?:class|(?:async[ \t]+)?def)[ \t]+(\w+)/gm,
  ".go": /^func[ \t]+(?:\(\w+[ \t]+\*?\w+\)[ \t]+)?(\w+)|^type[ \t]+(\w+)/gm,
};

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "target", "out",
  ".mae-flow-work", "__pycache__", "vendor", ".idea", ".vscode",
]);

/** 文件清单:git 仓用 ls-files(尊重仓的边界),失败退目录遍历。 */
function listFiles(root: string, budget: () => boolean): string[] {
  try {
    return execFileSync("git", ["ls-files"], {
      cwd: root, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], // 非 git 目录走回退,fatal 声不外漏
    }).split("\n").filter(Boolean);
  } catch {
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!budget()) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else {
          found.push(relative(root, join(dir, entry.name)));
        }
      }
    };
    try {
      walk(root);
    } catch {
      /* fail-open:读不动就用已收集的 */
    }
    return found;
  }
}

export function buildRepoMap(
  root: string,
  options: RepoMapOptions = {},
): RepoMapResult {
  const maxFiles = options.maxFiles ?? 1500;
  const maxFileBytes = options.maxFileBytes ?? 200 * 1024;
  const budgetMs = options.budgetMs ?? 3000;
  const maxOutputChars = options.maxOutputChars ?? 12_000;
  const deadline = Date.now() + budgetMs;
  const withinBudget = () => Date.now() < deadline;
  let truncated = false;

  try {
    statSync(root); // 目录不存在直接走 fail-open 出口,别端出一张光杆标题的"地图"
    const all = listFiles(root, withinBudget)
      .filter((file) => SYMBOL_PATTERNS[extname(file)]);
    if (all.length === 0) return { markdown: "", fileCount: 0, truncated };
    if (all.length > maxFiles) truncated = true;
    const files = all.slice(0, maxFiles);

    // 第一遍:抽符号 + 攒全文语料(供扇入统计)。
    const symbols = new Map<string, string[]>();
    const contents = new Map<string, string>();
    for (const file of files) {
      if (!withinBudget()) { truncated = true; break; }
      try {
        const full = join(root, file);
        if (statSync(full).size > maxFileBytes) truncated = true;
        const text = readFileSync(full, "utf-8").slice(0, maxFileBytes);
        contents.set(file, text);
        const pattern = new RegExp(SYMBOL_PATTERNS[extname(file)].source, "gm");
        const names: string[] = [];
        for (const match of text.matchAll(pattern)) {
          const name = match.slice(1).find(Boolean);
          if (name && !names.includes(name)) names.push(name);
          if (names.length >= 40) break; // 单文件符号帽:地图要骨架不要器官
        }
        symbols.set(file, names);
      } catch {
        /* 单文件读不动不碍事 */
      }
    }

    // 第二遍:扇入排序——统计"别的文件提到我"的次数。主符号取前 3 个
    // (通常是类名/入口),加上文件基名;全文 includes 粗算,不建索引。
    const scores = new Map<string, number>();
    for (const [file, names] of symbols) {
      if (!withinBudget()) { truncated = true; break; }
      const keys = [basename(file).replace(/\.\w+$/, ""), ...names.slice(0, 3)]
        .filter((key) => key.length >= 4); // 短名(如 run/main)全仓都是,不算
      let fanIn = 0;
      for (const [other, text] of contents) {
        if (other === file) continue;
        if (keys.some((key) => text.includes(key))) fanIn += 1;
      }
      scores.set(file, fanIn * 10 + Math.min(names.length, 10));
    }

    const ranked = [...symbols.keys()]
      .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));

    const lines: string[] = [
      "# 仓库地图(自动生成,按被引用程度排序;近似而非精确)",
      "",
    ];
    let used = lines.join("\n").length;
    let listed = 0;
    for (const file of ranked) {
      const names = symbols.get(file) ?? [];
      const line = names.length
        ? `- ${file}: ${names.slice(0, 12).join(", ")}`
        : `- ${file}`;
      if (used + line.length + 1 > maxOutputChars) { truncated = true; break; }
      lines.push(line);
      used += line.length + 1;
      listed += 1;
    }
    if (truncated) {
      lines.push("", "(地图按预算截断,未列出的文件用搜索定位)");
    }
    return { markdown: lines.join("\n"), fileCount: listed, truncated };
  } catch {
    // fail-open:地图是加餐,炸了就不端上桌,任务照常。
    return { markdown: "", fileCount: 0, truncated: true };
  }
}
