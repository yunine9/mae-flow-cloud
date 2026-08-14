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
  waiting_id: string;
  task_id: string;
  account: string;
  step: string;
  summary: string;
  link: string;
  attempts: number;
  delivered: boolean;
  last_error: string;
}

export interface NotifierOptions {
  /** 小鲁班投递端点(真件=内网地址,演示=FakeLubanServer)。 */
  endpoint: string;
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
      attempts: 0,
      delivered: false,
      last_error: "",
    };
    this.records.set(input.waitingId, record);
    // 投递在后台走,不阻塞流程:通知只是提醒,待办本体在 Web。
    void this.deliver(record);
    return record;
  }

  private async deliver(record: NotifyRecord): Promise<void> {
    const backoff = this.options.backoffMs ?? [0, 2_000, 10_000];
    for (const delay of backoff) {
      if (delay) await new Promise((tick) => setTimeout(tick, delay));
      record.attempts += 1;
      try {
        const response = await fetch(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            account: record.account,
            text:
              `【Mae-Flow】任务 ${record.task_id} 等你决定` +
              `(${record.step || "当前步骤"}):${record.summary}`,
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
