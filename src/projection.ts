/**
 * PostgreSQL 投影(主 spec §11):看板展示、审计与恢复引导的读侧。
 *
 * 三条红线(设计文档原文,双状态机的学费不交第二次):
 * - 阶段真相只在工作区 `.mae-flow.json`。这里保存的是任务摘要投影、
 *   追加式事件日志副本与关键外部动作台账——永远是投影,不是第二个状态机;
 *   两者不一致时以工作区现场文件为准。
 * - 投影失败不改流程:所有写入 fail-open——失败记日志、流程照走。
 *   台账丢一页可以重放补齐,任务因为数据库抖动而失败是本末倒置。
 * - 恢复流程负责重放:重放源是现场文件(task.json / events.jsonl),
 *   幂等锚沿用事件日志的 (taskId, eventId),重灌是 no-op。
 *
 * 外部动作台账(§10/§11):MR 创建、流水线触发按幂等键落一行,
 * 带请求摘要、结果摘要、绑定代码版本与起止时间——恢复时"先查远端
 * 真实状态再决定是否继续"的查询底账。
 */

import pg from "pg";
import type { TaskSummary } from "./taskService.ts";
import type { SemanticEvent } from "./semanticEvents.ts";

/** 历史条目 = 任务摘要投影 + 只有历史侧才有的两个字段:
 * 事件量(联查带出)与最近更新时间(排序依据,页面说人话用)。 */
export type TaskHistoryEntry = TaskSummary & {
  event_count: number;
  updated_at: string;
};

export interface ExternalAction {
  taskId: string;
  /** 幂等键:同任务同键只落一行(如 mr:feat->master、pipeline:<sha>)。 */
  idemKey: string;
  kind: "mr_create" | "pipeline_trigger";
  request: Record<string, unknown>;
  result?: Record<string, unknown>;
  /** 绑定的代码版本:结果只为这个 SHA 背书(旧绿灯不背书新代码)。 */
  sha?: string;
  startedAt: string;
  finishedAt?: string;
}

const SCHEMA = `
create table if not exists tasks (
  task_id       text primary key,
  requirement   text not null,
  status        text not null,
  detail        text,
  luban_account text,
  workspace     text not null,
  created_at    timestamptz not null,
  waiting       jsonb,
  delivery      jsonb,
  updated_at    timestamptz not null default now()
);
create table if not exists task_events (
  task_id    text not null,
  event_id   bigint not null,
  session_id text not null,
  ts         text not null,
  kind       text not null,
  payload    jsonb not null,
  primary key (task_id, event_id)
);
create table if not exists external_actions (
  task_id     text not null,
  idem_key    text not null,
  kind        text not null,
  request     jsonb not null,
  result      jsonb,
  sha         text,
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (task_id, idem_key)
);
`;

export class PgProjection {
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;
  /** 最近一次写失败的原因:页面/测试观测用,流程从不读它。 */
  lastError?: string;

  constructor(
    connectionString: string,
    private log?: (message: string) => void,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
    // 空闲连接的后台错误(数据库重启等)不许变成进程级 unhandled error。
    this.pool.on("error", (error) => this.fail("pool", error));
  }

  /** 建表幂等,首次写入前保证一次;失败进入 fail-open 常规路径。 */
  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = this.pool.query(SCHEMA).then(() => undefined);
    return this.ready;
  }

  private fail(operation: string, error: unknown): void {
    this.lastError = `${operation}: ${String(error)}`;
    this.log?.(`[projection] 投影写入失败(${this.lastError}),流程不受影响`);
  }

  /** 任务摘要投影:落盘点与 task.json 相同(persist 时机),整行覆盖。 */
  async upsertTask(summary: TaskSummary): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `insert into tasks (task_id, requirement, status, detail,
           luban_account, workspace, created_at, waiting, delivery, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         on conflict (task_id) do update set
           status = excluded.status, detail = excluded.detail,
           waiting = excluded.waiting, delivery = excluded.delivery,
           luban_account = excluded.luban_account, updated_at = now()`,
        [
          summary.id, summary.requirement, summary.status,
          summary.detail ?? null, summary.luban_account ?? null,
          summary.workspace, summary.created_at,
          summary.waiting ? JSON.stringify(summary.waiting) : null,
          summary.delivery ? JSON.stringify(summary.delivery) : null,
        ]);
    } catch (error) {
      this.fail(`upsertTask ${summary.id}`, error);
    }
  }

  /** 事件副本:幂等锚 (taskId, eventId),重放冲突即 no-op。 */
  async appendEvent(event: SemanticEvent): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `insert into task_events (task_id, event_id, session_id, ts, kind, payload)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (task_id, event_id) do nothing`,
        [
          event.taskId, event.eventId, event.sessionId,
          event.ts, event.kind, JSON.stringify(event.payload),
        ]);
    } catch (error) {
      this.fail(`appendEvent ${event.taskId}#${event.eventId}`, error);
    }
  }

  /** 外部动作台账:同幂等键重复登记只更新结果侧,请求侧保留首次。 */
  async recordAction(action: ExternalAction): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `insert into external_actions
           (task_id, idem_key, kind, request, result, sha, started_at, finished_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (task_id, idem_key) do update set
           result = excluded.result, finished_at = excluded.finished_at`,
        [
          action.taskId, action.idemKey, action.kind,
          JSON.stringify(action.request),
          action.result ? JSON.stringify(action.result) : null,
          action.sha ?? null, action.startedAt, action.finishedAt ?? null,
        ]);
    } catch (error) {
      this.fail(`recordAction ${action.taskId}/${action.idemKey}`, error);
    }
  }

  /** 历史读侧:任务摘要投影(按最近更新倒序)。内存列表只有本进程
   * recover 到的任务;数据目录清理或换机后,历史只活在这里——
   * 看板/审计的跨生命周期入口。读失败抛错,纪律同 listActions。
   * 事件量随行带出:一条 left join 分组联查,不做 N+1。 */
  async listTaskHistory(limit = 100): Promise<TaskHistoryEntry[]> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      `select t.task_id, t.requirement, t.status, t.detail,
              t.luban_account, t.workspace, t.created_at, t.updated_at,
              t.waiting, t.delivery, coalesce(e.n, 0) as event_count
         from tasks t
         left join (select task_id, count(*)::int as n
                      from task_events group by task_id) e
           on e.task_id = t.task_id
        order by t.updated_at desc limit $1`,
      [limit]);
    return rows.rows.map((row) => ({
      id: row.task_id,
      requirement: row.requirement,
      status: row.status,
      detail: row.detail ?? undefined,
      luban_account: row.luban_account ?? undefined,
      workspace: row.workspace,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      waiting: row.waiting ?? undefined,
      delivery: row.delivery ?? undefined,
      event_count: row.event_count,
    }));
  }

  /** 历史条目的事件量指标:该任务的事件副本行数。读失败抛错。 */
  async countEvents(taskId: string): Promise<number> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      "select count(*)::int as n from task_events where task_id = $1",
      [taskId]);
    return rows.rows[0].n;
  }

  /** 审计读侧:某任务的外部动作台账(按开始时间正序)。
   * 读失败抛给调用方——审计查询失败必须可见,不适用写侧的 fail-open
   * (写丢一页可重放,读装没事就是骗人)。 */
  async listActions(taskId: string): Promise<ExternalAction[]> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      `select idem_key, kind, request, result, sha,
              started_at, finished_at
         from external_actions where task_id = $1 order by started_at`,
      [taskId]);
    return rows.rows.map((row) => ({
      taskId,
      idemKey: row.idem_key,
      kind: row.kind,
      request: row.request,
      result: row.result ?? undefined,
      sha: row.sha ?? undefined,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
