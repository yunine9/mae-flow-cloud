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

/**
 * 需求原文来自任务快照，不是 .mae-flow-work 下的真实产物。批注仍需一个
 * 稳定锚点标识，前后端用这个保留值识别它，不能把它混进产物清单。
 */
export const TASK_REQUIREMENT_ARTIFACT = "__task_requirement__";

/** 模块拆分图不是磁盘文档，却同样需要进入统一批注账。artifact 使用稳定
 * 虚拟标识，anchor 则记录方案整体、模块 id 或依赖边；服务端会从当前
 * requirement_graph 机械还原可重锚定文本。这样图上意见不必硬挂到
 * CHAIN 文档某一行，也不用另造一套“图评论”状态机。 */
export const REQUIREMENT_GRAPH_ARTIFACT = "__requirement_graph__";

export type AnnotationKind = "doc" | "code";
/** 一条检视意见首先是在找谁做下一步，不是天然都在命令 Agent。旧账
 * 没有 route，读侧一律按 agent 解释，避免升级后改变历史任务语义。 */
export type AnnotationRoute = "agent" | "owner_reply" | "owner_decision"
  /** 记为记忆:不发给任何人、不进决定卡,圈选即闭环,直接落一条任务记忆
   * (docs/knowledge-memory-design.md §4.1)。空口一句缺的就是引文和位置,
   * 圈选把这两样自动补齐。 */
  | "memory";
/** verified = 人看过改动、点了"确认通过"——这是人的判断,不是系统推断,
 * 所以它只能由按钮产生,永远不会被重锚定自动打上。 */
export type AnnotationStatus = "draft" | "sent" | "verified" | "dropped";
export type SentVia =
  | "interrupt"
  | "decision"
  | "pipeline_evidence"
  /** MR 已创建后的本地检视：进入当前 MR 的持续修复环。 */
  | "review_repair"
  /** “责任人答复 / 决策后处理”已送到责任人，尚未交给 Agent。 */
  | "owner_pending"
  /** 任务正等人决定时提交:先成为团队事实(阻塞放行),正文随下一次
   * 决定的 continuation 送达 Agent。检视人不必等任务恰好 running
   * (MFC-022:曾经这窗口里没有任何合法提交路径)。 */
  | "queued_decision"
  /** 问题域的检视提交(ADR-0007):意见清单随整体回退注入新一轮
   * 问题分析。存储/锚点/重锚定与需求流同一套,只有通道不同。 */
  | "issue_review";

/** Agent 对一条已提交意见的结构化回执。它只陈述 Agent 做了什么，
 * 不能代替意见作者的 verify：response 是机器事实，verified 是人的判断。 */
export interface AnnotationResponse {
  /** 同一条意见返工后 revision 递增，旧回执仍留在 JSONL 审计账里。 */
  revision: number;
  outcome: "fixed" | "not_fixed" | "needs_clarification";
  summary: string;
  evidence: string[];
  /** 回执对应的本地提交；没有代码仓的纯文档任务可以缺席。 */
  fixed_sha?: string;
  responded_at: string;
}

/** 责任人的原话单独记账。它不是 Agent 回执，也不能被页面混写成
 * “Agent 已处理”；decision 类型会把这段原话作为后续实现依据送给 Agent。 */
export interface AnnotationOwnerReply {
  author: string;
  text: string;
  replied_at: string;
}

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
  /** 划选一块时的整块原文(≤ ANNOTATION_QUOTE_MAX):给人和模型看语境,
   * 不参与定位;按行点的没有。 */
  quote?: string;
  /** 划选跨行时的末行;单行圈注没有。 */
  line_end?: number;
  note: string;
  /** 最近一次修改意见的时间。修改留在 append-only 台账里，不覆盖旧记录。 */
  edited_at?: string;
  kind: AnnotationKind;
  /** 缺省 = agent，用于兼容上线前的 annotations.jsonl。 */
  route?: AnnotationRoute;
  /** 非 agent 意见的责任人账号，由任务服务端按当前任务责任人固定。 */
  assignee?: string;
  status: AnnotationStatus;
  sent_at?: string;
  sent_via?: SentVia;
  /** 谁把草稿正式送入处理流程。与 author 分开：责任人可以原样转交
   * 他人的意见，但不能因此变成作者或取得最终裁决权。 */
  sent_by?: string;
  /** Agent 对当前 rework revision 的逐条回应。 */
  response?: AnnotationResponse;
  owner_reply?: AnnotationOwnerReply;
  verified_at?: string;
  /** 非作者(管理员)代确认时记谁点的;作者本人裁决不填。 */
  verified_by?: string;
  /** 第几次返工(0 = 首轮)。返工回到 draft,走原有的两条送出通道。 */
  rework?: number;
  /** 返工时锚点若已失效,这里存上一轮针对的原文——给模型看历史。 */
  anchor_was?: string;
  /** Agent 问过什么(needs_clarification 的回执),作者改字重提时留档:
   * 渲染给模型看,免得它把补充说明当新意见、再问一遍同一件事
   * (内网实锤:两条意见来回问了几轮重复的问题)。 */
  clarifications?: Array<{ question: string; asked_at: string; answered_at: string }>;
}

export interface AnnotationInput {
  author: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  note: string;
  kind: AnnotationKind;
  route?: AnnotationRoute;
  assignee?: string;
  quote?: string;
  line_end?: number;
}

/** 整块原文上限,与前端 QUOTE_MAX 同值(两边各自截,不互信)。 */
export const ANNOTATION_QUOTE_MAX = 1500;

type Operation =
  | { op: "add"; record: Annotation }
  | { op: "edit"; id: string; note: string; at: string }
  /** by 缺席 = 作者本人(老账);带 by = 管理员代闭环,审计凭它。 */
  | { op: "drop"; id: string; by?: string }
  | { op: "sent"; ids: string[]; via: SentVia; at: string; by?: string }
  | { op: "respond"; id: string; response: AnnotationResponse }
  /** via 只在责任人直接接住 draft 并答复时出现，使“接收 + 答复”成为
   * 一条原子台账操作；旧记录缺少 via 时仍按原语义回放。 */
  | { op: "owner_reply"; id: string; reply: AnnotationOwnerReply;
      via?: "owner_pending" }
  | { op: "verify"; id: string; at: string; by?: string }
  | { op: "reopen"; id: string; at: string;
      line?: number; anchor?: string; note?: string };

export class AnnotationError extends Error {}
export class AnnotationPermissionError extends AnnotationError {}

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
      if (operation.op === "edit") {
        const found = byId.get(operation.id);
        if (!found || found.status === "dropped") continue;
        found.note = operation.note;
        found.edited_at = operation.at;
        // 已送出的意见一旦改字，就不能继续冒充“这版已提交”。退回草稿，
        // 由责任人重新送出；旧内容和送出记录仍完整保留在 jsonl 中。
        if (found.status !== "draft") {
          // Agent 的追问不能随回执一起抹掉:它是作者这次改字的由头,下一轮
          // 要原样给模型看。
          if (found.response?.outcome === "needs_clarification") {
            found.clarifications = [...(found.clarifications ?? []), {
              question: found.response.summary,
              asked_at: found.response.responded_at,
              answered_at: operation.at,
            }];
          }
          found.status = "draft";
          found.sent_at = undefined;
          found.sent_via = undefined;
          found.sent_by = undefined;
          found.response = undefined;
          found.owner_reply = undefined;
          found.verified_at = undefined;
        }
        continue;
      }
      if (operation.op === "sent") {
        for (const id of operation.ids ?? []) {
          const found = byId.get(id);
          if (!found) continue;
          found.status = "sent";
          found.sent_at = operation.at;
          found.sent_via = operation.via;
          if (operation.by) found.sent_by = operation.by;
        }
        continue;
      }
      if (operation.op === "respond") {
        const found = byId.get(operation.id);
        if (!found || found.status === "draft" || found.status === "dropped") {
          continue;
        }
        // 晚到的旧轮回执不能覆盖新一轮返工。revision=0 兼容首轮。
        if (operation.response.revision === (found.rework ?? 0)) {
          found.response = operation.response;
        }
        continue;
      }
      if (operation.op === "owner_reply") {
        const found = byId.get(operation.id);
        if (!found || found.status === "dropped" || found.status === "verified") {
          continue;
        }
        if (found.status === "draft" && operation.via === "owner_pending") {
          found.status = "sent";
          found.sent_at = operation.reply.replied_at;
          found.sent_via = operation.via;
          found.sent_by = operation.reply.author;
        }
        if (found.status !== "sent") continue;
        found.owner_reply = operation.reply;
        continue;
      }
      if (operation.op === "verify") {
        const found = byId.get(operation.id);
        if (found) {
          found.status = "verified";
          found.verified_at = operation.at;
          found.verified_by = operation.by;
        }
        continue;
      }
      if (operation.op === "reopen") {
        const found = byId.get(operation.id);
        if (!found) continue;
        found.status = "draft";
        found.rework = (found.rework ?? 0) + 1;
        found.sent_at = undefined;
        found.sent_via = undefined;
        found.sent_by = undefined;
        found.response = undefined;
        found.owner_reply = undefined;
        found.verified_at = undefined;
        if (operation.anchor && operation.anchor !== found.anchor) {
          found.anchor_was = found.anchor;
          found.anchor = operation.anchor;
        }
        if (operation.line) found.line = operation.line;
        if (operation.note) found.note = operation.note;
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
    // 记为记忆可以不写一句话:圈的那段原文本身就是要记的东西(用户拍板,
    // "必须像批注一样输入想法"是多余负担)。交给人的意见仍必须有内容。
    if (!note && input.route !== "memory") throw new AnnotationError("批注内容不能为空");
    const anchor = String(input.anchor ?? "").trim();
    if (!anchor) throw new AnnotationError("缺少原文快照,批注无从定位");
    const artifact = String(input.artifact ?? "").trim();
    if (!artifact) throw new AnnotationError("缺少产物名");
    const line = Number.isFinite(input.line) ? Math.max(0, Math.trunc(input.line)) : 0;
    const quote = String(input.quote ?? "").trim();
    const lineEnd = Number.isFinite(input.line_end)
      ? Math.trunc(input.line_end as number) : 0;
    const record: Annotation = {
      id: `an-${Date.now().toString(36)}-${this.list().length + 1}`,
      author: String(input.author ?? "").trim() || "未署名",
      created_at: new Date().toISOString(),
      artifact,
      file: String(input.file ?? "").trim() || artifact,
      line,
      anchor,
      ...(quote ? { quote: quote.length > ANNOTATION_QUOTE_MAX
        ? quote.slice(0, ANNOTATION_QUOTE_MAX) + "…" : quote } : {}),
      ...(lineEnd > line ? { line_end: lineEnd } : {}),
      note,
      kind: input.kind === "code" ? "code" : "doc",
      ...(input.route && input.route !== "agent" ? { route: input.route } : {}),
      ...(input.assignee?.trim() ? { assignee: input.assignee.trim() } : {}),
      // 记忆条目没有"送出/回执/确认"这几站:人圈的那一下就是闭环。
      ...(input.route === "memory"
        ? { status: "verified" as const, verified_at: new Date().toISOString() }
        : { status: "draft" as const }),
    };
    this.append({ op: "add", record });
    return record;
  }

  /** 软删:多人环境里硬删等于替别人做主,留痕才查得清。
   *
   * 已送出的也允许移除。原来禁止,理由是"送出去撤不回来"——话没错,
   * 但清单是人自己的看板:提过二十条之后满屏都是已完成的旧条目,
   * 反而看不见当前要紧的那几条。移除只是从看板上拿掉,jsonl 里留痕
   * 照查;界面上因此把措辞分开说,别让人误以为能撤回。 */
  drop(id: string, by: string, override = false): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by && !override) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,不能替他删`);
    }
    // override = 管理员出路:作者不在场时,一条未闭环批注会把整单的
    // 推送永远锁死(2026-08-30 审计)。代删必须留痕(op.by),不是撤销
    // "谁的意见谁裁决"——那仍是默认规则,这里只是给死锁开的有账可查
    // 的门。
    this.append(found.author !== by
      ? { op: "drop", id, by } : { op: "drop", id });
    return { ...found, status: "dropped" };
  }

  /** 改意见只认作者，不认任务角色。已提交/已确认的意见修改后退回待提交，
   * 避免清单显示的是新文字，Agent 实际收到的却还是旧文字。 */
  edit(id: string, note: string, by: string): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,不能替他改`);
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    const normalized = String(note ?? "").trim();
    if (!normalized) throw new AnnotationError("批注内容不能为空");
    const at = new Date().toISOString();
    this.append({ op: "edit", id, note: normalized, at });
    return this.list().find((item) => item.id === id)!;
  }

  markSent(ids: string[], via: SentVia, by?: string): void {
    if (!ids.length) return;
    this.append({ op: "sent", ids, via, at: new Date().toISOString(), by });
  }

  /** 记录 Agent 的逐条回应。只接受已经提交且仍是当前 revision 的意见；
   * 作者是否认可由 verify/reopen 决定，绝不在这里自动闭环。 */
  respond(
    id: string,
    input: Omit<AnnotationResponse, "revision" | "responded_at"> & {
      revision?: number;
      responded_at?: string;
    },
  ): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.status === "draft") {
      throw new AnnotationError("批注尚未提交，不能登记 Agent 回应");
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    const revision = input.revision ?? (found.rework ?? 0);
    if (revision !== (found.rework ?? 0)) {
      throw new AnnotationError(
        `批注 ${id} 当前是第 ${(found.rework ?? 0) + 1} 轮，不能登记旧轮回应`,
      );
    }
    const summary = String(input.summary ?? "").trim();
    if (!summary) throw new AnnotationError("Agent 逐条回应不能为空");
    const response: AnnotationResponse = {
      revision,
      outcome: input.outcome,
      summary,
      evidence: [...new Set((input.evidence ?? [])
        .map((item) => String(item).trim()).filter(Boolean))].slice(0, 20),
      ...(input.fixed_sha?.trim() ? { fixed_sha: input.fixed_sha.trim() } : {}),
      responded_at: input.responded_at ?? new Date().toISOString(),
    };
    this.append({ op: "respond", id, response });
    return this.list().find((item) => item.id === id)!;
  }

  /** 责任人回答一条“问责任人 / 决策后处理”意见。只有指派对象可以答；
   * 管理员代答也应由上层显式传 override，并在 author 中留下真实操作者。 */
  replyAsOwner(
    id: string,
    by: string,
    text: string,
    override = false,
  ): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if ((found.route ?? "agent") === "agent") {
      throw new AnnotationError("这条意见是交给 Agent 处理的，不需要责任人答复");
    }
    if (found.status !== "draft" && found.status !== "sent") {
      throw new AnnotationError("这条意见当前不能答复");
    }
    if (found.owner_reply) {
      throw new AnnotationError("责任人已经答复；如需改变结论，请由提出人重新发起一轮");
    }
    if (found.assignee && found.assignee !== by && !override) {
      throw new AnnotationPermissionError(
        `这条意见指派给 ${found.assignee}，只能由他答复`,
      );
    }
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new AnnotationError("责任人答复不能为空");
    const reply: AnnotationOwnerReply = {
      author: by,
      text: normalized,
      replied_at: new Date().toISOString(),
    };
    this.append({
      op: "owner_reply", id, reply,
      ...(found.status === "draft" ? { via: "owner_pending" as const } : {}),
    });
    return this.list().find((item) => item.id === id)!;
  }

  /** 谁的意见谁裁决:和 drop 同一条规矩,替别人点"通过"等于替他签字。
   * override 是管理员的死锁出路,凭 op.by 留痕(见 drop 的注释)。 */
  private judgeable(id: string, by: string, override = false): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by && !override) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,只能由他裁决`);
    }
    if (found.status === "draft") {
      throw new AnnotationError("还没提交过,没有可裁决的改动");
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    return found;
  }

  /** 确认通过:人看过那处改动,认了。检视闭环的收口一步。 */
  verify(id: string, by: string, override = false): Annotation {
    const found = this.judgeable(id, by, override);
    const at = new Date().toISOString();
    const proxy = found.author !== by;
    this.append(proxy ? { op: "verify", id, at, by } : { op: "verify", id, at });
    return { ...found, status: "verified", verified_at: at,
             ...(proxy ? { verified_by: by } : {}) };
  }

  /**
   * 返工:改动没达到要求,退回草稿再送一轮。
   *
   * 不造新的送出机制——草稿本来就有两条路(跑动中插话/决定卡随批)。
   * 锚点可能已经失效(原文被改掉正是返工的常见起因),所以允许带上
   * 当前位置的新原文;旧原文存进 anchor_was,渲染时给模型看历史,
   * 免得它以为是条全新意见、把上一轮的改动又翻回去。
   */
  reopen(id: string, by: string, update?: {
    line?: number; anchor?: string; note?: string;
  }): Annotation {
    this.judgeable(id, by);
    this.append({
      op: "reopen", id, at: new Date().toISOString(),
      line: update?.line, anchor: update?.anchor?.trim() || undefined,
      note: update?.note?.trim() || undefined,
    });
    const replayed = this.list().find((item) => item.id === id)!;
    return replayed;
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
  const hasGraphAnnotations = ordered.some((item) =>
    item.artifact === REQUIREMENT_GRAPH_ARTIFACT);
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
    ...(hasGraphAnnotations ? [
      "- 标为“方案结构”的意见来自模块拆分图。按方案整体、模块 id 或依赖边定位，"
        + "不要拿展示行号去猜 JSON 行号。处理后必须同时更新 CHAIN 文档和"
        + " requirement-graph.json，并为两份产物换同一个新 plan_revision。",
    ] : []),
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
    // 稳定 id 是逐条回执的连接键。不能再靠“第 1 段大概回答第 1 条”猜，
    // Agent、服务端和页面都必须能精确指回同一条意见。
    const graphAnnotation = item.artifact === REQUIREMENT_GRAPH_ARTIFACT;
    const span = graphAnnotation ? "方案结构"
      : item.line_end && item.line_end > item.line
        ? `第 ${item.line}–${item.line_end} 行` : `第 ${item.line} 行`;
    lines.push(`${index}. [${item.id}] ${span}`);
    const label = item.kind === "code" ? "当前代码" : "原文";
    if (item.quote) {
      // 划选了一块:整块给模型看语境;定位仍以首行原文(anchor)为准。
      lines.push(`   ${label}(选中整块):`);
      for (const quoted of item.quote.split("\n")) lines.push(`   | ${quoted}`);
    } else {
      lines.push(`   ${label}:${item.anchor}`);
    }
    lines.push(`   要求:${item.note}`);
    // 追问过的意见:作者已经针对你的问题补充了,别再问同一件事。
    for (const asked of item.clarifications ?? []) {
      lines.push(`   上一轮你问过:${asked.question}`);
    }
    if (item.clarifications?.length) {
      lines.push("   作者已针对上面的问题补充了要求;不要再问同一件事,仍不清楚就按"
        + "最合理的理解处理,并在回执里写明你采用的假设。");
    }
    // 返工必须点明,不然模型把它当全新意见——轻则重复上一轮的改法,
    // 重则把已有改动翻回去。历史锚点一并给:它要能对出"上次改成了什么"。
    if (item.rework) {
      lines.push(`   注意:这是同一条意见的第 ${item.rework + 1} 次提出,`
        + "上一轮的改动没有达到要求。先弄清上次改了什么、差在哪,再动手;"
        + "不要原样重复上次的改法。");
      if (item.anchor_was) {
        lines.push(`   上一轮针对的原文:${item.anchor_was}`);
      }
    }
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
/** 比对前的归一化:锚点是渲染时抓的,文件里是源文本——两边必须按同
 * 一把尺子量,否则永远"找不到"。踩过两回:
 * - 只折叠空白那版,带缩进的代码全被误报"已被改动"(代码一字没动);
 * - 2026-08-20 内网实锤:带加粗(星号)、行内代码(反引号)、链接、
 *   表格竖线、标题井号的行,渲染把语法字符吃掉了,锚点拿"干净文本"
 *   回源文件里搜,批注刚圈上就被判"原文已删除"。
 * 所以:链接取显示文字,markdown 装饰字符与全部空白一律剥掉再比。
 * 代价是极小概率把"只动了标记/空白"的改动误判成没动——漏报一条提醒,
 * 远好过每条批注生下来就是误报(误报比不报更坏)。 */
function normalize(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_~|>#]/g, "")
    .replace(/\s+/g, "");
}

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
    // 空行/图块的锚点是"第 N 行"占位文本(人指的是位置不是文字),
    // 源文件里当然没有这串字——按位置放行,别把它判成"原文已删除"。
    if (/^第 \d+ 行$/.test(item.anchor)) {
      return { id: item.id, state: "hit", line: item.line };
    }
    const needle = normalize(item.anchor);
    if (!needle) return { id: item.id, state: "hit", line: item.line };
    const hits: number[] = [];
    lines.forEach((line, at) => {
      if (normalize(line).includes(needle)) hits.push(at + 1);
    });
    if (!hits.length) {
      // 代码块、表格等一个 DOM 块可能跨多行；浏览器抓到的是整块
      // textContent，逐行当然永远匹配不到。再按同一归一化口径搜索
      // 连续全文，并把命中起点还原为源文件行号，避免批注刚记下就 gone。
      const normalizedLines = lines.map(normalize);
      const joined = normalizedLines.join("");
      const first = joined.indexOf(needle);
      if (first >= 0) {
        let offset = 0;
        let line = 1;
        for (const [at, content] of normalizedLines.entries()) {
          if (first < offset + content.length) {
            line = at + 1;
            break;
          }
          offset += content.length;
        }
        const repeated = joined.indexOf(needle, first + 1) >= 0;
        return repeated
          ? { id: item.id, state: "ambiguous", line }
          : line === item.line
            ? { id: item.id, state: "hit", line }
            : { id: item.id, state: "moved", line };
      }
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
