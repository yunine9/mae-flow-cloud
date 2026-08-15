/**
 * 检视批注:在材料上圈出问题,攒成模型一次就能落地的清单。
 *
 * 为什么值得做(内核 panel/annotate.py 的原话,这里同理):检视的瓶颈
 * 从来不是发现问题,是把"哪一行、要改成什么"准确传达出去。口述"那个
 * 短信处理器里重试那块"要模型猜三轮;`sms_handler.py:23` 加一句意见
 * 它一次就到位。批注的本质是把人脑里那个**指向**,压成
 * **坐标 + 原文快照 + 要求** 三元组。
 *
 * 与内核面板那套的区别,全在约束上:面板是 file:// 单文件 HTML,不能
 * 写文件,所以只能剪贴板 + localStorage;我们有服务端、有会话、有插话
 * 通道,该继承的是它的语义(尤其"以原文为准定位"和那四条护栏),不是
 * 它的实现。照抄"复制给 Agent"等于把别人的枷锁搬到没有枷锁的地方。
 *
 * 落盘用 append-only 的 jsonl:多人同圈一份文档时,就地覆盖的
 * last-write-wins 会静默吃掉别人写的字。改自己的用新增+软删。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type AnnotationKind = "doc" | "code";
export type AnnotationStatus = "draft" | "sent" | "dropped";
export type SentVia = "interrupt" | "decision";

export interface Annotation {
  id: string;
  author: string;
  created_at: string;
  /** 圈在哪份产物上——重锚定回头读的就是它。 */
  artifact: string;
  /** 给模型看的真实路径(代码批注是源文件路径,文档批注同产物名)。 */
  file: string;
  /** 收到材料时的行号。模型一改就会偏移,所以它只是辅助,不是依据。 */
  line: number;
  /** 原文快照——定位以它为准。内核那条经验在活靶子上更要紧。 */
  anchor: string;
  note: string;
  kind: AnnotationKind;
  status: AnnotationStatus;
  sent_at?: string;
  sent_via?: SentVia;
}

export interface AnnotationInput {
  author: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  note: string;
  kind: AnnotationKind;
}

type Operation =
  | { op: "add"; record: Annotation }
  | { op: "drop"; id: string }
  | { op: "sent"; ids: string[]; via: SentVia; at: string };

export class AnnotationError extends Error {}

/** 锚点还在不在:送出前问一次,答案摊给人看,不替人决定。 */
export type AnchorState = "hit" | "moved" | "gone" | "ambiguous";

export interface AnchorCheck {
  id: string;
  state: AnchorState;
  /** hit/moved/ambiguous 时的当前行号(1 起)。 */
  line?: number;
  /** 靶子已变时的现状原文,让人自己判断这条还要不要送。 */
  now?: string;
}

export class AnnotationStore {
  constructor(readonly path: string) {}

  /** 回放得到当前状态。坏行跳过不炸整页——旁路一律 fail-open。 */
  list(): Annotation[] {
    if (!existsSync(this.path)) return [];
    const byId = new Map<string, Annotation>();
    let text = "";
    try {
      text = readFileSync(this.path, "utf-8");
    } catch {
      return [];
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let operation: Operation;
      try {
        operation = JSON.parse(line) as Operation;
      } catch {
        continue;                 // 半行 JSON(崩在写一半)只丢它自己
      }
      if (operation.op === "add" && operation.record?.id) {
        byId.set(operation.record.id, operation.record);
        continue;
      }
      if (operation.op === "drop") {
        const found = byId.get(operation.id);
        if (found) found.status = "dropped";
        continue;
      }
      if (operation.op === "sent") {
        for (const id of operation.ids ?? []) {
          const found = byId.get(id);
          if (!found) continue;
          found.status = "sent";
          found.sent_at = operation.at;
          found.sent_via = operation.via;
        }
      }
    }
    return [...byId.values()];
  }

  /** 还没送出去的:决定卡与插话都取这一批。 */
  drafts(): Annotation[] {
    return this.list().filter((item) => item.status === "draft");
  }

  /** 页面要看的:草稿 + 已送出。软删的不再露面(留在文件里可查)。
   * 送出后不消失是刻意的——人得看得见"这条提过没有、现在什么进展"。 */
  visible(): Annotation[] {
    return this.list().filter((item) => item.status !== "dropped");
  }

  add(input: AnnotationInput): Annotation {
    const note = String(input.note ?? "").trim();
    if (!note) throw new AnnotationError("批注内容不能为空");
    const anchor = String(input.anchor ?? "").trim();
    if (!anchor) throw new AnnotationError("缺少原文快照,批注无从定位");
    const artifact = String(input.artifact ?? "").trim();
    if (!artifact) throw new AnnotationError("缺少产物名");
    const record: Annotation = {
      id: `an-${Date.now().toString(36)}-${this.list().length + 1}`,
      author: String(input.author ?? "").trim() || "未署名",
      created_at: new Date().toISOString(),
      artifact,
      file: String(input.file ?? "").trim() || artifact,
      line: Number.isFinite(input.line) ? Math.max(0, Math.trunc(input.line)) : 0,
      anchor,
      note,
      kind: input.kind === "code" ? "code" : "doc",
      status: "draft",
    };
    this.append({ op: "add", record });
    return record;
  }

  /** 软删:多人环境里硬删等于替别人做主,留痕才查得清。 */
  drop(id: string, by: string): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.status === "sent") {
      throw new AnnotationError("这条已经送出去了,撤不回来");
    }
    if (found.author !== by) {
      throw new AnnotationError(`这条是 ${found.author} 写的,不能替他删`);
    }
    this.append({ op: "drop", id });
    return { ...found, status: "dropped" };
  }

  markSent(ids: string[], via: SentVia): void {
    if (!ids.length) return;
    this.append({ op: "sent", ids, via, at: new Date().toISOString() });
  }

  private append(operation: Operation): void {
    appendFileSync(this.path, JSON.stringify(operation) + "\n", "utf-8");
  }
}

/** 同一行的多条并排,按文件分组、组内按行号升序。
 * 人是跳着圈的,模型却要一个文件一个文件地改——按点击顺序给它,
 * 它得来回翻(内核那条经验)。 */
export function orderAnnotations(items: Annotation[]): Annotation[] {
  return [...items].sort((left, right) => {
    if (left.file !== right.file) return left.file < right.file ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    return left.created_at.localeCompare(right.created_at);
  });
}

/**
 * 渲染成给模型的清单。
 *
 * 抬头那四条护栏一字不改地沿用内核 panel/annotate.py 的措辞——它们是
 * 对着弱模型踩出来的,看着像客套话,其实是契约:不许"已知悉"式敷衍、
 * 不许顺手改别处、以原文定位、不同意要说理由。本仓复制了一份,所以
 * annotations.test.ts 里钉死了这四条;要改先去内核改,别在这儿各写各的。
 */
export function renderAnnotations(
  items: Annotation[],
  ticket: string,
): string {
  const ordered = orderAnnotations(items);
  const files = [...new Set(ordered.map((item) => item.file))];
  const lines: string[] = [
    `这是我人工检视 ${ticket} 的结果,共 ${ordered.length} 条,` +
    `涉及 ${files.length} 个文件。请按下面的意见逐条修改。`,
    "",
    "几点要求:",
    "- 这是检视结论,不是征求意见。逐条落实,不要只回复\"已知悉\"。",
    "- 只改这些地方。确实要连带改别处,先说清为什么,再动。",
    "- 行号按你收到时的文件;你一改行号就会偏移,所以每条都附了原文,"
    + "以原文为准定位。",
    "- 逐条回我改了什么。有哪条你认为不该改,说明理由,别默默跳过。",
    "",
  ];
  let seen = "";
  let index = 0;
  for (const item of ordered) {
    if (item.file !== seen) {
      seen = item.file;
      lines.push(`【${item.file}】`);
    }
    index += 1;
    lines.push(`${index}. 第 ${item.line} 行`);
    lines.push(`   ${item.kind === "code" ? "当前代码" : "原文"}:${item.anchor}`);
    lines.push(`   要求:${item.note}`);
  }
  return lines.join("\n");
}

/**
 * 送出前重新锚定:原文还在原处吗?
 *
 * 为什么必须在**送出那一刻**做而不是圈注时:靶子是活的。你圈的第 23
 * 行,模型十分钟后重构了那个文件,行号偏移甚至整块消失。更糟的是意见
 * 可能已经过期——它自己已经改好了,你再送一条"要求改 X",轻则白烧一轮,
 * 重则让它改回去。
 *
 * 这里只报告事实,不替人决定撤不撤:判定权是人的。
 */
export function reanchor(
  items: Annotation[],
  read: (artifact: string) => string | undefined,
): AnchorCheck[] {
  const cache = new Map<string, string[] | undefined>();
  const linesOf = (artifact: string): string[] | undefined => {
    if (!cache.has(artifact)) {
      const text = read(artifact);
      cache.set(artifact, text === undefined ? undefined : text.split("\n"));
    }
    return cache.get(artifact);
  };
  return items.map((item): AnchorCheck => {
    const lines = linesOf(item.artifact);
    // 读不到产物不等于靶子没了(可能是权限/路径问题),按 hit 放行——
    // 旁路一律 fail-open,重锚定绝不能挡住人送出意见。
    if (!lines) return { id: item.id, state: "hit", line: item.line };
    const needle = item.anchor.trim();
    const hits: number[] = [];
    lines.forEach((line, at) => {
      if (line.includes(needle)) hits.push(at + 1);
    });
    if (!hits.length) {
      const now = lines[item.line - 1];
      return {
        id: item.id,
        state: "gone",
        now: now === undefined ? undefined : now.trim(),
      };
    }
    if (hits.includes(item.line)) return { id: item.id, state: "hit", line: item.line };
    if (hits.length > 1) return { id: item.id, state: "ambiguous", line: hits[0] };
    return { id: item.id, state: "moved", line: hits[0] };
  });
}
