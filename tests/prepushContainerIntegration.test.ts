import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../src/containerRuntime.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到 mae-flow 内核");
  return found;
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function sourceRepo(parent = tmpdir()): string {
  const cwd = mkdtempSync(join(parent, "mfc-prepush-container-src-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "README.md"), "# prepush container fixture\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  return cwd;
}

const REAL_IMAGE = process.env.MFC_REAL_BUILD_IMAGE;
const REAL_DOCKER = REAL_IMAGE ? await dockerAvailable() : false;

function codingScenes(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
      "echo first > feature.txt" } } },
    { text: "编码提交完成。" },
  ];
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 25));
  }
}

test("构建缓存按仓库哈希分区并拒绝自定义挂载覆盖", () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "mfc-build-cache-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "mfc-build-workspace-"));
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-build-cache-data-")),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    isolation: { image: "fixture/build-toolchain:test", cacheRoot },
  });
  const workspaceFor = (repository: string) => {
    const name = repository.endsWith("a.git") ? "RepoA" : "RepoB";
    const cwd = join(workspaceRoot, name, name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  };
  const mounts = (repository: string, volumes: string[] = []) => {
    const cwd = workspaceFor(repository);
    return (service as any).taskContainerMounts({
      cwd,
      summary: { id: repository, repo_url: repository },
    }, volumes) as { volumes: string[]; environment: NodeJS.ProcessEnv };
  };
  const first = mounts("https://code.example/team/a.git");
  const repeated = mounts("https://code.example/team/a.git");
  const second = mounts("https://code.example/team/b.git");
  assert.deepEqual(first.volumes, repeated.volumes,
    "同仓任务应复用自己的构建缓存");
  assert.notEqual(first.volumes[0].split(":")[0],
    second.volumes[0].split(":")[0], "不同仓不得共享可写缓存");
  assert.ok(first.volumes.every((volume) => existsSync(volume.split(":")[0])));
  assert.equal(first.environment.npm_config_cache, "/cache/npm");
  assert.equal(first.environment.CCACHE_DIR, "/cache/ccache");
  assert.match(String(first.environment.MAVEN_OPTS),
    /maven\.repo\.local=\/cache\/maven\/repository/);
  // ccache 必须真接线(内网实锤:只给 CCACHE_DIR 时缓存 0 文件,
  // 编译器从没被包过):CMake launcher 注入 + 跨任务路径相对化。
  assert.equal(first.environment.CMAKE_C_COMPILER_LAUNCHER, "ccache");
  assert.equal(first.environment.CMAKE_CXX_COMPILER_LAUNCHER, "ccache");
  assert.equal(first.environment.CCACHE_NOHASHDIR, "1");
  assert.equal(first.environment.CCACHE_BASEDIR,
    join(workspaceRoot, "RepoA"),
    "BASEDIR 取任务目录:克隆与 cpp_sdk_repository 都在其下,相对布局跨任务恒定");
  const cppSdk = first.volumes.find((volume) =>
    volume.split(":")[1]?.endsWith("/cpp_sdk_repository"));
  assert.ok(cppSdk, "C++ SDK 缓存必须作为代码仓同级目录挂载");
  assert.ok(existsSync(cppSdk.split(":")[0]));
  assert.equal(cppSdk.split(":")[1],
    join(workspaceRoot, "RepoA", "cpp_sdk_repository"));
  assert.throws(() => mounts("https://code.example/team/a.git", [
    "/host/shared:/cache/npm",
  ]), /不能覆盖平台的分仓缓存目录/);
  assert.throws(() => mounts("https://code.example/team/a.git", [
    `/host/shared:${join(workspaceRoot, "RepoA", "cpp_sdk_repository")}`,
  ]), /不能覆盖平台的分仓缓存目录/);
});

test("宿主身份 MAE_FLOW_HOST 跟进任务容器，云端 --auto 确认路径不失效", () => {
  // run8b 实测:漏传时容器里的内核 current 按本地宿主渲染,领域归档在
  // 云端又弹人工卡。宿主进程声明的身份必须原样进入容器环境。
  const cacheRoot = mkdtempSync(join(tmpdir(), "mfc-hostenv-cache-"));
  const cwd = mkdtempSync(join(tmpdir(), "mfc-hostenv-ws-"));
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-hostenv-data-")),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    isolation: { image: "fixture/build-toolchain:test", cacheRoot },
  });
  const previous = process.env.MAE_FLOW_HOST;
  try {
    process.env.MAE_FLOW_HOST = "cloud";
    const withHost = (service as any).taskContainerMounts({
      cwd, summary: { id: "t", repo_url: "https://code.example/team/a.git" },
    }, []) as { environment: NodeJS.ProcessEnv };
    assert.equal(withHost.environment.MAE_FLOW_HOST, "cloud");
    delete process.env.MAE_FLOW_HOST;
    const withoutHost = (service as any).taskContainerMounts({
      cwd, summary: { id: "t", repo_url: "https://code.example/team/a.git" },
    }, []) as { environment: NodeJS.ProcessEnv };
    assert.equal(withoutHost.environment.MAE_FLOW_HOST, undefined,
      "宿主没声明身份时不得伪造 cloud 环境");
  } finally {
    if (previous === undefined) delete process.env.MAE_FLOW_HOST;
    else process.env.MAE_FLOW_HOST = previous;
  }
});

test("取消 native prepush 会销毁 attempt 容器且绝不继续 host push", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(),
    mkdtempSync(join(tmpdir(), "mfc-prepush-container-platform-")));
  await platform.start();
  const hold = "echo __MFC_HOLD__";
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-container-data-"));
  const model = new ScriptedModelServer([
    ...codingScenes(),
    { tool: { name: "bash", input: { command: hold } } },
    { text: "不应在取消后走到这里。" },
  ], "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
    }),
  });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 2_000,
    },
    prepush: { enabled: true },
    isolation: {
      image: "fixture/build-toolchain:test",
      containerFactory: containers.factory,
    },
  });
  try {
    const id = service.create("REQ_CONTAINER：验证取消构建容器", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => containers.records.some((record) =>
      record.name.endsWith("-prepush") && record.commands.includes(hold)),
    "prepush 命令进入独立容器");

    const canceled = await service.cancel(id, "tester");
    assert.equal(canceled.status, "canceled");
    const attempt = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.ok(attempt?.stopped, "取消必须销毁整个 prepush attempt 容器");
    await new Promise((tick) => setTimeout(tick, 100));
    assert.equal(git(platform.barePath, "branch", "--list",
      "master_bot_REQ_CONTAINER"), "", "取消后的迟到回调不得 push");
    assert.equal(platform.mergeRequests.length, 0);
    assert.equal(platform.pipelines.length, 0);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("native prepush 未配置隔离镜像时按基础设施失败收口，不回退宿主 Bash", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(),
    mkdtempSync(join(tmpdir(), "mfc-prepush-no-isolation-platform-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-no-isolation-data-"));
  const model = new ScriptedModelServer(codingScenes(),
    "scripted-v1", {
      linear: true,
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
      }),
    });
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 500,
    },
    prepush: { enabled: true },
  });
  try {
    const id = service.create("REQ_CONTAINER：缺容器必须拒绝宿主构建", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => service.get(id)?.delivery?.prepush?.state
      === "environment_error", "容器缺失按基础设施故障落盘");
    const summary = service.get(id)!;
    assert.match(String(summary.detail ?? ""), /容器|隔离镜像|宿主机/);
    assert.equal(model.requests.length, codingScenes().length,
      "缺容器时不得启动会默认执行宿主 Bash 的 prepush 会话");
    assert.equal(git(platform.barePath, "branch", "--list",
      "master_bot_REQ_CONTAINER"), "");
    assert.equal(platform.mergeRequests.length, 0);
    assert.equal(platform.pipelines.length, 0);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("native prepush 环境预检失败时不启动模型、不盲探网络也不 push", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(),
    mkdtempSync(join(tmpdir(), "mfc-prepush-preflight-platform-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-preflight-data-"));
  const model = new ScriptedModelServer(codingScenes(),
    "scripted-v1", {
      linear: true,
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
      }),
    });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  containers.preflightFailure = "Maven 实际使用的不是 JDK 21";
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 500,
    },
    prepush: { enabled: true },
    isolation: {
      image: "fixture/build-toolchain:test",
      cacheRoot: mkdtempSync(join(tmpdir(), "mfc-prepush-preflight-cache-")),
      containerFactory: containers.factory,
    },
  });
  try {
    const id = service.create("REQ_CONTAINER：环境坏时立即停止", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => service.get(id)?.delivery?.prepush?.state
      === "environment_error", "预检失败按基础设施故障落盘");
    const summary = service.get(id)!;
    assert.match(String(summary.detail ?? ""), /Maven 实际使用的不是 JDK 21/);
    assert.equal(model.requests.length, codingScenes().length,
      "预检失败后不能再消耗一次 prepush 模型会话");
    const attempt = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.ok(attempt?.stopped, "失败后必须销毁短命构建容器");
    assert.equal(attempt?.commands.some((command) => /curl|wget/.test(command)),
      false, "确定性预检不应做网络盲探");
    assert.equal(git(platform.barePath, "branch", "--list",
      "master_bot_REQ_CONTAINER"), "");
    assert.equal(platform.mergeRequests.length, 0);
    assert.equal(platform.pipelines.length, 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("native prepush 自动放宽慢构建预算并在首次超时时收口", async () => {
  const source = sourceRepo();
  writeFileSync(join(source, "pom.xml"), [
    "<project>",
    "  <properties><DT_run>true</DT_run></properties>",
    "</project>",
    "",
  ].join("\n"));
  writeFileSync(join(source, "CMakeLists.txt"), "project(native_fixture)\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "add native build");

  const platform = new FakeGitPlatform();
  platform.initBare(source,
    mkdtempSync(join(tmpdir(), "mfc-prepush-timeout-platform-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-timeout-data-"));
  const compile = "mvn compile -DDT_test=UT -DDT_run=true";
  const retryScenes = Array.from({ length: 20 }, (_, index): Scene => ({
    tool: { name: "bash", input: { command: `echo timeout-retry-${index}` } },
  }));
  const model = new ScriptedModelServer([
    ...codingScenes(),
    { tool: { name: "bash", input: { command: compile, timeout: 600 } } },
    ...retryScenes,
    { text: "不应在构建超时后继续到这里。" },
  ], "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
    }),
  });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  containers.executionTimeoutSeconds = 600;
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 500,
    },
    prepush: { enabled: true },
    isolation: {
      image: "fixture/build-toolchain:test",
      containerFactory: containers.factory,
    },
  });
  try {
    const id = service.create("REQ_CONTAINER：慢 native 构建使用平台预算", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => service.get(id)?.delivery?.prepush?.state
      === "environment_error", "慢构建超时按首次结构化异常收口");
    assert.match(String(service.get(id)?.detail ?? ""), /45 分钟/);
    assert.match(String(service.get(id)?.detail ?? ""),
      /验证预算耗尽，不代表代码编译失败/);
    assert.equal(model.requests.length, codingScenes().length + 1,
      "首次构建超时后不得等下一条 Bash 才熔断");
    const attempt = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.ok(attempt, "应创建独立 prepush 容器");
    const compileIndex = attempt.commands.indexOf(compile);
    assert.notEqual(compileIndex, -1, "应执行 Maven 构建命令");
    assert.equal(attempt.commandTimeouts[compileIndex], 45 * 60,
      "C++ 仓里 Agent 的 600 秒必须提升为平台的 45 分钟构建预算");
    assert.equal(attempt.stopped, true);
    assert.equal(platform.mergeRequests.length, 0);
    assert.equal(platform.pipelines.length, 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("native prepush 容器基础设施错误立即熔断，不让模型循环重试", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(),
    mkdtempSync(join(tmpdir(), "mfc-prepush-circuit-platform-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-circuit-data-"));
  const retryScenes = Array.from({ length: 20 }, (_, index): Scene => ({
    tool: { name: "bash", input: { command: `echo retry-${index}` } },
  }));
  const model = new ScriptedModelServer([
    ...codingScenes(),
    ...retryScenes,
    { text: "不应在基础设施故障后继续到这里。" },
  ], "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
    }),
  });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  containers.executionUnavailable = "inspect_unavailable";
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 500,
    },
    prepush: { enabled: true, attemptTimeoutMs: 5_000 },
    isolation: {
      image: "fixture/build-toolchain:test",
      containerFactory: containers.factory,
    },
  });
  try {
    const id = service.create("REQ_CONTAINER：容器故障必须熔断", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => service.get(id)?.delivery?.prepush?.state
      === "environment_error", "容器故障按基础设施失败收口");
    assert.match(String(service.get(id)?.detail ?? ""),
      /inspect_unavailable|容器不可用/);
    assert.equal(model.requests.length, codingScenes().length + 1,
      "第一次结构化容器错误后不得再发模型请求");
    const attempt = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.equal(attempt?.stopped, true);
    assert.equal(platform.mergeRequests.length, 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("暂停 native prepush 后销毁旧容器，恢复会新建 attempt 并重跑", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(),
    mkdtempSync(join(tmpdir(), "mfc-prepush-resume-platform-")));
  await platform.start();
  const hold = "echo __MFC_HOLD__";
  const compile = `node -e "console.log('compile ok')"`;
  const unitTest = `node -e "console.log('unit test ok')"`;
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-resume-data-"));
  const model = new ScriptedModelServer([
    ...codingScenes(),
    { tool: { name: "bash", input: { command: hold } } },
  ], "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
    }),
  });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 5_000,
    },
    prepush: { enabled: true, buildSlots: 1 },
    isolation: {
      image: "fixture/build-toolchain:test",
      containerFactory: containers.factory,
    },
  });
  try {
    const id = service.create("REQ_CONTAINER：暂停恢复推送前验证", {
      ticket: "REQ_CONTAINER",
    }).id;
    await until(() => containers.records.some((record) =>
      record.name.endsWith("-prepush") && record.commands.includes(hold)),
    "首个 prepush attempt 开始构建");
    const pauseRequested = await service.pause(id, "tester");
    assert.ok(["pausing", "paused"].includes(pauseRequested.status),
      "控制请求先确认已进入暂停流程，不等待容器清理完成");
    await until(() => service.get(id)?.status === "paused",
      "推送前构建后台安全暂停");
    const first = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.ok(first?.stopped, "暂停必须终止在途构建容器");

    // 先从假模型的下一个全局下标接上恢复剧本；随后立即点恢复，专门
    // 覆盖“旧 prepush 防重 Promise 还在 finally”这一竞态。
    const nextScene = model.requests.length;
    model.script.splice(nextScene, model.script.length - nextScene,
      { tool: { name: "bash", input: { command: compile } } },
      { tool: { name: "bash", input: { command: unitTest } } },
      { text: [
        "恢复后的构建已通过。",
        "<prepush-result>",
        JSON.stringify({
          status: "passed",
          compile: { command: compile, status: "passed" },
          unit_test: { command: unitTest, status: "passed" },
          summary: "resumed prepush passed",
        }),
        "</prepush-result>",
      ].join("\n") });

    const resumed = service.resume(id, "tester");
    assert.ok(["verifying", "running"].includes(resumed.status),
      "恢复后应直接进入 prepush 验证，而不是停回普通编码队列");
    await until(() => service.get(id)?.status === "await_merge",
      "恢复后新 attempt 完成验证和交付");
    const attempts = containers.records.filter((record) =>
      record.name.endsWith("-prepush"));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].name, attempts[1].name,
      "prepush 名字必须按任务稳定，让恢复时能清掉上一 attempt 残留");
    assert.ok(attempts[1].commands.includes(compile));
    assert.ok(attempts[1].commands.includes(unitTest));
    assert.equal(attempts[1].stopped, true);
    assert.equal(service.get(id)?.delivery?.prepush?.state, "passed");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("真实 Docker：普通任务与 native prepush 均在统一镜像执行并签容器事实",
  { skip: !REAL_IMAGE
      ? "设置 MFC_REAL_BUILD_IMAGE 后执行真实 prepush 容器闭环"
      : REAL_DOCKER ? false : "Docker daemon 不可用" }, async () => {
    const scratch = join(homedir(), ".cache", "mae-flow-cloud-tests");
    mkdirSync(scratch, { recursive: true });
    const source = sourceRepo(scratch);
    const platform = new FakeGitPlatform();
    platform.initBare(source,
      mkdtempSync(join(scratch, "mfc-real-prepush-platform-")));
    await platform.start();
    const compile = [
      'scratch="$TMPDIR/mfc-prepush-real"',
      'mkdir -p "$scratch"',
      'printf \'class Check { public static void main(String[] a){} }\\n\' > "$scratch/Check.java"',
      'javac -d "$scratch" "$scratch/Check.java"',
      'java -cp "$scratch" Check',
    ].join(" && ");
    const unitTest = "node -e \"if (1 + 1 !== 2) process.exit(1); console.log('ut ok')\"";
    const dataDir = mkdtempSync(join(scratch, "mfc-real-prepush-data-"));
    const model = new ScriptedModelServer([
      ...codingScenes(),
      { tool: { name: "bash", input: { command: compile } } },
      { tool: { name: "bash", input: { command: unitTest } } },
      { text: [
        "真实容器编译与 UT 已通过。",
        "<prepush-result>",
        JSON.stringify({
          status: "passed",
          compile: { command: compile, status: "passed" },
          unit_test: { command: unitTest, status: "passed" },
          summary: "real container prepush passed",
        }),
        "</prepush-result>",
      ].join("\n") },
    ], "scripted-v1", {
      linear: true,
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_CONTAINER", ticket: "REQ_CONTAINER",
      }),
    });
    await model.start();
    const service = new TaskService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
      host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
        python: "python3" },
      delivery: { platformUrl: platform.baseUrl,
        pollIntervalMs: 100, pollTimeoutMs: 10_000 },
      prepush: { enabled: true, buildSlots: 1 },
      isolation: {
        image: REAL_IMAGE!,
        cacheRoot: join(dataDir, "cache"),
        memory: "8g",
        cpus: "2",
        pidsLimit: 512,
      },
    });
    try {
      const id = service.create("REQ_CONTAINER：真实统一容器交付", {
        ticket: "REQ_CONTAINER",
      }).id;
      await until(() => service.get(id)?.status === "await_merge",
        "真实容器 prepush 完成交付", 90_000);
      const receipt = service.get(id)?.delivery?.prepush?.receipt;
      assert.equal(receipt?.sha, service.get(id)?.delivery?.sha);
      assert.ok(receipt?.execution, "原生容器 runner 必须签入执行事实");
      assert.equal(receipt?.execution?.read_only_root, true);
      assert.equal(receipt?.execution?.pids_limit, 512);
      assert.match(receipt?.execution?.image_id ?? "", /^sha256:/);
      assert.ok(receipt?.execution?.mount_destinations.includes("/cache/maven"));
      const leftover = execFileSync("docker", [
        "ps", "-aq", "--filter", `id=${receipt!.execution!.container_id}`,
      ], { encoding: "utf-8" }).trim();
      assert.equal(leftover, "", "签收后 prepush attempt 容器必须已删除");
    } finally {
      await model.stop();
      await platform.stop();
    }
  });
