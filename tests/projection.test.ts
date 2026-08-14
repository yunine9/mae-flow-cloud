/**
 * PostgreSQL 投影语义(主 spec §11):
 * - 任务摘要 upsert 整行覆盖,事件副本按 (taskId,eventId) 幂等;
 * - 投影是旁路:数据库不可达时写入不抛错、流程无感(fail-open);
 * - 恢复重放以现场文件为源(task.json / events.jsonl),重灌是 no-op;
 * - 外部动作台账:同幂等键请求侧保留首次,结果侧允许补写。
 *
 * 裁判是真 PostgreSQL:临时集群建在测试目录里,unix socket 免端口
 * 冲突,跑完即拆。机器上没有 PG 二进制时整套跳过并明说——
 * 假装测过比没测更糟。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { PgProjection } from "../src/projection.ts";
import { TaskService } from "../src/taskService.ts";

function findPgBin(): string | undefined {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const which = spawnSync("which", ["initdb"], { encoding: "utf-8" });
  if (which.status === 0) return join(which.stdout.trim(), "..");
  return [
    "/opt/homebrew/opt/postgresql@17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/16/bin",
  ].find((dir) => existsSync(join(dir, "initdb")));
}

const PG_BIN = findPgBin();
const SKIP = PG_BIN
  ? false
  : "找不到 PostgreSQL 二进制(initdb);设 PG_BIN 或安装 postgresql 后重跑";
// socket 文件名带端口号,同机并发跑测试也不会互相踩。
const PORT = 54_000 + (process.pid % 1000);

let clusterDir = "";
let conn = "";

before(() => {
  if (SKIP) return;
  clusterDir = mkdtempSync(join(tmpdir(), "pg-projection-"));
  const dataDir = join(clusterDir, "data");
  const init = spawnSync(
    join(PG_BIN!, "initdb"),
    ["-D", dataDir, "-U", "postgres", "-A", "trust", "--no-sync"],
    { encoding: "utf-8" });
  assert.equal(init.status, 0, `initdb 失败: ${init.stderr}`);
  const start = spawnSync(
    join(PG_BIN!, "pg_ctl"),
    ["-D", dataDir, "-l", join(clusterDir, "pg.log"), "-w",
     "-o", `-p ${PORT} -k ${clusterDir} -c listen_addresses=''`,
     "start"],
    { encoding: "utf-8" });
  assert.equal(start.status, 0, `pg_ctl start 失败: ${start.stderr}`);
  conn = `postgresql://postgres@localhost/postgres`
    + `?host=${encodeURIComponent(clusterDir)}&port=${PORT}`;
});

after(() => {
  if (!clusterDir) return;
  spawnSync(join(PG_BIN!, "pg_ctl"),
    ["-D", join(clusterDir, "data"), "-m", "immediate", "stop"]);
  rmSync(clusterDir, { recursive: true, force: true });
});

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

function summaryOf(id: string, status: string) {
  return {
    id, requirement: "需求原话", status: status as never,
    created_at: new Date().toISOString(), workspace: `/w/${id}`,
  };
}

test("摘要 upsert 整行覆盖;事件副本按 (taskId,eventId) 幂等", { skip: SKIP },
  async () => {
    const projection = new PgProjection(conn);
    const judge = new pg.Pool({ connectionString: conn, max: 1 });
    try {
      await projection.upsertTask(summaryOf("task-1", "queued"));
      await projection.upsertTask(summaryOf("task-1", "running"));
      const tasks = await judge.query("select * from tasks");
      assert.equal(tasks.rowCount, 1);
      assert.equal(tasks.rows[0].status, "running");

      const event = {
        eventId: 1, taskId: "task-1", sessionId: "main",
        ts: "2026-08-14 20:00:00", kind: "user_message" as const,
        payload: { text: "开工" },
      };
      await projection.appendEvent(event);
      await projection.appendEvent(event); // 重放 = no-op
      const events = await judge.query("select * from task_events");
      assert.equal(events.rowCount, 1);
      assert.equal(events.rows[0].payload.text, "开工");
      assert.equal(projection.lastError, undefined);
    } finally {
      await judge.end();
      await projection.close();
    }
  });

test("外部动作台账:同幂等键请求侧保留首次,结果侧补写", { skip: SKIP },
  async () => {
    const projection = new PgProjection(conn);
    const judge = new pg.Pool({ connectionString: conn, max: 1 });
    try {
      const base = {
        taskId: "task-1", idemKey: "mr:feat->master",
        kind: "mr_create" as const,
        request: { source_branch: "feat" }, sha: "abc123",
        startedAt: new Date().toISOString(),
      };
      await projection.recordAction(base);
      await projection.recordAction({
        ...base, request: { source_branch: "被改写就是错" },
        result: { url: "http://mr/1" },
        finishedAt: new Date().toISOString(),
      });
      const rows = await judge.query(
        "select * from external_actions where idem_key = $1",
        ["mr:feat->master"]);
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].request.source_branch, "feat");
      assert.equal(rows.rows[0].result.url, "http://mr/1");
      assert.ok(rows.rows[0].finished_at);
      assert.equal(rows.rows[0].sha, "abc123");
    } finally {
      await judge.end();
      await projection.close();
    }
  });

test("fail-open:数据库不可达,写入不抛错,失败可观测", async () => {
  // 端口 1 永远连不上;这条不依赖临时集群,无 PG 二进制也要跑。
  const logs: string[] = [];
  const projection = new PgProjection(
    "postgresql://postgres@127.0.0.1:1/postgres",
    (message) => logs.push(message));
  try {
    await projection.upsertTask(summaryOf("task-9", "queued"));
    assert.ok(projection.lastError, "失败必须可观测");
    assert.ok(logs.some((line) => line.includes("流程不受影响")));
  } finally {
    await projection.close();
  }
});

test("恢复重放:以现场文件为源补齐投影,重灌是 no-op", { skip: SKIP },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "proj-recover-"));
    const workspace = join(dataDir, "task-1");
    mkdirSync(workspace, { recursive: true });
    const summary = {
      id: "task-1", requirement: "历史任务", status: "completed",
      created_at: "2026-08-14T10:00:00.000Z", workspace,
    };
    writeFileSync(join(workspace, "task.json"),
      JSON.stringify({ summary }));
    writeFileSync(join(workspace, "events.jsonl"), [
      { eventId: 1, taskId: "task-1", sessionId: "main",
        ts: "t1", kind: "session_started", payload: { resume: false } },
      { eventId: 2, taskId: "task-1", sessionId: "main",
        ts: "t2", kind: "turn_finished", payload: { reason: "end_turn" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const projection = new PgProjection(conn);
    const judge = new pg.Pool({ connectionString: conn, max: 1 });
    try {
      const build = () => new TaskService({
        dataDir, provider: "p", model: "m", modelsJson: {}, projection,
      });
      assert.equal(build().recover().restored, 1);
      assert.equal(build().recover().restored, 1); // 重灌 = no-op
      const events = await until(async () => {
        const rows = await judge.query(
          "select count(*)::int as n from task_events where task_id='task-1'");
        return rows.rows[0].n >= 2 ? rows.rows[0].n : undefined;
      }, "事件副本补齐");
      assert.equal(events, 2);
      const tasks = await judge.query(
        "select status from tasks where task_id='task-1'");
      assert.equal(tasks.rows[0].status, "completed");
      assert.equal(projection.lastError, undefined);
    } finally {
      await judge.end();
      await projection.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
