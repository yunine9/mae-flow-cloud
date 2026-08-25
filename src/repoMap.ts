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
import { basename, extname, join, relative } from "node:path";
import { runSafeWorktreeGit } from "./safeGit.ts";

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
  // Java 方法那半边的字符类必须排掉 {}、换行:早先写成 [^;]*,
  // 参数括号里允许跨行跨大括号,于是一个类只抽出第一个方法(后面
  // 全被吞进同一个匹配)——真 Java 仓的地图会严重缺符号。
  ".java": /^[ \t]*(?:public|protected)?[ \t]*(?:final[ \t]+|abstract[ \t]+|static[ \t]+)*(?:class|interface|enum|record)[ \t]+(\w+)|^[ \t]{2,8}(?:public|protected)[ \t][^=;{}\n]*?(\w+)[ \t]*\([^;{}\n]*\)[ \t]*(?:throws[^{\n]*)?\{/gm,
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
    const result = runSafeWorktreeGit(root, ["ls-files"], {
      maxBuffer: 32 * 1024 * 1024,
      // 同步调用必须有上限(2026-08-25 卡死事故的纪律):ls-files 只读
      // 索引通常亚秒,但无界的同步子进程一次意外就是整站冻结。
      timeoutMs: 30_000,
    });
    if (result.status !== 0) throw new Error("not a git repository");
    return String(result.stdout ?? "").split("\n").filter(Boolean);
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
    //
    // 真仓实测(kernel/ 500 文件)逼出来的两条修正:
    // 1. **通用词要剔**:check/write/state/read 这种名字全仓都出现,
    //    按它算扇入等于给每个文件送满分,地图前排全是噪音。用文档
    //    频率(DF)当判据:出现在超过 15% 文件里的名字不算引用信号
    //    ——这是 IDF 的穷人版,不建索引也算得起;
    // 2. **测试文件要降权**:它们符号多、互相引用多,天然刷榜,但
    //    模型要找的是被测的那个实现。降权而非剔除(知道测试在哪
    //    仍有用),让实现文件浮上来。
    const documentFrequency = new Map<string, number>();
    const frequencyOf = (key: string): number => {
      let known = documentFrequency.get(key);
      if (known === undefined) {
        known = 0;
        for (const text of contents.values()) if (text.includes(key)) known += 1;
        documentFrequency.set(key, known);
      }
      return known;
    };
    // 绝对下限 5:小仓里核心类本来就"到处出现"(6 个文件的仓,核心类
    // 出现在 4 个文件是信号不是噪音),只按比例算会把它当通用词剔掉
    // ——合成小仓上实测翻过一次车。
    const genericCutoff = Math.max(5, Math.ceil(contents.size * 0.15));
    const isTestish = (file: string): boolean =>
      /(^|\/)tests?\//i.test(file) || /(^|\/)(test_|spec_)/i.test(file)
      || /(\.|_)(test|spec)\.\w+$/i.test(file) || /Tests?\.\w+$/.test(file);

    const scores = new Map<string, number>();
    for (const [file, names] of symbols) {
      if (!withinBudget()) { truncated = true; break; }
      const keys = [basename(file).replace(/\.\w+$/, ""), ...names.slice(0, 3)]
        .filter((key) => key.length >= 4)          // 短名(run/main)不算
        .filter((key) => frequencyOf(key) <= genericCutoff); // 通用词不算
      let fanIn = 0;
      if (keys.length) {
        for (const [other, text] of contents) {
          if (other === file) continue;
          if (keys.some((key) => text.includes(key))) fanIn += 1;
        }
      }
      const raw = fanIn * 10 + Math.min(names.length, 10);
      scores.set(file, isTestish(file) ? raw * 0.3 : raw);
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
      // 公开符号先出场:一行只放得下十来个,别让 _git/_abs 这类私有
      // 助手占满(真仓实测:私有助手常在文件头部,按出现顺序会刷屏)。
      const names = [...(symbols.get(file) ?? [])]
        .sort((a, b) => Number(a.startsWith("_")) - Number(b.startsWith("_")));
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
