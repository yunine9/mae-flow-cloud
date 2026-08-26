/**
 * 小鲁班通知(主 spec §9/§14.4)——内网能力的可替换模拟。
 *
 * 语义三条,真假件共同遵守:
 * 1. WAITING_FOR_HUMAN 事件投递给任务创建时填写的账号,附审批链接;
 * 2. 投递失败不改变流程状态:Web 待办仍在,后台有限退避重试并记录
 *    投递结果,页面能看到"通知没送到"这个事实(标红的依据);
 * 3. 同一张待办不重复生成通知记录,重试只累计次数。
 *
 * 真小鲁班就绪时:换 endpoint 地址与鉴权头,本文件其余零改动;
 * FakeLubanServer 只在测试与演示里出场。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { humanApprovalStage } from "./lubanApprovalView.ts";

export interface NotifyRecord {
  /** 幂等键:待办通知=waiting_id;收口通知=taskId:outcome:状态。 */
  waiting_id: string;
  task_id: string;
  account: string;
  step: string;
  summary: string;
  link: string;
  /** 投递正文(说人话,构造时定稿;重试只重发不重写)。 */
  text: string;
  attempts: number;
  delivered: boolean;
  last_error: string;
}

export interface NotifyQuestion {
  question: string;
  options?: string[];
}

const MAX_NOTIFICATION_CONTEXT_CHARS = 2_400;

function notificationContext(value: string | undefined): string {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_NOTIFICATION_CONTEXT_CHARS) return normalized;
  return normalized.slice(0, MAX_NOTIFICATION_CONTEXT_CHARS - 18)
    + "\n…内容较长，已截断";
}

function questionDependsOnContext(question: string): boolean {
  return /上述|以上|如下|前述|完整配置|该配置|这些配置/.test(question);
}

function renderQuestionSummary(
  questions: NotifyQuestion[],
  fallback: string | undefined,
): string {
  if (!questions.length) return fallback?.trim() || "需要你确认";
  if (questions.length === 1) {
    const item = questions[0];
    return item.question + (item.options?.length
      ? `\n选项：${item.options.map((option, index) =>
          `${index + 1}. ${option}`).join("；")}`
      : "");
  }
  return [
    `共 ${questions.length} 个问题：`,
    ...questions.flatMap((item, index) => [
      `问题 ${index + 1}：${item.question}`,
      ...(item.options?.length
        ? [`选项：${item.options.map((option, optionIndex) =>
            `${optionIndex + 1}. ${option}`).join("；")}`]
        : []),
    ]),
  ].join("\n");
}

/** 最近一张待办通知携带的审批真相锚。它只用于让“唯一待办 + 裸回复”
 * 少一次查询；真正提交前 Gateway 仍会重新核对账号、waiting 与版本。 */
export interface LubanApprovalNotification {
  account: string;
  taskId: string;
  waitingId: string;
  stateVersion: number;
  code: string;
  notifiedAt: number;
}

/** 把一张待办里的全部问题定稿进通知正文。问题和选项保留结构直到
 * 通知边界再转成文本，避免上游先压成 questions[0] 后永久丢题。 */
function waitingSummary(input: {
  summary?: string;
  context?: string;
  questions?: NotifyQuestion[];
}): string {
  const questions = (input.questions ?? []).flatMap((item): NotifyQuestion[] => {
    const question = String(item?.question ?? "").trim();
    if (!question) return [];
    const options = Array.isArray(item.options)
      ? item.options.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    return [{ question, options }];
  });
  const context = notificationContext(input.context);
  const questionSummary = renderQuestionSummary(questions, input.summary);
  const missingRequiredContext = !context
    && questions.some((item) => questionDependsOnContext(item.question));
  return [
    ...(context ? ["待确认内容：", context] : []),
    ...(missingRequiredContext
      ? ["⚠ 被确认的具体内容没有随审批卡提供，不能只看选项安全决定。"]
      : []),
    questionSummary,
  ].join("\n");
}

export interface NotifierOptions {
  /** 小鲁班投递端点(真件=内网地址,演示=FakeLubanServer)。 */
  endpoint: string;
  /** 真件鉴权头(如 Authorization)。假件不需要;值是密钥,来自
   * 权限 600 的配置文件,不落日志。 */
  headers?: Record<string, string>;
  /** 运行时覆盖(管理页热改):每次投递现读,返回 endpoint/headers 的
   * 覆盖值,没有就回落静态配置。生效边界=下一条消息。 */
  live?: () => { endpoint?: string; headers?: Record<string, string> };
  /** 发件人的通知令牌(小鲁班以令牌对应的人的身份发消息,所以
   * 按发起人取,不是服务级配一个)。**只经请求头下发**——请求体会被外部
   * 动作台账原样记进投影,令牌进体等于把密钥写进数据库。 */
  personalToken?: (account: string) => string | undefined;
  /** 端点是假小鲁班(演示/试跑形态,serve 自己起的):假件收什么都行,
   * 个人令牌在它面前没有意义。这个标记让配置门禁不去索要一个谁也用
   * 不上的令牌——演示模式登进去第一件事就被"先配令牌"挡住,是内网
   * agent 端到端验证实测撞上的假门。 */
  fake?: boolean;
  /** 有限退避重试的间隔(毫秒);长度即最大重试次数。 */
  backoffMs?: number[];
  /** 小鲁班真实入站回复已完成端到端验收时，才在通知里承诺手机入口。 */
  mobileApproval?: boolean;
  /** 为当前 waiting 生成短期审批码。密钥留在实现闭包中，不进通知器。 */
  approvalCode?: (input: {
    account: string;
    taskId: string;
    waitingId: string;
    stateVersion: number;
  }) => string;
  log?: (message: string) => void;
}

export class Notifier {
  private records = new Map<string, NotifyRecord>();
  private latestApprovals = new Map<string, LubanApprovalNotification>();

  constructor(readonly options: NotifierOptions) {}

  list(): NotifyRecord[] {
    return [...this.records.values()];
  }

  /** 手机回调读最近通知的短期绑定。返回副本，调用方不能改通知器状态。 */
  latestApproval(account: string): LubanApprovalNotification | undefined {
    const found = this.latestApprovals.get(account);
    return found ? { ...found } : undefined;
  }

  /** 原位重跑或彻底删除后，旧任务通知不能继续占用幂等键。投递中的
   * Promise 只持有 record 对象，删除 Map 项后即使晚到也不会复活。 */
  purgeTask(taskId: string): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.task_id !== taskId) continue;
      this.records.delete(id);
      removed += 1;
    }
    for (const [account, binding] of this.latestApprovals) {
      if (binding.taskId === taskId) this.latestApprovals.delete(account);
    }
    return removed;
  }

  /** 配置门禁问的:这个通知器要不要逼人配个人令牌?
   * 假件在场且没被管理页热改成真端点 → 不要(令牌没人消费);
   * 管理页一旦切了真端点,要求立刻恢复——判定跟着**生效端点**走,
   * 不是跟着启动形态走。 */
  needsPersonalToken(): boolean {
    if (!this.options.fake) return true;
    return !!this.options.live?.()?.endpoint?.trim();
  }

  /** 自检只暴露“是否配置/最近是否失败”，不回端点鉴权内容。 */
  health(): { configured: boolean; last_error?: string } {
    const latest = this.list().at(-1);
    return {
      configured: !!this.target().endpoint.trim(),
      last_error: latest && !latest.delivered && latest.attempts > 0
        ? latest.last_error || "最近一条通知未送达" : undefined,
    };
  }

  /** 投递一张待办。同 waiting_id 幂等——恢复重放不重复通知。 */
  async notifyWaiting(input: {
    waitingId: string;
    stateVersion?: number;
    taskId: string;
    /** 面向人的任务称呼；DTS 可带问题单号，缺席时保持旧文案。 */
    subject?: string;
    account: string;
    step: string;
    /** 旧调用方可直接给摘要；正常待办应传结构化 questions，避免丢题。 */
    summary?: string;
    /** 提问前展示给用户的材料。“上述配置是否正确”所指的具体内容在这里。 */
    context?: string;
    questions?: NotifyQuestion[];
    link: string;
  }): Promise<NotifyRecord> {
    const existing = this.records.get(input.waitingId);
    if (existing) return existing;
    const visibleQuestions = this.options.mobileApproval
      ? input.questions?.slice(0, 1) : input.questions;
    const summary = waitingSummary({
      ...input,
      questions: visibleQuestions,
    });
    const questions = (input.questions ?? []).filter((item) =>
      String(item?.question ?? "").trim());
    const missingRequiredContext = !notificationContext(input.context)
      && (visibleQuestions ?? []).some((item) =>
        questionDependsOnContext(String(item?.question ?? "")));
    const approvalCode = this.options.mobileApproval && !missingRequiredContext
      && this.options.approvalCode && input.stateVersion !== undefined
      ? this.options.approvalCode({
          account: input.account,
          taskId: input.taskId,
          waitingId: input.waitingId,
          stateVersion: input.stateVersion,
        })
      : "";
    const stage = humanApprovalStage(input.step);
    const record: NotifyRecord = {
      waiting_id: input.waitingId,
      task_id: input.taskId,
      account: input.account,
      step: input.step,
      summary,
      link: input.link,
      text:
        `【Mae-Flow】${input.subject?.trim() || `任务 ${input.taskId}`} 等你决定` +
        `\n阶段：${stage}\n${summary}` +
        (this.options.mobileApproval
          ? missingRequiredContext
            ? "\n本通知缺少被确认内容，已禁止裸序号审批；请打开任务链接核对后处理。"
            : approvalCode
            ? "\n只有这一项待办时，可直接回复选项序号，例如：1"
              + `\n多项待办或无上下文时：mae-flow 选择 ${approvalCode} <序号>`
              + "\n如需说明：mae-flow 选择 " + approvalCode
              + " <序号> <补充说明>"
              + (questions.length > 1
                ? `\n本卡共 ${questions.length} 个问题，提交后继续显示下一题。`
                : "")
            : "\n手机处理：打开 Mae-Flow 插件并发送“待审批”"
          : ""),
      attempts: 0,
      delivered: false,
      last_error: "",
    };
    this.records.set(input.waitingId, record);
    if (approvalCode && input.stateVersion !== undefined) {
      this.latestApprovals.set(input.account, {
        account: input.account,
        taskId: input.taskId,
        waitingId: input.waitingId,
        stateVersion: input.stateVersion,
        code: approvalCode,
        notifiedAt: Date.now(),
      });
    }
    // 投递在后台走,不阻塞流程:通知只是提醒,待办本体在 Web。
    void this.deliver(record);
    return record;
  }

  /** 任务收口通知(完成/交付/失败)。同任务同状态幂等——
   * 恢复重放或催办多次收轮,用户只收一条。 */
  async notifyOutcome(input: {
    taskId: string;
    account: string;
    status: string;
    summary: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:outcome:${input.status}`;
    const existing = this.records.get(key);
    if (existing) return existing;
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: input.status,
      summary: input.summary,
      link: input.link,
      text: `【Mae-Flow】${input.summary}\n任务 ${input.taskId}`,
      attempts: 0,
      delivered: false,
      last_error: "",
    };
    this.records.set(key, record);
    void this.deliver(record);
    return record;
  }

  /** 责任人主动邀请 Committer 检视。与流程自动通知不同：
   * 每次点击都是一次明确动作，因此不跨点击幂等，并等待投递结果回给界面。 */
  async notifyReview(input: {
    taskId: string;
    senderAccount: string;
    account: string;
    summary: string;
    link: string;
  }): Promise<NotifyRecord> {
    const key = `${input.taskId}:review:${input.account}:${Date.now()}`;
    const record: NotifyRecord = {
      waiting_id: key,
      task_id: input.taskId,
      account: input.account,
      step: "committer_review",
      summary: input.summary,
      link: input.link,
      text: `【Mae-Flow】任务 ${input.taskId} 邀请你检视：${input.summary}`,
      attempts: 0,
      delivered: false,
      last_error: "",
    };
    this.records.set(key, record);
    await this.deliver(record, input.senderAccount);
    return record;
  }

  /** 当前生效的投递目标:运行时覆盖压过静态配置。 */
  private target(): { endpoint: string; headers: Record<string, string> } {
    const live = this.options.live?.() ?? {};
    return {
      endpoint: live.endpoint ?? this.options.endpoint,
      headers: { ...this.options.headers, ...live.headers },
    };
  }

  /** 测试投递(管理页按钮):单次、不重试、结果如实带回。
   * 它绕开台账(records)——测试消息不是业务事实,不该混进投递记录。 */
  async testDelivery(account: string): Promise<{ ok: boolean; error?: string }> {
    const { endpoint, headers } = this.target();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          account,
          text: "Mae-Flow 通知连通测试:看到这条即配置生效",
          link: "",
        }),
      });
      return response.ok
        ? { ok: true }
        : { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private async deliver(
    record: NotifyRecord,
    tokenAccount = record.account,
  ): Promise<void> {
    const backoff = this.options.backoffMs ?? [0, 2_000, 10_000];
    for (const delay of backoff) {
      if (delay) await new Promise((tick) => setTimeout(tick, delay));
      record.attempts += 1;
      try {
        const { endpoint, headers } = this.target();
        const personal = this.options.personalToken?.(tokenAccount);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headers,
            // 个人令牌走头不走体(密钥纪律,同交付链的 x-mfc-git-token):
            // 桥拿它填进内网接口要的字段,宿主这边台账里不会留下明文。
            ...(personal
              ? { "x-mfc-luban-token": encodeURIComponent(personal) } : {}),
          },
          body: JSON.stringify({
            account: record.account,
            text: record.text,
            link: record.link,
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        record.delivered = true;
        record.last_error = "";
        return;
      } catch (error) {
        record.last_error = String(error);
        this.options.log?.(
          `通知投递失败(第 ${record.attempts} 次): ${record.last_error}`);
      }
    }
    // 重试预算耗尽:留痕即可,流程状态一个字不动(§14.4)。
  }
}

/** 假小鲁班:收什么记什么,GET /messages 可查——演示与测试用。 */
export class FakeLubanServer {
  readonly messages: Array<Record<string, unknown>> = [];
  /** 测试注入:>0 时前 N 次请求返回 500,验证退避重试。 */
  failFirst = 0;
  private server?: Server;

  get endpoint(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/notify`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method === "GET") {
        const body = JSON.stringify(this.messages);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(body);
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (this.failFirst > 0) {
          this.failFirst -= 1;
          response.writeHead(500).end();
          return;
        }
        try {
          this.messages.push(
            JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
