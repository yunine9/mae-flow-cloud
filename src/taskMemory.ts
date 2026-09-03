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
 * 第三期加的三样,都不破上面三条:
 * - **起草收尾**:trigger/scope 先用模板落盘,模型起草回来后在同一条记录上
 *   补全(md 改标题、索引追加一行 revision+1)。这不是"改写别人",是平台
 *   自己那条记录几秒内的收尾——人写的原文/问题/结论一个字不动。
 * - **台账**(ledger.jsonl):推送、检索、返工、失锚、归档,每件事一行,
 *   只追加。排序权重与沉底判断都从这里算,md 正本不背这些账。
 * - **沉底归档**:失锚太久或年头久且从未命中的,md 挪进 _archive/,不进
 *   索引但文件仍在;台账记一行,list 读侧派生 archived。不删。
 *
 * 这里不做检索(sidecar 的事),不做任何面向人的编辑面。
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type MemorySource = "annotation" | "prepush_fix" | "user_note";
export type MemoryJudge = "human" | "pipeline";
/** one_off 只进全文检索;local/general 才进推送与目录摘要(§5)。 */
export type MemoryScope = "one_off" | "local" | "general";

export const MEMORY_DIR = "corpus";
export const MEMORY_ARCHIVE_DIR = "_archive";
export const MEMORY_BODY_LIMIT = 2000;
/** trigger 是记录标题,也是推送时的第一句;超过这个长度就不是"什么情况下"了。 */
export const MEMORY_TRIGGER_LIMIT = 80;

/** trigger/scope 是谁定的:模板(入库那一刻)、模型(起草收尾)、起草失败
 * (模板保留,scope 不动)。user_note 不过起草,固定 template。 */
export type MemoryDraftState = "template" | "model" | "failed";

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
  /** 同一条记录在索引里的第几版(起草收尾会追加一版);读侧取最后一版。 */
  revision?: number;
  draft?: MemoryDraftState;
  /** 读侧派生:被哪条覆盖了(不落盘)。 */
  superseded_by?: string;
  /** 读侧派生自台账:已沉底归档(md 在 _archive/ 下,不进索引)。 */
  archived?: boolean;
  archive_reason?: string;
}

/** 台账一行:谁在什么时候对哪条记忆做了什么。只追加。 */
export type MemoryLedgerKind =
  | "push"       // 宿主三时刻推给了 Agent
  | "search"     // Agent 检索命中
  | "expand"     // Agent 展开全文
  | "rework"     // 推送之后同路径又被人提了意见(效果账的负项,§6)
  | "unanchored" // 消费时发现路径在现场不存在(首次记一行)
  | "archive"    // 沉底归档
  | "restore";   // 从归档捞回(重建索引时可用;暂无入口)

export interface MemoryLedgerRow {
  at: string;
  kind: MemoryLedgerKind;
  id: string;
  task?: string;
  /** push 的时刻 / archive 的原因 / rework 的路径。 */
  note?: string;
}

export interface MemoryStats {
  pushes: number;
  hits: number;
  reworks: number;
  last_used?: string;
  unanchored_since?: string;
  archived_at?: string;
  archive_reason?: string;
}

export const EMPTY_STATS: MemoryStats = { pushes: 0, hits: 0, reworks: 0 };

const DAY_MS = 86_400_000;

/**
 * 排序权重(§5「不筛只排」+ §6 效果反馈)。人判 > 流水线;一年减半;
 * 被 Agent 真用过(检索/展开)加一点,推了之后同路径返工减得更狠;
 * general 比 local 略重。只影响推不推、排第几,不影响进不进库。
 */
export function memoryWeight(
  record: Pick<MemoryRecord, "judged_by" | "at" | "scope">,
  stats: MemoryStats = EMPTY_STATS,
  now = Date.now(),
): number {
  const base = record.judged_by === "human" ? 1 : 0.6;
  const ageDays = Math.max(0, (now - new Date(record.at).getTime()) / DAY_MS);
  const decay = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / 365) : 0.5;
  const used = Math.min(0.5, stats.hits * 0.1);
  const rework = Math.min(0.8, stats.reworks * 0.4);
  const scope = record.scope === "general" ? 0.1 : 0;
  return Math.max(0.05, base * decay + used + scope - rework);
}

export function readJsonlRows<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      continue;                                   // 半行只丢它自己
    }
  }
  return rows;
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
    ...(record.draft ? [["draft", record.draft] as [string, string]] : []),
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
  readonly ledger: MemoryLedger;

  constructor(private readonly dataDir: string) {
    this.ledger = new MemoryLedger(dataDir);
  }

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

  /** 读侧派生 superseded_by / archived;同 id 多版取最后一版(起草收尾
   * 追加的);半行 JSON(崩在写一半)只丢它自己。 */
  list(filter: { task?: string } = {}): MemoryRecord[] {
    if (!existsSync(this.indexPath)) return [];
    const latest = new Map<string, MemoryRecord>();
    for (const row of readJsonlRows<MemoryRecord>(this.indexPath)) {
      if (!row || typeof row.id !== "string") continue;
      latest.set(row.id, row);                     // Map 保插入序,后来的版本原位替换
    }
    const rows = [...latest.values()];
    const supersededBy = new Map<string, string>();
    for (const row of rows) {
      if (row.supersedes) supersededBy.set(row.supersedes, row.id);
    }
    const stats = this.ledger.stats();
    return rows
      .map((row) => {
        const derived: MemoryRecord = { ...row };
        if (supersededBy.has(row.id)) derived.superseded_by = supersededBy.get(row.id);
        const own = stats.get(row.id);
        if (own?.archived_at) {
          derived.archived = true;
          derived.archive_reason = own.archive_reason;
        }
        return derived;
      })
      .filter((row) => !filter.task || row.task === filter.task);
  }

  /** 起草收尾:模型给出的 trigger/scope 补进同一条记录。md 改标题与
   * frontmatter,索引追加一版。只对还是模板态、未撤回未覆盖的记录做,
   * 且只做一次——起草不是编辑面,不给任何人第二次机会改别人的记录。 */
  finalizeDraft(
    id: string,
    draft: { trigger?: string; scope?: MemoryScope; state: MemoryDraftState },
  ): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.withdrawn || found.superseded_by || found.archived) {
      throw new MemoryError("这条记忆已撤回、覆盖或归档,不再起草");
    }
    if ((found.draft ?? "template") !== "template") {
      throw new MemoryError("这条记忆已经起草收尾过");
    }
    const trigger = String(draft.trigger ?? "").replace(/\s+/g, " ").trim();
    const next: MemoryRecord = {
      ...found,
      ...(draft.state === "model" && trigger
        ? { trigger: trigger.slice(0, MEMORY_TRIGGER_LIMIT) } : {}),
      ...(draft.state === "model" && draft.scope ? { scope: draft.scope } : {}),
      draft: draft.state,
      revision: (found.revision ?? 1) + 1,
    };
    delete next.superseded_by;
    delete next.archived;
    delete next.archive_reason;
    const absolute = resolve(this.root, next.file);
    if (!contained(this.root, absolute)) throw new MemoryError("记忆路径越出语料目录");
    writeFileSync(absolute, renderMemoryMarkdown(next), "utf-8");
    appendFileSync(this.indexPath, JSON.stringify(next) + "\n", "utf-8");
    return next;
  }

  /** 沉底:md 挪进 _archive/ 同路径,台账记一行。不删、不改索引行;
   * 索引重建(sidecar reindex)时 _archive/** 被排除,自然不再命中。 */
  archive(id: string, reason: string): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.archived) return found;
    const from = resolve(this.root, found.file);
    const to = resolve(this.root, MEMORY_ARCHIVE_DIR, found.file);
    if (!contained(this.root, from) || !contained(join(this.root, MEMORY_ARCHIVE_DIR), to)) {
      throw new MemoryError("记忆路径越出语料目录");
    }
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    this.ledger.append({ kind: "archive", id, note: reason });
    return { ...found, archived: true, archive_reason: reason };
  }

  /**
   * 沉底扫描(§6):两类候选——失锚超 unanchoredDays 的;年头超 idleDays
   * 且从未被推送/命中的。撤回和被覆盖的不用扫(它们本来就不推)。
   * 返回归档了哪些,调用方决定要不要重建索引。
   */
  sweepArchive(options: {
    now?: number; idleDays?: number; unanchoredDays?: number;
  } = {}): Array<{ id: string; reason: string }> {
    const now = options.now ?? Date.now();
    const idleDays = options.idleDays ?? 365;
    const unanchoredDays = options.unanchoredDays ?? 180;
    const stats = this.ledger.stats();
    const archived: Array<{ id: string; reason: string }> = [];
    for (const row of this.list()) {
      if (row.archived || row.withdrawn || row.superseded_by) continue;
      const own = stats.get(row.id) ?? EMPTY_STATS;
      const ageDays = (now - new Date(row.at).getTime()) / DAY_MS;
      let reason = "";
      if (own.unanchored_since
          && (now - new Date(own.unanchored_since).getTime()) / DAY_MS >= unanchoredDays) {
        reason = `失锚超过 ${unanchoredDays} 天(自 ${own.unanchored_since.slice(0, 10)})`;
      } else if (ageDays >= idleDays && own.pushes === 0 && own.hits === 0) {
        reason = `入库超过 ${idleDays} 天且从未被推送或命中`;
      }
      if (!reason) continue;
      this.archive(row.id, reason);
      archived.push({ id: row.id, reason });
    }
    return archived;
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
    if (!contained(this.root, absolute)) return undefined;
    if (existsSync(absolute)) return readFileSync(absolute, "utf-8");
    // 归档的还能读:可见不可管,沉底不等于消失。
    const archived = resolve(this.root, MEMORY_ARCHIVE_DIR, found.file);
    if (contained(this.root, archived) && existsSync(archived)) {
      return readFileSync(archived, "utf-8");
    }
    return undefined;
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

/** 台账:corpus/ledger.jsonl,只追加;stats() 一次读全,按 id 归并。 */
export class MemoryLedger {
  constructor(private readonly dataDir: string) {}

  get path(): string {
    return join(this.dataDir, MEMORY_DIR, "ledger.jsonl");
  }

  append(row: Omit<MemoryLedgerRow, "at"> & { at?: string }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path,
      JSON.stringify({ at: row.at ?? new Date().toISOString(), ...row }) + "\n", "utf-8");
  }

  rows(): MemoryLedgerRow[] {
    return readJsonlRows<MemoryLedgerRow>(this.path)
      .filter((row) => row && typeof row.id === "string" && typeof row.kind === "string");
  }

  stats(): Map<string, MemoryStats> {
    const out = new Map<string, MemoryStats>();
    for (const row of this.rows()) {
      const own = out.get(row.id) ?? { ...EMPTY_STATS };
      switch (row.kind) {
        case "push": own.pushes += 1; own.last_used = row.at; break;
        case "search":
        case "expand": own.hits += 1; own.last_used = row.at; break;
        case "rework": own.reworks += 1; break;
        case "unanchored": own.unanchored_since ??= row.at; break;
        case "archive": own.archived_at = row.at; own.archive_reason = row.note; break;
        case "restore":
          own.archived_at = undefined; own.archive_reason = undefined; break;
        default: break;
      }
      out.set(row.id, own);
    }
    return out;
  }
}

/** 效能页只读页签的数据形状(§9)。 */
export interface MemoryRepoInsight {
  repo: string;
  total: number;
  active: number;
  archived: number;
  withdrawn: number;
  one_off: number;
  pushes: number;
  hits: number;
  reworks: number;
}

export interface MemoryInsightRow {
  id: string;
  repo: string;
  trigger: string;
  conclusion: string;
  source: MemorySource;
  judged_by: MemoryJudge;
  scope: MemoryScope;
  draft: MemoryDraftState;
  at: string;
  task: string;
  paths: string[];
  line?: number;
  weight: number;
  pushes: number;
  hits: number;
  reworks: number;
  last_used?: string;
  archived?: boolean;
  archive_reason?: string;
  withdrawn?: boolean;
  superseded_by?: string;
}

export interface MemoryInsights {
  generated_at: string;
  /** 在途的起草作业数。 */
  drafting: number;
  sidecar: "ready" | "unavailable" | "absent";
  repos: MemoryRepoInsight[];
  memories: MemoryInsightRow[];
}
