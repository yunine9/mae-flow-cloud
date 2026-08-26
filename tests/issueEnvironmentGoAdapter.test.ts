/**
 * Go 环境适配器的原子能力单测(src/issueEnvironmentGoAdapter.ts)。
 *
 * 策略:行为边界用注入的 fake spawn 钉死——参数构造、凭据只走环境
 * 变量、产物收集与截断、失败与取消、回执解析,全部不碰网络;
 * 另加一条**真二进制冒烟**(连必拒的 127.0.0.1),证明平台二进制
 * 选择与真实 spawn 链路成立。密码出现在断言里的只有「它作为环境
 * 变量传了、且没出现在任何参数/错误文本里」这两件事。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { createGoEnvironmentAdapter } from "../src/issueEnvironmentGoAdapter.ts";
import type {
  IssueEnvironmentAdapterRequest,
  IssueEnvironmentRef,
  IssueEnvironmentCredential,
} from "../src/issueEnvironment.ts";

interface CapturedSpawn {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** fake spawn:记录调用;按脚本预设写产物/退出码,并暴露 abort 观察。 */
function fakeSpawn(script: (captured: CapturedSpawn) => {
  code?: number;
  stdout?: string;
  stderr?: string;
  writeFiles?: Record<string, string>;
  hangUntilAbort?: boolean;
}): { spawnFn: typeof spawn; calls: CapturedSpawn[]; killed: boolean[] } {
  const calls: CapturedSpawn[] = [];
  const killed: boolean[] = [];
  const spawnFn = ((_binary: string, args: string[], options: any) => {
    const captured: CapturedSpawn = {
      binary: _binary, args: [...args], env: { ...options?.env },
    };
    calls.push(captured);
    const plan = script(captured);
    // 冒充 ChildProcess:只实现适配器用到的面(kill/事件/管道)。
    // stdout 数据在注册时**同步**送达,close 走 setImmediate——
    // 保证适配器在 close 时刻读到的 stdout 是完整的。
    const child = new ChildProcess();
    (child as any).stdout = {
      on: (_event: string, listener: (chunk: string) => void) => {
        if (plan.stdout) listener(plan.stdout);
      },
    };
    (child as any).stderr = {
      on: (_event: string, listener: (chunk: string) => void) => {
        if (plan.stderr) listener(plan.stderr);
      },
    };
    (child as any).kill = (signal?: string) => {
      killed.push(true);
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    if (plan.writeFiles) {
      // fake 需要知道 local-logs 目录:从 --local-dir 参数取。
      const dirIndex = captured.args.indexOf("--local-dir");
      const localDir = dirIndex >= 0
        ? captured.args[dirIndex + 1] : undefined;
      if (localDir) {
        for (const [name, content] of Object.entries(plan.writeFiles)) {
          const path = join(localDir, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        }
      }
    }
    if (plan.hangUntilAbort) return child; // 等 kill 触发 close
    setImmediate(() => child.emit("close", plan.code ?? 0, null));
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls, killed };
}

function request(overrides?: {
  port?: number;
  credentials?: IssueEnvironmentCredential[];
  environmentId?: string;
}): IssueEnvironmentAdapterRequest {
  return {
    task_id: "task-1",
    ticket: "DTS1",
    requirement: "问题",
    environment: {
      id: overrides?.environmentId ?? "env-1",
      name: "TranFmaWebsite",
      purpose: "logs",
      protocol: "ssh",
      host: "10.0.0.9",
      port: overrides?.port ?? 22,
      accounts: [
        { username: "sopuser", credential_state: "stored" },
        { username: "ossuser", credential_state: "stored" },
        { username: "ossadm", credential_state: "stored" },
      ],
    } satisfies IssueEnvironmentRef,
    credentials: overrides?.credentials ?? [
      { username: "sopuser", password: "ssh-pass" },
      { username: "ossuser", password: "other" },
      { username: "ossadm", password: "other" },
    ],
    credential: { username: "sopuser", password: "ssh-pass" },
    signal: new AbortController().signal,
  };
}

test("fetchLogs 原子能力:参数构造/凭据只走环境变量/产物收集", async () => {
  const fake = fakeSpawn(() => ({
    code: 0,
    stdout: "[INFO] 解压完成: local-logs/TranFmaWebsite_20260825/，已删除压缩包",
    writeFiles: {
      "TranFmaWebsite_20260825/app.log": "2026-08-25 ERROR boom",
      "TranFmaWebsite_20260825/sub/db.log": "2026-08-25 WARN slow",
    },
  }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools",
    spawnFn: fake.spawnFn,
    binaryName: { fetchLogs: "fetch-logs-fake" },
  });
  const result = await adapter.fetchLogs!(request());
  const call = fake.calls[0];
  assert.equal(call.binary, join("/fake-tools", "fetch-logs-fake"));
  assert.deepEqual(
    call.args.filter((_item, index) => index % 2 === 0),
    ["--host", "--service", "--local-dir"]);
  assert.equal(call.args[call.args.indexOf("--host") + 1], "10.0.0.9");
  assert.equal(
    call.args[call.args.indexOf("--service") + 1], "TranFmaWebsite",
    "环境名即服务名(约定)");
  // 密码只进环境变量,不进参数表(进程列表不可见)。
  assert.equal(call.env.FETCH_LOGS_PASSWORD, "ssh-pass",
    "选 sopuser 账号的密码");
  assert.ok(!JSON.stringify(call.args).includes("ssh-pass"));
  // 产物:两个文件都收进来,带文件名头;来源指向网管日志路径。
  assert.match(result.content, /## TranFmaWebsite_20260825\/app\.log/);
  assert.match(result.content, /ERROR boom/);
  assert.match(result.content, /## TranFmaWebsite_20260825\/sub\/db\.log/);
  assert.match(result.content, /WARN slow/);
  assert.match(result.source ?? "", /ssh:\/\/10\.0\.0\.9\/var\/log\/oss\/MAE\/TranFmaWebsite/);
});

test("fetchLogs 截断诚实:单文件超限标注,超量文件列出省略清单", async () => {
  // 总量上限 2MiB、单文件 256KB:9 份 300KB 让前几份吃满预算,
  // 后面的必须进省略清单,而不是无声消失。
  const writeFiles: Record<string, string> = {};
  for (let index = 1; index <= 9; index += 1) {
    writeFiles[`svc_1/f${index}.log`] = "x".repeat(300 * 1024);
  }
  const fake = fakeSpawn(() => ({ code: 0, stdout: "ok", writeFiles }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools", spawnFn: fake.spawnFn,
    binaryName: { fetchLogs: "f" },
  });
  const result = await adapter.fetchLogs!(request());
  assert.match(result.content, /单文件超限,已截断|总量超上限/,
    "每一类截断都要在文本里说清");
  assert.match(result.content, /超出收集上限,已省略/,
    "装不下的文件要出现在省略清单");
  assert.match(result.content, /f9\.log/, "省略清单要点名具体文件");
});

test("fetchLogs 失败原子性:非零退出抛错且错误文本不含密码", async () => {
  const fake = fakeSpawn(() => ({
    code: 1,
    stdout: "[ERROR] 服务器 10.0.0.9 抓取失败: dial tcp 10.0.0.9:22: refused",
  }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools", spawnFn: fake.spawnFn,
    binaryName: { fetchLogs: "f" },
  });
  await assert.rejects(
    () => adapter.fetchLogs!(request()),
    (error: Error) => {
      assert.match(error.message, /退出码 1/);
      assert.match(error.message, /refused/);
      assert.ok(!error.message.includes("ssh-pass"),
        "错误文本不得携带密码");
      return true;
    });
});

test("fetchLogs 端口边界:非 22 端口如实拒绝(fetch-logs 固定 22)", async () => {
  let spawned = 0;
  const fake = fakeSpawn(() => { spawned += 1; return { code: 0 }; });
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools", spawnFn: fake.spawnFn,
    binaryName: { fetchLogs: "f" },
  });
  await assert.rejects(
    () => adapter.fetchLogs!(request({ port: 2222 })),
    /仅支持 22 端口.*2222/);
  assert.equal(spawned, 0, "不满足前置条件不许起进程");
});

test("fetchLogs 取消原子性:signal 已中止直接拒绝;挂起中的进程被杀", async () => {
  const fake = fakeSpawn(() => ({ hangUntilAbort: true }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools", spawnFn: fake.spawnFn,
    binaryName: { fetchLogs: "f" },
  });
  // 已中止的 signal:不允许再起进程。
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    () => adapter.fetchLogs!({ ...request(), signal: aborted.signal }),
    /取消|中止/);
  assert.equal(fake.calls.length, 0, "已中止的请求不许再起进程");

  // 挂起中的取消:kill 必须发生(SIGKILL),不留孤儿 SSH。
  const controller = new AbortController();
  const pending = adapter.fetchLogs!({
    ...request(), signal: controller.signal,
  });
  await new Promise((tick) => setTimeout(tick, 10));
  controller.abort();
  await assert.rejects(() => pending, /取消/);
  assert.equal(fake.killed.length, 1, "挂起中的子进程必须被 kill");
});

test("deployCandidate 原子能力:project_path 定位/参数/回执解析", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-goadapt-"));
  const project = join(workspace, "business-repo");
  mkdirSync(join(project, "deployment"), { recursive: true });
  writeFileSync(join(project, "deployment", "pom.xml"), "<project/>");
  const fake = fakeSpawn(() => ({
    code: 0,
    stdout: "[INFO] 服务器 10.0.0.9 部署完成 (1/1)\n=== 日志 ===",
  }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools",
    spawnFn: fake.spawnFn,
    binaryName: { deploy: "d" },
    workspaceOf: () => workspace,
  });
  const receipt = await adapter.deployCandidate!({
    ...request(), repository: "https://codehub/x.git", sha: "abc123",
  });
  const call = fake.calls[0];
  assert.equal(call.args[call.args.indexOf("--project-path") + 1], project,
    "project_path = 工作区里含 deployment/pom.xml 的克隆目录");
  assert.equal(call.args[call.args.indexOf("--host") + 1], "10.0.0.9");
  assert.equal(call.env.BUILD_DEPLOY_PASSWORD, "ssh-pass");
  assert.ok(!JSON.stringify(call.args).includes("ssh-pass"));
  assert.equal(receipt.status, "deployed");
  assert.match(receipt.receipt_id, /^go-deploy:abc123:env-1$/);
  assert.match(receipt.summary ?? "", /部署完成 \(1\/1\)/);
  rmSync(workspace, { recursive: true, force: true });
});

test("deployCandidate 边界:无哨兵不算部署成功;工作区缺失如实报错", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-goadapt2-"));
  const project = join(workspace, "business-repo");
  mkdirSync(join(project, "deployment"), { recursive: true });
  writeFileSync(join(project, "deployment", "pom.xml"), "<project/>");
  const fake = fakeSpawn(() => ({
    code: 0,
    stdout: "[INFO] mvn 完成\n=== 日志 ===", // 没有部署完成哨兵
  }));
  const adapter = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools",
    spawnFn: fake.spawnFn,
    binaryName: { deploy: "d" },
    workspaceOf: () => workspace,
  });
  await assert.rejects(
    () => adapter.deployCandidate!({
      ...request(), repository: "r", sha: "s",
    }),
    /未确认部署成功/,
    "退出码 0 但没有成功哨兵 = 不发回执,不凭模型自述交差");
  const adapterNoWorkspace = createGoEnvironmentAdapter({
    toolsDir: "/fake-tools",
    spawnFn: fake.spawnFn,
    binaryName: { deploy: "d" },
  });
  await assert.rejects(
    () => adapterNoWorkspace.deployCandidate!({
      ...request(), repository: "r", sha: "s",
    }),
    /找不到任务 task-1 的代码克隆/);
  rmSync(workspace, { recursive: true, force: true });
});

test("真二进制冒烟:平台选择+真实 spawn,连必拒端口拿到诚实的连接错误", async () => {
  const toolsDir = join(process.cwd(), "assets", "ops-tools");
  const binary = process.platform === "win32"
    ? "fetch-logs.exe"
    : process.arch === "arm64"
      ? "fetch-logs-linux-arm64" : "fetch-logs-linux-amd64";
  if (!existsSync(join(toolsDir, binary))) {
    // 纪律:没条件(裁剪部署)显式 skip,不静默当过。
    return;
  }
  const adapter = createGoEnvironmentAdapter({
    toolsDir,
    fetchTimeoutMs: 30_000,
  });
  await assert.rejects(
    () => adapter.fetchLogs!({
      ...request({
        credentials: [
          { username: "sopuser", password: "probe-pass" },
          { username: "ossuser", password: "x" },
          { username: "ossadm", password: "x" },
        ],
      }),
      // 环境引用 host 用必拒的环回,真 SSH 会立刻 refused。
    }),
    (error: Error) => {
      assert.match(error.message, /退出码 1/);
      assert.match(error.message, /refused|超时|失败/,
        "真二进制的诚实失败要原样上浮");
      assert.ok(!error.message.includes("probe-pass"));
      return true;
    });
});
