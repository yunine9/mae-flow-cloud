/**
 * prepushContainerIntegration part 1:attempt 生命周期长轮:暂停销毁旧容器恢复重建/缓存分区/npm 源环境。
 * 共享夹具在 tests/prepushContainerIntegration.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../src/containerRuntime.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";
import {
  KERNEL_ROOT,
  git,
  sourceRepo,
  REAL_IMAGE,
  REAL_DOCKER,
  codingScenes,
  until,
} from "./prepushContainerIntegration.helpers.ts";


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



test("构建缓存按仓库哈希分区并拒绝自定义挂载覆盖", async () => {
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
  const mounts = async (repository: string, volumes: string[] = []) => {
    const cwd = workspaceFor(repository);
    return await (service as any).taskContainerMounts({
      cwd,
      summary: { id: repository, repo_url: repository },
    }, volumes) as { volumes: string[]; environment: NodeJS.ProcessEnv };
  };
  const first = await mounts("https://code.example/team/a.git");
  const repeated = await mounts("https://code.example/team/a.git");
  const second = await mounts("https://code.example/team/b.git");
  assert.deepEqual(first.volumes, repeated.volumes,
    "同仓任务应复用自己的构建缓存");
  // volumes 里还有仓无关的共享资产卷(mae-build 等),缓存卷按来源目录认。
  const cacheSource = (m: { volumes: string[] }) =>
    m.volumes.map((volume) => volume.split(":")[0])
      .find((source) => source.startsWith(cacheRoot));
  assert.ok(cacheSource(first), "同仓任务应挂自己的可写缓存卷");
  assert.notEqual(cacheSource(first), cacheSource(second),
    "不同仓不得共享可写缓存");
  assert.ok(first.volumes.every((volume) => existsSync(volume.split(":")[0])));
  assert.equal(first.environment.npm_config_cache, "/cache/npm");
  // 容器内 Node 信任系统 CA 存储(2026-09-04):部署镜像默认 node
  // v24.19.0,npm install 打内网镜像没有这条就是全量证书失败重试到
  // 超时。两条流共用 buildCacheMounts 合并点,一处注入两侧生效。
  assert.equal(first.environment.NODE_USE_SYSTEM_CA, "1");
  assert.equal(first.environment.CCACHE_DIR, "/cache/ccache");
  assert.match(String(first.environment.MAVEN_OPTS),
    /maven\.repo\.local=\/cache\/maven\/repository/);
  // 安装情况只有容器登录 shell 知道，宿主不能强塞一个可能不存在的 launcher。
  assert.equal(first.environment.CMAKE_C_COMPILER_LAUNCHER, undefined);
  assert.equal(first.environment.CMAKE_CXX_COMPILER_LAUNCHER, undefined);
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
  await assert.rejects(mounts("https://code.example/team/a.git", [
    "/host/shared:/cache/npm",
  ]), /不能覆盖平台的分仓缓存目录/);
  await assert.rejects(mounts("https://code.example/team/a.git", [
    `/host/shared:${join(workspaceRoot, "RepoA", "cpp_sdk_repository")}`,
  ]), /不能覆盖平台的分仓缓存目录/);
});



test("容器 npm 源(#75):isolation.environment 进需求侧创建环境,缺省绝不出现", async () => {
  // 内网容器里只有 npm_config_cache,没有源地址时 npm 打公网直到超时。
  // serve 的 --isolate-npm-registry 落到 isolation.environment;需求侧
  // 的合并点在 containerMountsForRepository(与 npm_config_cache 同一
  // 出口)。问题流侧同款合并在 issueContainerLifecycle 钉死。
  const registry = "https://npm.intra.example/repository/npm-group/";
  const scratch: string[] = [];
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  };
  const mounts = async (service: TaskService) =>
    await (service as any).taskContainerMounts({
      cwd: tempDir("mfc-npm-registry-ws-"),
      summary: { id: "t", repo_url: "https://code.example/team/a.git" },
    }, []) as { environment: NodeJS.ProcessEnv };

  const configured = new TaskService({
    dataDir: tempDir("mfc-npm-registry-with-"),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    isolation: {
      image: "fixture/build-toolchain:test",
      cacheRoot: tempDir("mfc-npm-registry-cache-"),
      environment: { npm_config_registry: registry },
    },
  });
  const env = (await mounts(configured)).environment;
  assert.equal(env.npm_config_registry, registry,
    "registry 必须进容器创建环境,内网 npm 才不打公网");
  assert.equal(env.npm_config_cache, "/cache/npm",
    "registry 与缓存变量共存,合并顺序没被破坏");

  const bare = new TaskService({
    dataDir: tempDir("mfc-npm-registry-without-"),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    isolation: {
      image: "fixture/build-toolchain:test",
      cacheRoot: tempDir("mfc-npm-registry-cache2-"),
    },
  });
  assert.ok(!("npm_config_registry" in (await mounts(bare)).environment),
    "缺省不注入:没配 registry 时容器创建环境不得出现该键");
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

