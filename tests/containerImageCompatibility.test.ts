import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dockerAvailable } from "../src/containerRuntime.ts";
import { TaskService } from "../src/taskService.ts";

const base = process.env.MFC_REAL_BUILD_IMAGE;
const available = base ? await dockerAvailable() : false;
test("真实镜像复现旧 Maven HOME 的退出73，平台修复后无 ccache 也能通过工具链自检", {
  skip: !base ? "设置 MFC_REAL_BUILD_IMAGE 后运行标准镜像适配回归" : !available ? "Docker 不可用" : false,
  timeout: 120_000,
}, async () => {
  const parent = join(homedir(), ".cache", "mae-flow-cloud-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "standard-image-"));
  const image = `mfc-compat-regression:${randomUUID()}`;
  const nativeImage = `${image}-native`;
  const name = `mfc-compat-repro-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const user = docker("image", "inspect", base!, "--format", "{{.Config.User}}").trim();
  assert.match(user, /^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/);
  writeFileSync(join(root, "Dockerfile"), [
    "ARG BASE_IMAGE", "FROM ${BASE_IMAGE}", "USER root",
    `RUN mkdir -p /home/huawei/.m2 && chown -R ${user} /home/huawei && rm -f /usr/bin/ccache /usr/local/bin/ccache`,
    `USER ${user}`, "ENV MAVEN_CONFIG=/home/huawei/.m2 NPM_CONFIG_USERCONFIG=/home/huawei/.npmrc",
  ].join("\n"));
  try {
    docker("build", "--network=none", "--pull=false", "--build-arg", `BASE_IMAGE=${base}`, "-t", image, root);
    docker("run", "-d", "--name", name, "--read-only", "--tmpfs", "/home/mae-flow:mode=1777",
      "--tmpfs", "/tmp:mode=1777", image, "sh", "-c", "true");
    assert.equal(docker("wait", name).trim(), "73", "旧配置应真实复现 entrypoint 退出");
    // Docker logs 的 stderr 单独读取，不能把空 stdout 当成没有错误。
    const { spawnSync } = await import("node:child_process");
    const log = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 10_000 });
    assert.match(log.stdout + log.stderr, /\/home\/huawei\/\.m2/);

    const settings = join(root, "settings.xml");
    writeFileSync(settings, "<settings/>\n");
    const service = new TaskService({ dataDir: join(root, "data"), provider: "fixture", model: "fixture", modelsJson: {},
      prepush: { enabled: true }, isolation: { image, cacheRoot: join(root, "cache"),
        volumes: [`${settings}:/etc/mae-flow/maven/settings.xml:ro`] },
    });
    const result = await service.systemCheck();
    const container = result.items.find((item) => item.key === "container")!;
    assert.equal(container.status, "ok", JSON.stringify(container));
    assert.match(container.detail, /ccache 未安装/);
    assert.equal(result.items.find((item) => item.key === "prepush")!.status, "ok");
    await service.shutdown();

    // 第二种现场：完全没有平台 entrypoint，passwd/HOME 保留镜像原生路径。
    writeFileSync(join(root, "Dockerfile"), [
      "ARG BASE_IMAGE", "FROM ${BASE_IMAGE}", "USER root",
      `RUN awk -F: -v user='${user.split(":")[0]}' 'BEGIN {OFS=":"} $1==user || $3==user {$6="/home/huawei"} {print}' /etc/passwd > /tmp/native-passwd && cat /tmp/native-passwd > /etc/passwd && rm /tmp/native-passwd`,
      `USER ${user}`, "ENTRYPOINT []", "ENV HOME=/home/huawei MAVEN_CONFIG=/home/huawei/.m2",
    ].join("\n"));
    docker("build", "--network=none", "--pull=false", "--build-arg", `BASE_IMAGE=${image}`, "-t", nativeImage, root);
    const nativeService = new TaskService({ dataDir: join(root, "native-data"), provider: "fixture", model: "fixture", modelsJson: {},
      prepush: { enabled: true }, isolation: { image: nativeImage, cacheRoot: join(root, "native-cache"),
        environment: { HOME: "/home/huawei" }, volumes: [`${settings}:/etc/mae-flow/maven/settings.xml:ro`] },
    });
    const native = (await nativeService.systemCheck()).items.find((item) => item.key === "container")!;
    assert.equal(native.status, "ok", JSON.stringify(native));
    await nativeService.shutdown();
  } finally {
    try { docker("rm", "-f", name); } catch { /* 已回收 */ }
    try { docker("image", "rm", nativeImage); } catch { /* 未创建 */ }
    try { docker("image", "rm", image); } catch { /* 保留失败取证，不删除基础镜像 */ }
  }
});
