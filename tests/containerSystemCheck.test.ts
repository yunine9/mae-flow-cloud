import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../src/containerRuntime.ts";
import {
  TaskService,
  type TaskContainerFactoryInput,
} from "../src/taskService.ts";

test("部署自检真实走统一容器并验证三类工具链，结束后销毁", async () => {
  const calls: string[] = [];
  let input: TaskContainerFactoryInput | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-container-check-"));
  const kernelRoot = join(dataDir, "kernel");
  mkdirSync(join(kernelRoot, "scripts"), { recursive: true });
  writeFileSync(join(kernelRoot, "scripts", "mae-flow.py"), "# fixture\n");
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    host: { kernelRoot, repoPath: join(dataDir, "repo"), python: "python3" },
    prepush: { enabled: true, buildSlots: 2 },
    isolation: {
      image: "internal/mae-flow-builder@sha256:fixture",
      cacheRoot: join(dataDir, "cache"),
      memory: "3g",
      cpus: "2",
      pidsLimit: 512,
      containerFactory: (created) => {
        input = created;
        return {
          start: async () => { calls.push("start"); },
          exec: async (command, _cwd, options) => {
            calls.push("exec");
            assert.match(command, /javac/);
            assert.match(command, /c\+\+/);
            assert.match(command, /node --version/);
            assert.match(command, /\/etc\/profile\.d\/\*\.sh/);
            assert.match(command, /ca-bundle\.crt/);
            assert.match(command, /codehub-cli spes/);
            assert.match(command, /MFC_KERNEL_ROOT/);
            assert.match(command, /scratch="\$PWD\/\.mfc-self-check-\$\$"/,
              "编译探针必须落在 bind-mounted workspace，不得只测 /tmp");
            for (const cache of ["maven", "npm", "ccache", "xdg"]) {
              assert.match(command, new RegExp(`/cache/${cache}`));
            }
            assert.match(command, /cpp_sdk_repository/);
            assert.match(command, /build\/\.\.\/\.\./,
              "自检必须验证仓库父子包络，而不只检查编译器在 PATH");
            options.onData(Buffer.from("__MFC_CONTAINER_TOOLCHAIN_OK__\n"));
            return { exitCode: 0 };
          },
          stop: async () => { calls.push("stop"); },
        };
      },
    },
  });

  const checked = await service.systemCheck();
  const container = checked.items.find((item) => item.key === "container");
  const prepush = checked.items.find((item) => item.key === "prepush");
  assert.equal(container?.status, "ok");
  assert.match(container?.detail ?? "", /真实启动/);
  assert.equal(prepush?.status, "ok");
  assert.match(prepush?.detail ?? "", /构建槽位 2/);
  assert.deepEqual(calls, ["start", "exec", "stop"]);
  assert.ok(input?.volumes.some((volume) =>
    volume.endsWith(":/cache/maven")), "自检也必须验证真实缓存挂载");
  assert.ok(input?.volumes.some((volume) =>
    volume.split(":")[1]?.endsWith("/cpp_sdk_repository")),
  "自检也必须同形挂载 C++ SDK 同级缓存");
  assert.equal(input?.workspace.endsWith("/system-check-container/MfcProbeRepository"),
    true, "自检工作区必须保留父目录/仓名层级");
  assert.ok(input?.volumes.includes(`${kernelRoot}:${kernelRoot}:ro`),
    "自检必须同形挂载并验证 Mae-Flow 内核根");
  assert.equal(input?.options.environment?.MFC_KERNEL_ROOT, kernelRoot);
  assert.equal(input?.limits.memory, "3g");
  assert.equal(input?.limits.pidsLimit, 512);
  assert.equal(input?.options.labels?.["com.mae-flow-cloud.role"], "system-check");
  assert.match(input?.options.labels?.["com.mae-flow-cloud.instance"] ?? "",
    /^[a-f0-9]{64}$/);
});

test("部署自检失败返回 phase/name/id/image 与输出末段，便于直接定位", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-container-check-fail-"));
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    prepush: { enabled: true },
    isolation: {
      image: "internal/builder:broken",
      cacheRoot: join(dataDir, "cache"),
      containerFactory: () => ({
        start: async () => undefined,
        exec: async (_command, _cwd, options) => {
          options.onData(Buffer.from("javac: compiler exploded at Probe.java:7\n"));
          return { exitCode: 2 };
        },
        stop: async () => undefined,
      }),
    },
  });
  const checked = await service.systemCheck();
  const item = checked.items.find((entry) => entry.key === "container");
  assert.equal(item?.status, "error");
  assert.match(item?.suggestion ?? "", /phase=toolchain-exec/);
  assert.match(item?.suggestion ?? "", /role=system-check name=mfc-/);
  assert.match(item?.suggestion ?? "", /id=unknown image=internal\/builder:broken/);
  assert.match(item?.suggestion ?? "", /Probe\.java:7/);
});

const REAL_IMAGE = process.env.MFC_REAL_BUILD_IMAGE;
const REAL_DOCKER = REAL_IMAGE ? await dockerAvailable() : false;

test("真实 Docker 部署自检：统一镜像内编译 Java/C++ 并检查 JS 工具链",
  { skip: !REAL_IMAGE
      ? "设置 MFC_REAL_BUILD_IMAGE 后执行真实统一镜像自检"
      : REAL_DOCKER ? false : "Docker daemon 不可用" }, async () => {
    const scratch = join(homedir(), ".cache", "mae-flow-cloud-tests");
    mkdirSync(scratch, { recursive: true });
    const dataDir = mkdtempSync(join(scratch, "mfc-real-container-check-"));
    const service = new TaskService({
      dataDir,
      provider: "fixture",
      model: "fixture",
      modelsJson: {},
      prepush: { enabled: true },
      isolation: {
        image: REAL_IMAGE!,
        cacheRoot: join(dataDir, "cache"),
        memory: "3g",
        cpus: "2",
        pidsLimit: 512,
      },
    });
    const checked = await service.systemCheck();
    const container = checked.items.find((item) => item.key === "container");
    assert.equal(container?.status, "ok", JSON.stringify(container));
    assert.match(container?.detail ?? "", /JDK 21\/Maven/);
    assert.match(container?.detail ?? "", /C\/C\+\+/);
    assert.equal(checked.items.find((item) => item.key === "prepush")?.status, "ok");
    const leftovers = execFileSync("docker", [
      "ps", "-aq", "--filter", "label=com.mae-flow-cloud.role=system-check",
    ], { encoding: "utf-8" }).trim();
    assert.equal(leftovers, "", "部署自检结束后不应遗留容器");
  });
