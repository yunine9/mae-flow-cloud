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
import type { WaitingRecord } from "./humanGate.ts";
import type { TaskSummary } from "./taskService.ts";

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
  secret: string;
  accountEnabled: (account: string) => boolean;
  now?: () => number;
  maxClockSkewMs?: number;
  log?: (message: string) => void;
}

interface Question {
  question: string;
  options: string[];
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

const CALLBACK_MAX_AGE_MS = 5 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const MAX_RESPONSE_CHARS = 3_800;

class CallbackError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 回调密钥只从 0600 文件读取，避免明文进入进程参数和部署配置 diff。 */
export function loadLubanPluginSecret(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("小鲁班插件密钥路径不是普通文件");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("小鲁班插件密钥文件权限必须是 0600");
  }
  const secret = readFileSync(path, "utf-8").trim();
  if (Buffer.byteLength(secret, "utf-8") < 32) {
    throw new Error("小鲁班插件密钥至少需要 32 字节");
  }
  return secret;
}

/** 部署桥与测试共用的签名算法：HMAC-SHA256(timestamp + '.' + rawBody)。 */
export function signLubanPluginCallback(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  return `sha256=${createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf-8").digest("hex")}`;
}

function oneLine(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function excerpt(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > limit
    ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function questionsOf(waiting: WaitingRecord): Question[] {
  const raw = (waiting.question as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Question[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { question?: unknown; options?: unknown };
    const question = String(record.question ?? "").trim();
    if (!question) return [];
    const options = Array.isArray(record.options)
      ? record.options.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    return [{ question, options }];
  });
}

function normalizeCode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function capReply(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return text.slice(0, MAX_RESPONSE_CHARS - 24)
    + "\n\n内容较长，已截断。";
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

function signatureBytes(value: string | undefined): Buffer | undefined {
  const hex = value?.trim().replace(/^sha256=/i, "");
  return hex && /^[a-f0-9]{64}$/i.test(hex)
    ? Buffer.from(hex, "hex") : undefined;
}

export class LubanApprovalGateway {
  private readonly replies = new Map<string, CachedReply>();
  private readonly inflight = new Map<string, InflightReply>();

  constructor(
    private readonly service: LubanApprovalService,
    private readonly options: LubanApprovalGatewayOptions,
  ) {
    if (Buffer.byteLength(options.secret, "utf-8") < 32) {
      throw new Error("小鲁班插件密钥至少需要 32 字节");
    }
  }

  /** HTTP 边界把原始正文交进来；必须在 JSON 解析前验签。 */
  async handle(input: {
    rawBody: string;
    timestamp?: string;
    signature?: string;
  }): Promise<LubanPluginReply> {
    try {
      this.verify(input);
      const envelope = parseEnvelope(input.rawBody);
      if (!this.options.accountEnabled(envelope.sender)) {
        throw new CallbackError(403, "该工号未启用 Mae-Flow 账号");
      }
      const digest = createHash("sha256")
        .update(`${input.timestamp}.${input.rawBody}`, "utf-8").digest("hex");
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
    timestamp?: string;
    signature?: string;
  }): void {
    const timestamp = String(input.timestamp ?? "").trim();
    if (!/^\d{10}$/.test(timestamp)) {
      throw new CallbackError(401, "回调时间戳缺失或格式不正确");
    }
    const at = Number(timestamp) * 1_000;
    const skew = this.options.maxClockSkewMs ?? CALLBACK_MAX_AGE_MS;
    if (!Number.isFinite(at) || Math.abs(this.now() - at) > skew) {
      throw new CallbackError(401, "回调已过期，请重新操作");
    }
    const actual = signatureBytes(input.signature);
    const expected = signatureBytes(signLubanPluginCallback(
      this.options.secret, timestamp, input.rawBody));
    if (!actual || !expected || actual.length !== expected.length
        || !timingSafeEqual(actual, expected)) {
      throw new CallbackError(401, "回调签名无效");
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
  }

  private pending(account: string): TaskSummary[] {
    return this.service.list().filter((task) =>
      task.luban_account === account
      && task.status === "waiting_for_human"
      && task.waiting?.status === "waiting");
  }

  private approvalCode(task: TaskSummary): string {
    const waiting = task.waiting!;
    return createHmac("sha256", this.options.secret).update([
      "approval", task.luban_account, task.id,
      waiting.waiting_id, waiting.state_version,
    ].join("\0"), "utf-8").digest("hex").slice(0, 10).toUpperCase();
  }

  private find(account: string, code: string): TaskSummary | undefined {
    const wanted = normalizeCode(code);
    return this.pending(account).find((task) =>
      this.approvalCode(task) === wanted);
  }

  private async execute(envelope: LubanPluginEnvelope): Promise<LubanPluginReply> {
    const command = envelope.content
      .replace(/^\/?mae(?:-flow)?(?:\s+|$)/i, "").trim();
    if (!command || /^(?:待审批|审批|我的审批)$/.test(command)) {
      return { status: 200, text: this.renderList(envelope.sender) };
    }
    if (/^(?:帮助|help|\?)$/i.test(command)) {
      return { status: 200, text: this.renderHelp() };
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
        return { status: 400, text: "退回必须写明意见，例如：mae 退回 A7K9 请补充异常场景" };
      }
      return await this.chooseByMeaning(
        envelope.sender, match[1], false, match[2].trim());
    }
    return { status: 400, text: "没有识别这条指令。\n\n" + this.renderHelp() };
  }

  private renderHelp(): string {
    return [
      "Mae-Flow 手机审批指令：",
      "mae 待审批",
      "mae 详情 <审批码>",
      "mae 选择 <审批码> <选项序号>",
      "mae 通过 <审批码>",
      "mae 退回 <审批码> <意见>",
    ].join("\n");
  }

  private renderList(account: string): string {
    const pending = this.pending(account);
    if (!pending.length) return "当前没有待审批事项。";
    const shown = pending.slice(0, 5);
    const lines = [`你有 ${pending.length} 项待审批：`];
    shown.forEach((task) => {
      const waiting = task.waiting!;
      const questions = questionsOf(waiting);
      lines.push("", `【${this.approvalCode(task)}】${task.id} · ${oneLine(task.title ?? task.requirement, 80)}`);
      lines.push(`阶段：${oneLine(waiting.step || "当前步骤", 50)}`);
      lines.push(`事项：${oneLine(questions[0]?.question ?? "需要你确认", 110)}`);
      if (questions.length > 1) lines.push(`提示：包含 ${questions.length} 个问题，请在电脑端处理`);
      lines.push(`查看：mae 详情 ${this.approvalCode(task)}`);
    });
    if (pending.length > shown.length) {
      lines.push("", `另有 ${pending.length - shown.length} 项，请处理后再次查询。`);
    }
    return capReply(lines.join("\n"));
  }

  private detail(account: string, code: string): LubanPluginReply {
    const task = this.find(account, code);
    if (!task) return this.stale();
    const waiting = task.waiting!;
    const questions = questionsOf(waiting);
    const lines = [
      `【${this.approvalCode(task)}】${task.id} · ${oneLine(task.title ?? task.requirement, 100)}`,
      `阶段：${oneLine(waiting.step || "当前步骤", 80)}`,
    ];
    if (waiting.context?.trim()) {
      lines.push("", "审批上下文：", excerpt(waiting.context, 1_000));
    }
    if (!questions.length) {
      lines.push("", "当前待办没有可读取的问题，请在电脑端处理。" );
      return { status: 200, text: capReply(lines.join("\n")) };
    }
    questions.forEach((question, index) => {
      lines.push("", `${questions.length > 1 ? `问题 ${index + 1}：` : "问题："}${question.question}`);
      question.options.forEach((option, optionIndex) =>
        lines.push(`${optionIndex + 1}. ${option}`));
    });
    if (questions.length > 1) {
      lines.push("", "这是一张多题澄清卡。为避免错配答案，首版手机入口不提交多题决定，请在电脑端处理。" );
    } else if (questions[0].options.length) {
      lines.push("", `提交：mae 选择 ${this.approvalCode(task)} <序号>`);
      lines.push(`退回：mae 退回 ${this.approvalCode(task)} <意见>`);
    } else {
      lines.push("", `回复：mae 回复 ${this.approvalCode(task)} <答复>`);
    }
    return { status: 200, text: capReply(lines.join("\n")) };
  }

  private async choose(
    account: string,
    code: string,
    optionNumber: number,
    notes?: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale();
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1) {
      return { status: 400, text: "该事项包含多项问题，请在电脑端处理，避免答案错配。" };
    }
    const option = questions[0].options[optionNumber - 1];
    if (!option) {
      return { status: 400, text: `选项序号无效，请发送：mae 详情 ${this.approvalCode(task)}` };
    }
    return await this.submit(task, option, notes);
  }

  private async reply(
    account: string,
    code: string,
    answer: string,
  ): Promise<LubanPluginReply> {
    const task = this.find(account, code);
    if (!task) return this.stale();
    const questions = questionsOf(task.waiting!);
    if (questions.length !== 1 || questions[0].options.length) {
      return { status: 400, text: `该事项应按选项提交，请发送：mae 详情 ${this.approvalCode(task)}` };
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
    if (!task) return this.stale();
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
        + `mae 详情 ${this.approvalCode(task)}，再用“mae 选择 审批码 序号”。` };
    }
    return await this.submit(task, matches[0], notes);
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
      return {
        status: 200,
        text: `已提交：${task.id} · ${decision}\n当前状态：${result.status}`,
      };
    } catch (error) {
      const message = String(error);
      if (/状态已变化|没有待人工决定|不存在|版本不匹配/.test(message)) {
        return this.stale();
      }
      this.options.log?.(`任务 ${task.id} 手机审批提交失败: ${message}`);
      return { status: 500, text: "审批没有提交成功，请稍后重试或回到电脑端处理。" };
    }
  }

  private stale(): LubanPluginReply {
    return {
      status: 409,
      text: "审批事项已更新或审批码已过期，请重新发送：mae 待审批",
    };
  }
}
