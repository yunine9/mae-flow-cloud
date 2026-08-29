/**
 * 问题会话容器的用户透传回归(2026-08-29 真实环境实测事故):
 * issueFlow 的 isolation.user 在 ensureContainer 构造 TaskContainer 时
 * 被漏掉,docker run 不带 --user,容器落回镜像默认用户——node 等默认
 * root 的镜像直接命中安全自检"Config.User 为空或为 root/0,拒绝运行"。
 *
 * 两层防线:
 * 1. 无 docker 也跑:TaskContainer 的 run 参数组装必须含 --user(锁运行时);
 * 2. 有 docker 才跑(dockerAvailable 门控):问题会话端到端冒烟——
 *    默认 root 的镜像 + 显式 user,容器必须以该用户运行且会话不被拒。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, TaskContainer } from "../src/containerRuntime.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";

test("任务容器 run 参数:user 随 limits 透传为 --user", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-user-arg-"));
  const container = new TaskContainer(
    "fixture/builder:test", workspace, "mfc-fixture-user-1",
    () => undefined, [],
    { memory: "512m", cpus: "1", pidsLimit: 128, user: "10001:10001" },
    { network: "bridge" },
  );
  // dockerArgs 是组装 docker run 参数的内部方法;测试以 as any 直取,
  // 锁的是"limits.user 必须出现在 --user 之后"这条透传契约。
  const args = (container as unknown as {
    runArgs: () => string[];
  }).runArgs();
  const at = args.indexOf("--user");
  assert.ok(at >= 0, "run 参数必须包含 --user");
  assert.equal(args[at + 1], "10001:10001", "--user 取 limits.user 原值");
});

test("问题会话容器冒烟:显式 user 覆盖镜像默认 root,会话不被安全自检拒绝", async () => {
  if (!await dockerAvailable()) {
    console.log("[skip] 本机无 docker,冒烟层跳过(参数层已锁)");
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-user-"));
  mkdirSync(join(dataDir, "issues"), { recursive: true });
  createBusinessModule(dataDir, {
    id: "smoke-mod", name: "冒烟模块", description: "容器用户冒烟占位",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const model = new ScriptedModelServer([
    { text: "研究完成:冒烟用例,无需更多动作。" },
  ]);
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // node 镜像默认 root 且无 entrypoint 缓存校验:修复前此配置必被
    // "Config.User 为空或为 root/0"拒绝;修复后 --user 覆盖为 1000:1000。
    isolation: {
      image: "node:18.16.1-bullseye-slim",
      volumes: [],
      memory: "512m",
      cpus: "1",
      user: "1000:1000",
      pidsLimit: 128,
      network: "bridge",
    },
  });
  try {
    const created = service.create({
      account: "dev",
      title: "容器用户冒烟",
      description: "验证 isolation.user 透传到问题会话容器",
      source: "manual",
      // 无单登记门禁(#17):冒烟夹具带占位模块与环境过门。
      moduleId: "smoke-mod",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    // 轮询容器出现在 docker 里(TaskContainer 名字含 issue id)。
    const deadline = Date.now() + 60_000;
    let containerUser = "";
    while (Date.now() < deadline) {
      try {
        const listed = execFileSync("docker", [
          "ps", "-a", "--filter", `name=${created.id}`,
          "--format", "{{.Names}}",
        ], { encoding: "utf-8" }).trim();
        if (listed) {
          const name = listed.split("\n")[0];
          containerUser = execFileSync("docker", [
            "inspect", name, "--format", "{{.Config.User}}",
          ], { encoding: "utf-8" }).trim();
          break;
        }
      } catch {
        // docker 查询瞬态失败按未出现处理,继续轮询。
      }
      const issue = service.get(created.id);
      if (issue?.status === "failed") {
        throw new Error(`会话先于容器校验失败: ${issue.error ?? ""}`);
      }
      await new Promise((tick) => setTimeout(tick, 500));
    }
    assert.equal(containerUser, "1000:1000",
      "问题会话容器必须以 isolation.user 运行(修复前为空→拒绝)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    try {
      execFileSync("docker", [
        "ps", "-aq", "--filter", "label=com.mae-flow-cloud.managed",
        "--filter", "status=created", "--filter", "status=running",
      ], { encoding: "utf-8" }).trim().split("\n").filter(Boolean)
        .forEach((id) => execFileSync("docker", ["rm", "-f", id]));
    } catch {
      // 清理失败不影响断言结论。
    }
  }
});
