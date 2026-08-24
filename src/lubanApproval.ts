/**
 * 小鲁班插件的纯文本审批入口。
 *
 * 它只是一层移动端输入适配：任务、待办、权限与决定仍以 TaskService
 * 为唯一真相；这里不保存第二份审批状态，也不替内核解释决定。
 * 小鲁班真实回调形状未知时，由部署侧桥转换成本文件的稳定小契约。
 */

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  readFileSync,
  statSync,
} from "node:fs";
import type { TaskSummary } from "./taskService.ts";
import {
  questionsOf,
  renderLubanDetail,
  renderLubanHelp,
  renderLubanTaskList,
} from "./lubanApprovalView.ts";

export interface LubanApprovalService {
  list(): TaskSummary[];
  decide(id: string, input: {
    state_version: number;
    decision?: string;
    answers?: Record<string, string>;
    notes?: string;
  }): Promise<TaskSummary>;
}

export interface LubanPluginEnvelope {
  message_id: string;
  sender: string;
  content: string;
}

export interface LubanPluginReply {
  status: number;
  text: string;
  replayed?: boolean;
}

export interface LubanApprovalGatewayOptions {
  token: string;
  accountEnabled: (account: string) => boolean;
  now?: () => number;
  log?: (message: string) => void;
}

interface CachedReply {
  digest: string;
  at: number;
  reply: LubanPluginReply;
}

interface InflightReply {
  digest: string;
  promise: Promise<LubanPluginReply>;
}

interface BoundApproval {
  taskId: string;
  waitingId: string;
  stateVersion: number;
  code: string;
}

interface ConversationCursor {
  at: number;
  entries: BoundApproval[];
  selected?: BoundApproval;
}

const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 1_000;
class CallbackError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 回调 Token 只从 0600 文件读取，避免明文进入进程参数和部署配置 diff。 */
export function loadLubanPluginToken(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("小鲁班插件 Token 路径不是普通文件");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("小鲁班插件 Token 文件权限必须是 0600");
  }
  const token = readFileSync(path, "utf-8").trim();
  if (Buffer.byteLength(token, "utf-8") < 32) {
    throw new Error("小鲁班插件 Token 至少需要 32 字节");
  }
  return token;
}

function normalizeCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function parseEnvelope(rawBody: string): LubanPluginEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new CallbackError(400, "回调 JSON 格式不正确");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CallbackError(400, "回调正文必须是 JSON 对象");
  }
  const input = body as Record<string, unknown>;
  const messageId = String(input.message_id ?? "").trim();
  const sender = String(input.sender ?? "").trim();
  const content = String(input.content ?? "").trim();
  if (!messageId || messageId.length > 128 || /[\0\r\n]/.test(messageId)) {
    throw new CallbackError(400, "message_id 缺失或格式不正确");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sender)) {
    throw new CallbackError(400, "sender 缺失或格式不正确");
  }
  if (!content || content.length > 2_000 || /\0/.test(content)) {
    throw new CallbackError(400, "content 缺失或过长");
  }
  return { message_id: messageId, sender, content };
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual, "utf-8");
  const right = Buffer.from(expected, "utf-8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class LubanApprovalGateway {
  private readonly replies = new Map<string, CachedReply>();
  private readonly inflight = new Map<string, InflightReply>();
  /**
   * 只保存“用户刚刚在看哪张卡”的短期导航上下文。审批真相仍完全来自
   * TaskService；每次裸回复提交前都会重新核对 waiting_id/state_version。
   */
  private readonly cursors = new Map<string, ConversationCursor>();

  constructor(
    private readonly service: LubanApprovalService,
    private readonly options: LubanApprovalGatewayOptions,
  ) {
    if (Buffer.byteLength(options.token, "utf-8") < 32) {
      throw new Error("小鲁班插件 Token 至少需要 32 字节");
    }
  }

  /** 固定 Token 只证明请求来自受信插件/桥；任务版本仍负责防陈旧决定。 */
  async handle(input: {
    rawBody: string;
    token?: string;
  }): Promise<LubanPluginReply> {
    try {
      this.verify(input);
      const envelope = parseEnvelope(input.rawBody);
      if (!this.options.accountEnabled(envelope.sender)) {
        throw new CallbackError(403, "该工号未启用 Mae-Flow 账号");
      }
      const digest = createHash("sha256")
        .update(input.rawBody, "utf-8").digest("hex");
      this.pruneCache();
      const cached = this.replies.get(envelope.message_id);
      if (cached) {
        if (cached.digest !== digest) {
          throw new CallbackError(409, "message_id 已被其他请求使用");
        }
        return { ...cached.reply, replayed: true };
      }
      const running = this.inflight.get(envelope.message_id);
      if (running) {
        if (running.digest !== digest) {
          throw new CallbackError(409, "message_id 已被其他请求使用");
        }
        return { ...(await running.promise), replayed: true };
      }
      const promise = this.execute(envelope).then((reply) => {
        this.replies.set(envelope.message_id, {
          digest, at: this.now(), reply,
        });
        return reply;
      }).finally(() => {
        this.inflight.delete(envelope.message_id);
      });
      this.inflight.set(envelope.message_id, { digest, promise });
      return await promise;
    } catch (error) {
      if (error instanceof CallbackError) {
        return { status: error.status, text: error.message };
      }
      this.options.log?.(`小鲁班审批回调失败: ${String(error)}`);
      return { status: 500, text: "Mae-Flow 暂时无法处理，请稍后重试" };
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private verify(input: {
    rawBody: string;
    token?: string;
  }): void {
    if (!sameToken(input.token, this.options.token)) {
      throw new CallbackError(401, "回调 Token 无效");
    }
  }

  private pruneCache(): void {
    const oldest = this.now() - CACHE_TTL_MS;
    for (const [id, record] of this.replies) {
      if (record.at < oldest) this.replies.delete(id);
    }
    while (this.replies.size > MAX_CACHE_ENTRIES) {
      const first = this.replies.keys().next().value as string | undefined;
      if (!first) break;
      this.replies.delete(first);
    }
    for (const [account, cursor] of this.cursors) {
      if (cursor.at < oldest) this.cursors.delete(account);
    }
  }

  private pending(account: string): TaskSummary[] {
    return this.service.list().filter((task) =>
      task.luban_account === account
      && task.status === "waiting_for_human"
      && task.waiting?.status === "waiting");
  }

  private approvalCode(task: TaskSummary): string {
    const waiting = task.waiting!;
    return createHmac("sha256", this.options.token).update([
      "approval", task.luban_account, task.id,
      waiting.waiting_id, waiting.state_version,
    ].join("\0"), "utf-8").digest("hex").slice(0, 10).toUpperCase();
  }

  private find(account: string, code: string): TaskSummary | undefined {
    const wanted = normalizeCode(code);
    return this.pending(account).find((task) =>
      this.approvalCode(task) === wanted);
  }

  private bind(task: TaskSummary): BoundApproval {
    return {
      taskId: task.id,
      waitingId: task.waiting!.waiting_id,
      stateVersion: task.waiting!.state_version,
      code: this.approvalCode(task),
    };
  }

  private taskFor(account: string, binding: BoundApproval): TaskSummary | undefined {
    return this.pending(account).find((task) => task.id === binding.taskId
      && task.waiting!.waiting_id === binding.waitingId
      && task.waiting!.state_version === binding.stateVersion
      && this.approvalCode(task) === binding.code);
  }

  private async execute(envelope: LubanPluginEnvelope): Promise<LubanPluginReply> {
    const command = envelope.content
      .replace(/^\/?mae(?:-flow)?(?:\s+|$)/i, "").trim();
    if (!command || /^(?:待审批|审批|我的审批)$/.test(command)) {
      return this.showPending(envelope.sender);
    }
    if (/^(?:帮助|help|\?)$/i.test(command)) {
      return { status: 200, text: renderLubanHelp() };
    }
    let match = command.match(/^详情\s+([A-Za-z0-9_-]+)$/i);
    if (match) return this.detail(envelope.sender, match[1]);
    match = command.match(/^选择\s+([A-Za-z0-9_-]+)\s+(\d+)(?:\s+([\s\S]+))?$/i);
    if (match) {
      return await this.choose(envelope.sender, match[1], Number(match[2]),
        match[3]?.trim());
    }
    match = command.match(/^回复\s+([A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
    if (match) {
      return await this.reply(envelope.sender, match[1], match[2].trim());
    }
    match = command.match(/^通过\s+([A-Za-z0-9_-]+)$/i);
    if (match) return await this.chooseByMeaning(envelope.sender, match[1], true);
    match = command.match(/^退回\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]+))?$/i);
    if (match) {
      if (!match[2]?.trim()) {
        return { status: 400, text: "退回必须写明意见，例如：mae-flow 退回 A7K9 请补充异常场景" };
      }
      return await this.chooseByMeaning(
        envelope.sender, match[1], false, match[2].trim());
    }
    return await this.answerFromCursor(envelope.sender, command);
  }

  private showPending(account: string): LubanPluginReply {
    const pending = this.pending(account);
    if (!pending.length) {
      this.cursors.delete(account);
      return { status: 200, text: "当前没有待审批事项。" };
    }
    if (pending.length === 1) {
      const binding = this.bind(pending[0]);
      this.cursors.set(account, {
        at: this.now(), entries: [binding], selected: binding,
      });
      return this.renderDetail(pending[0]);
    }
    const shown = pending.slice(0, 5);
    const entries = shown.map((task) => this.bind(task));
    this.cursors.set(account, { at: this.now(), entries });
    return { status: 200, text: renderLubanTaskList(shown, pending.length) };
  }

  private detail(account: string, code: string): LubanPluginReply {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const binding = this.bind(task);
    this.cursors.set(account, {
      at: this.now(), entries: [binding], selected: binding,
    });
    return this.renderDetail(task);
  }

  private renderDetail(task: TaskSummary): LubanPluginReply {
    return { status: 200, text: renderLubanDetail(task, this.approvalCode(task)) };
  }

  private async choose(
    account: string,
    code: string,
    optionNumber: number,
    notes?: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1) {
      return { status: 400, text: "该事项包含多项问题，请在电脑端处理，避免答案错配。" };
    }
    const option = questions[0].options[optionNumber - 1];
    if (!option) {
      return { status: 400, text: `选项序号无效，请发送：mae-flow 详情 ${this.approvalCode(task)}` };
    }
    return await this.submit(task, option, notes);
  }

  private async reply(
    account: string,
    code: string,
    answer: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1 || questions[0].options.length) {
      return { status: 400, text: `该事项应按选项提交，请发送：mae-flow 详情 ${this.approvalCode(task)}` };
    }
    if (!answer) return { status: 400, text: "答复不能为空" };
    return await this.submit(task, answer);
  }

  private async chooseByMeaning(
    account: string,
    code: string,
    positive: boolean,
    notes?: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1) {
      return { status: 400, text: "该事项不是单题审批，请先查看详情并在电脑端处理。" };
    }
    const negativePattern = /打回|退回|修改|拒绝|不通过/;
    const positivePattern = /通过|确认|同意|接受|批准|继续/;
    // “不通过”同时含“通过”；正向快捷命令必须排除所有负向词。
    // 边界选项宁可要求用户按序号选择，也不能自作聪明选反。
    const matches = questions[0].options.filter((option) => positive
      ? positivePattern.test(option) && !negativePattern.test(option)
      : negativePattern.test(option));
    if (matches.length !== 1) {
      return { status: 400, text: "无法安全判断你指的是哪个选项，请发送："
        + `mae-flow 详情 ${this.approvalCode(task)}，再用“mae-flow 选择 审批码 序号”。` };
    }
    return await this.submit(task, matches[0], notes);
  }

  private async answerFromCursor(
    account: string,
    answer: string,
  ): Promise<LubanPluginReply> {
    const cursor = this.cursors.get(account);
    if (!cursor || cursor.at < this.now() - CACHE_TTL_MS) {
      this.cursors.delete(account);
      return {
        status: 400,
        text: "没有找到你正在处理的审批，请先发送：mae-flow 待审批",
      };
    }
    if (!cursor.selected) {
      const number = Number(answer);
      const binding = Number.isInteger(number) ? cursor.entries[number - 1] : undefined;
      if (!binding) {
        return { status: 400, text: "请先回复待办前的任务序号，查看完整详情。" };
      }
      const task = this.taskFor(account, binding);
      if (!task) return this.stale(account);
      cursor.selected = binding;
      cursor.at = this.now();
      return this.renderDetail(task);
    }
    const task = this.taskFor(account, cursor.selected);
    if (!task) return this.stale(account);
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1) {
      return { status: 400, text: "该事项包含多项问题，请在电脑端处理，避免答案错配。" };
    }
    const number = Number(answer);
    if (Number.isInteger(number) && String(number) === answer.trim()) {
      const option = questions[0].options[number - 1];
      if (!option) return { status: 400, text: "选项序号无效，请按详情中的序号回复。" };
      return await this.submit(task, option);
    }
    if (!questions[0].options.length) return await this.submit(task, answer);

    const exact = questions[0].options.find((option) => option === answer);
    if (exact) return await this.submit(task, exact);
    const negative = questions[0].options.filter((option) =>
      /打回|退回|修改|拒绝|不通过|调整|补充/.test(option));
    const positive = questions[0].options.filter((option) =>
      /通过|确认|同意|接受|批准|继续/.test(option)
      && !/打回|退回|修改|拒绝|不通过/.test(option));
    const negativeIntent = /打回|退回|拒绝|不通过|不行|不对|有问题|请.{0,8}(?:改|补充|调整)|改成|需要修改|需要补充|需要调整/;
    const positiveIntent = /通过|确认|同意|接受|批准|继续|可以|没问题|好的?|\bok\b|\byes\b/i;
    if (positiveIntent.test(answer) && !negativeIntent.test(answer)
        && positive.length === 1) {
      return await this.submit(task, positive[0]);
    }
    if (negative.length === 1) {
      // 自然语言修改意见既保留原文，又提交卡片已有的“修改/退回”选项，
      // 避免内核把一段自由文本误当成未知选项而重新追问。
      return await this.submit(task, negative[0], answer);
    }
    // Web 本就允许自定义回答；没有唯一安全的选项映射时保持用户原意，
    // 不让插件或 Cloud 猜测一个可能相反的决定。
    return await this.submit(task, answer);
  }

  private async submit(
    task: TaskSummary,
    decision: string,
    notes?: string,
  ): Promise<LubanPluginReply> {
    try {
      const result = await this.service.decide(task.id, {
        state_version: task.waiting!.state_version,
        decision,
        notes: notes ? `小鲁班手机审批：${notes}` : "小鲁班手机审批",
      });
      if (task.luban_account) this.cursors.delete(task.luban_account);
      return {
        status: 200,
        text: `已提交：${task.id} · ${decision}\n当前状态：${result.status}`,
      };
    } catch (error) {
      const message = String(error);
      if (/状态已变化|没有待人工决定|不存在|版本不匹配/.test(message)) {
        return this.stale(task.luban_account);
      }
      this.options.log?.(`任务 ${task.id} 手机审批提交失败: ${message}`);
      return { status: 500, text: "审批没有提交成功，请稍后重试或回到电脑端处理。" };
    }
  }

  private stale(account?: string): LubanPluginReply {
    if (account) this.cursors.delete(account);
    return {
      status: 409,
      text: "审批事项已更新或审批码已过期，请重新发送：mae-flow 待审批",
    };
  }
}
