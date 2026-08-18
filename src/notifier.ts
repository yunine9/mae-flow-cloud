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

export interface NotifierOptions {
  /** 小鲁班投递端点(真件=内网地址,演示=FakeLubanServer)。 */
  endpoint: string;
  /** 真件鉴权头(如 Authorization)。假件不需要;值是密钥,来自
   * 权限 600 的配置文件,不落日志。 */
  headers?: Record<string, string>;
  /** 运行时覆盖(管理页热改):每次投递现读,返回 endpoint/headers 的
   * 覆盖值,没有就回落静态配置。生效边界=下一条消息。 */
  live?: () => { endpoint?: string; headers?: Record<string, string> };
  /** 收件人自己的通知令牌(小鲁班以令牌对应的人的身份发消息,所以
   * 按人取,不是服务级配一个)。**只经请求头下发**——请求体会被外部
   * 动作台账原样记进投影,令牌进体等于把密钥写进数据库。 */
  personalToken?: (account: string) => string | undefined;
  /** 端点是假小鲁班(演示/试跑形态,serve 自己起的):假件收什么都行,
   * 个人令牌在它面前没有意义。这个标记让配置门禁不去索要一个谁也用
   * 不上的令牌——演示模式登进去第一件事就被"先配令牌"挡住,是内网
   * agent 端到端验证实测撞上的假门。 */
  fake?: boolean;
  /** 有限退避重试的间隔(毫秒);长度即最大重试次数。 */
  backoffMs?: number[];
  log?: (message: string) => void;
}

export class Notifier {
  private records = new Map<string, NotifyRecord>();

  constructor(readonly options: NotifierOptions) {}

  list(): NotifyRecord[] {
    return [...this.records.values()];
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
    taskId: string;
    account: string;
    step: string;
    summary: string;
    link: string;
  }): Promise<NotifyRecord> {
    const existing = this.records.get(input.waitingId);
    if (existing) return existing;
    const record: NotifyRecord = {
      waiting_id: input.waitingId,
      task_id: input.taskId,
      account: input.account,
      step: input.step,
      summary: input.summary,
      link: input.link,
      text:
        `【Mae-Flow】任务 ${input.taskId} 等你决定` +
        `(${input.step || "当前步骤"}):${input.summary}`,
      attempts: 0,
      delivered: false,
      last_error: "",
    };
    this.records.set(input.waitingId, record);
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
      text: `【Mae-Flow】任务 ${input.taskId} ${input.summary}`,
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
    await this.deliver(record);
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

  private async deliver(record: NotifyRecord): Promise<void> {
    const backoff = this.options.backoffMs ?? [0, 2_000, 10_000];
    for (const delay of backoff) {
      if (delay) await new Promise((tick) => setTimeout(tick, delay));
      record.attempts += 1;
      try {
        const { endpoint, headers } = this.target();
        const personal = this.options.personalToken?.(record.account);
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
