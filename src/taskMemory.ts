/**
 * 任务记忆(语料库,docs/knowledge-memory-design.md)。
 *
 * 平台不建知识库,只记住自己干过的活:一个被人或权威来源关掉的环
 * (闭环的检视意见、失败后修好的 Build-Fix、人圈选「记为记忆」),
 * 自动落成一条记录,下一单改到同一处时再喂给 Agent。
 *
 * 三条纪律,设计期钉死:
 * - **md 是正本,索引只是索引**。每条记录一个 Markdown 文件,frontmatter
 *   放定位键,正文固定「什么情况下 / 原文 / 问题 / 结论」四段——memsearch
 *   按标题切块,搜到哪块都带着标题能读懂,expand 一次就是整条。索引
 *   (milvus.db)删了从这些文件重建。
 * - **只追加不改写**。要改就追加一条带 supersedes 的新记录,撤回也是
 *   追加(结论为空)。多人环境里就地覆盖等于替别人做主。
 * - **记忆是短句,不是文档**。单条正文 2000 字封顶,超了拒收并指路
 *   Skill 货架——长的东西有它自己的家,往记忆里塞整段规范就是在建第二
 *   个知识库。
 *
 * 这里不做检索(第二期 sidecar 的事),不做任何面向人的编辑面。
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type MemorySource = "annotation" | "prepush_fix" | "user_note";
export type MemoryJudge = "human" | "pipeline";
/** one_off 只进全文检索;local/general 才进推送与目录摘要(§5)。 */
export type MemoryScope = "one_off" | "local" | "general";

export const MEMORY_DIR = "corpus";
export const MEMORY_BODY_LIMIT = 2000;

export interface MemoryInput {
  source: MemorySource;
  judged_by: MemoryJudge;
  scope: MemoryScope;
  /** 仓库短名(repoSlug),宿主按任务固定,是检索的过滤键。 */
  repo: string;
  paths: string[];
  line?: number;
  module?: string;
  /** 内核七段词表之一;来源决定,不猜。 */
  phase?: string;
  task: string;
  /** 可回溯到现场的指针:annotation:<id> / prepush:<sha> / withdraw:<id>。 */
  evidence: string;
  author?: string;
  /** 什么情况下——记录标题,也是 memsearch 切出来的第一块。 */
  trigger: string;
  /** 圈选或锚定的原文快照。 */
  quote?: string;
  problem?: string;
  conclusion: string;
  supersedes?: string;
}

export interface MemoryRecord extends MemoryInput {
  id: string;
  at: string;
  /** 相对 corpus/ 的 md 路径。 */
  file: string;
  /** 撤回记录:结论为空、supersedes 指向被撤回的那条。 */
  withdrawn?: boolean;
  /** 读侧派生:被哪条覆盖了(不落盘)。 */
  superseded_by?: string;
}

export class MemoryError extends Error {}

/** 仓库 URL → 目录名。只留 [A-Za-z0-9._-],别让 URL 里的东西变成路径。 */
export function repoSlug(url: string | undefined): string {
  const tail = String(url ?? "").trim().replace(/\/+$/, "")
    .split(/[/:]/).filter(Boolean).at(-1) ?? "";
  const slug = tail.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug || "_unknown";
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value));
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

/** 正文四段固定。空段不写,免得 memsearch 切出一堆空块。 */
export function renderMemoryMarkdown(record: MemoryRecord): string {
  const front: Array<[string, string]> = [
    ["id", yamlScalar(record.id)],
    ["source", record.source],
    ["judged_by", record.judged_by],
    ["scope", record.scope],
    ["repo", yamlScalar(record.repo)],
    ["paths", `[${record.paths.map(yamlScalar).join(", ")}]`],
    ...(record.line ? [["line", String(record.line)] as [string, string]] : []),
    ...(record.module ? [["module", yamlScalar(record.module)] as [string, string]] : []),
    ...(record.phase ? [["phase", yamlScalar(record.phase)] as [string, string]] : []),
    ["task", yamlScalar(record.task)],
    ["evidence", yamlScalar(record.evidence)],
    ...(record.author ? [["author", yamlScalar(record.author)] as [string, string]] : []),
    ...(record.supersedes
      ? [["supersedes", yamlScalar(record.supersedes)] as [string, string]] : []),
    ["at", yamlScalar(record.at)],
  ];
  const sections: string[] = [`# ${record.trigger.replace(/\s+/g, " ").trim()}`];
  if (record.quote?.trim()) {
    sections.push("## 原文\n" + record.quote.trim().split("\n")
      .map((line) => `> ${line}`).join("\n"));
  }
  if (record.problem?.trim()) sections.push(`## 问题\n${record.problem.trim()}`);
  sections.push(`## 结论\n${record.conclusion.trim() || "(已撤回)"}`);
  return `---\n${front.map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n`
    + sections.join("\n\n") + "\n";
}

export class MemoryStore {
  constructor(private readonly dataDir: string) {}

  get root(): string {
    return join(this.dataDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return join(this.root, "index.jsonl");
  }

  /** 落一条。校验只有三样:结论不能空(撤回除外)、正文不超上限、
   * 定位键不能空。不判断质量——质量靠排序,不靠门口的人(§5)。 */
  record(input: MemoryInput, options: { withdrawn?: boolean } = {}): MemoryRecord {
    const trigger = String(input.trigger ?? "").trim();
    if (!trigger) throw new MemoryError("记忆缺少「什么情况下」");
    const conclusion = String(input.conclusion ?? "").trim();
    if (!conclusion && !options.withdrawn) throw new MemoryError("记忆缺少结论");
    if (!String(input.repo ?? "").trim()) throw new MemoryError("记忆缺少仓库");
    if (!String(input.task ?? "").trim()) throw new MemoryError("记忆缺少任务号");
    const body = [trigger, input.quote ?? "", input.problem ?? "", conclusion]
      .join("\n").length;
    if (body > MEMORY_BODY_LIMIT) {
      throw new MemoryError(
        `记忆是短句,单条不超过 ${MEMORY_BODY_LIMIT} 字(现在 ${body} 字);`
        + "这更像一条 Skill,请去团队知识货架提交");
    }
    const at = new Date().toISOString();
    const id = `c-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const repo = repoSlug(input.repo) === input.repo ? input.repo : repoSlug(input.repo);
    const file = join(repo, at.slice(0, 7), `${id}.md`);
    const record: MemoryRecord = {
      ...input,
      repo,
      paths: [...new Set((input.paths ?? []).map((path) => String(path).trim())
        .filter(Boolean))],
      trigger,
      conclusion,
      id,
      at,
      file,
      ...(options.withdrawn ? { withdrawn: true } : {}),
    };
    const absolute = resolve(this.root, file);
    if (!contained(this.root, absolute)) {
      throw new MemoryError("记忆路径越出语料目录");
    }
    mkdirSync(join(this.root, repo, at.slice(0, 7)), { recursive: true });
    writeFileSync(absolute, renderMemoryMarkdown(record), "utf-8");
    // 索引行先于 md 不行(读到索引找不到文件),md 先于索引可以(多一个
    // 没人引用的文件,重建索引时照样收进去)。
    appendFileSync(this.indexPath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  /** 读侧派生 superseded_by;半行 JSON(崩在写一半)只丢它自己。 */
  list(filter: { task?: string } = {}): MemoryRecord[] {
    if (!existsSync(this.indexPath)) return [];
    const rows: MemoryRecord[] = [];
    for (const line of readFileSync(this.indexPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as MemoryRecord);
      } catch {
        continue;
      }
    }
    const supersededBy = new Map<string, string>();
    for (const row of rows) {
      if (row.supersedes) supersededBy.set(row.supersedes, row.id);
    }
    return rows
      .map((row) => supersededBy.has(row.id)
        ? { ...row, superseded_by: supersededBy.get(row.id) } : row)
      .filter((row) => !filter.task || row.task === filter.task);
  }

  find(id: string): MemoryRecord | undefined {
    return this.list().find((row) => row.id === id);
  }

  /** md 原文。路径来自索引,仍做一次目录包含校验——索引文件是宿主写的,
   * 但"宿主写的就可信"这种话在这个仓里从来不成立。 */
  read(id: string): string | undefined {
    const found = this.find(id);
    if (!found) return undefined;
    const absolute = resolve(this.root, found.file);
    if (!contained(this.root, absolute) || !existsSync(absolute)) return undefined;
    return readFileSync(absolute, "utf-8");
  }

  /** 撤回 = 追加一条结论为空的覆盖记录。只有人圈的能撤,且只能作者撤:
   * 闭环批注和 Build-Fix 是事实,不是意见,事实不能撤。 */
  withdraw(id: string, by: string): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.withdrawn || found.superseded_by) {
      throw new MemoryError("这条记忆已经被撤回或覆盖");
    }
    if (found.source !== "user_note") {
      throw new MemoryError("只有人圈选记下的记忆可以撤回;闭环事实不撤");
    }
    if (found.author && found.author !== by) {
      throw new MemoryError(`这条记忆是 ${found.author} 记的,只能由本人撤回`);
    }
    return this.record({
      ...found,
      trigger: found.trigger,
      conclusion: "",
      evidence: `withdraw:${found.id}`,
      supersedes: found.id,
      author: by,
    }, { withdrawn: true });
  }
}
