/**
 * 断管免疫:stdout/stderr 的读端没了,服务不许死、也不许瘫。
 *
 * 内网实锤的事故链(crash.log 原文倒推):agent 后台起服,日志管道的
 * 读端先退 → 之后每一行 console 写都抛 EPIPE → 流上没有 error 监听,
 * EPIPE 成为 uncaughtException → 第一版 guardProcess 的 record 里又
 * console.error → 又 EPIPE → 无限递归把事件循环吃死。症状:进程还在、
 * CPU 0%、静态文件偶尔能出、API 全部超时、crash.log 同一毫秒刷出成对
 * 的 "write EPIPE",栈指向 record 自己——**兜底成了事故本体**。
 *
 * 这档用真子进程复现那个现场:起 serve → 掐断两条输出管道 → 在断管
 * 状态下登录、下单、答卡、等收口。全程 HTTP 必须正常应答——日志是
 * 旁路,旁路 fail-open,输出没了服务还在。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");
const SERVE = join(process.cwd(), "src", "serve.ts");

function waitListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() =>
      reject(new Error(`serve 未在期限内就绪,输出:\n${output}`)), 25_000);
    const watch = (chunk: Buffer) => {
      output += chunk.toString();
      // 必须锚定 "[serve] http://":日志里更早出现的是假小鲁班的地址,
      // 裸的 http 正则会先命中它——本测试的第一版就真跟假小鲁班聊了
      // 一整轮(它收什么都 200,断言全体通过,还以为在测 serve)。
      const hit = output.match(/\[serve\] http:\/\/127\.0\.0\.1:(\d+)/);
      if (hit) {
        clearTimeout(timer);
        resolve(hit[1]);
      }
    };
    child.stdout!.on("data", watch);
    child.stderr!.on("data", watch);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serve 提前退出(${code}),输出:\n${output}`));
    });
  });
}

async function api<T>(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000), // 5s 没回来就是事件循环出事了
  });
  return { status: response.status, body: await response.json() as T };
}

test("断管之后:登录、下单、答卡、收口,一路 HTTP 正常应答", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-epipe-"));
  const child = spawn(TSX, [
    SERVE, "--port", "0", "--data", join(dir, "tasks"), "--fresh",
  ], { env: { ...process.env, MAE_FLOW_NO_NOTIFY: "1" } });
  try {
    const port = await waitListening(child);
    const base = `http://127.0.0.1:${port}`;

    // 掐断两条输出管道(读端退出):此后 serve 的每一行日志都写向
    // 断管——演示任务的每个事件都会 console.log,这正是雷区本身。
    child.stdout!.destroy();
    child.stderr!.destroy();

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "mae-flow-demo" }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(login.status, 200, "断管后登录不许超时");
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
    const headers = { cookie };

    const created = await api<{ id: string }>(base, "/tasks", {
      method: "POST", headers,
      body: JSON.stringify({ requirement: "断管演练:全程日志写向断掉的管道" }),
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // 演示剧本会举一张审批卡:等它,然后在断管状态下答卡。
    const deadline = Date.now() + 30_000;
    let task: { status: string; waiting?: { state_version: number } };
    for (;;) {
      task = (await api<typeof task>(base, `/tasks/${id}`, { headers })).body;
      if (task.status === "waiting_for_human") break;
      assert.ok(Date.now() < deadline, `等卡超时,当前状态 ${task.status}`);
      await new Promise((tick) => setTimeout(tick, 150));
    }
    const decided = await api(base, `/tasks/${id}/decision`, {
      method: "POST", headers,
      body: JSON.stringify({
        state_version: task.waiting!.state_version, decision: "通过",
      }),
    });
    assert.equal(decided.status, 200, "断管后答卡不许超时");

    for (;;) {
      task = (await api<typeof task>(base, `/tasks/${id}`, { headers })).body;
      if (task.status === "completed" || task.status === "failed") break;
      assert.ok(Date.now() < deadline, `等收口超时,当前状态 ${task.status}`);
      await new Promise((tick) => setTimeout(tick, 150));
    }
    assert.equal(task.status, "completed", "断管不许影响任务结论");
    assert.equal(child.exitCode, null, "服务必须还活着");
  } finally {
    child.kill("SIGKILL");
  }
});
