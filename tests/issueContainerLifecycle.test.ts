/**
 * 问题流容器生命周期契约(2026-09-01 拍板,对齐需求流"随任务起、
 * 随收口停"):容器随会话存活到终态——回合收口(idle)与等人
 * (waiting_user)都保持原实例,续聊/作答直接复用;真正的停点只在
 * 终态(取消/归档/挂起/转正/关停)。用 isolation.containerFactory
 * 窄注入口在无 daemon 环境钉死这套时机。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskContainer } from "../src/containerRuntime.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";

/** 无 daemon 假容器:只记生命周期事件,不碰 Docker CLI。 */
class FakeTaskContainer extends TaskContainer {
  readonly events: string[] = [];
  private stopped = false;

  constructor() {
    super("fake-image", "/tmp/fake-ws", "fake-container");
  }

  override get isAlive(): boolean {
    return !this.stopped;
  }

  override async start(): Promise<void> {
    this.events.push("start");
  }

  override async stop(): Promise<void> {
    this.events.push("stop");
    this.stopped = true;
  }

  override async exec(_command: string, _cwd: string, _options: {
    onData: (data: Buffer) => void;
  }): Promise<{ exitCode: number | null }> {
    this.events.push("exec");
    return { exitCode: 0 };
  }
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("容器随会话存活:回合收口不停、续聊复用原实例,取消才停", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-container-"));
  // 无工具的纯文本剧本:非 linear 索引按工具回执数取幕,两轮都落第 0 幕。
  const script: Scene[] = [{ text: "已收到问题,先做初步分析。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const containers: FakeTaskContainer[] = [];
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    isolation: {
      image: "fake-image",
      volumes: [],
      memory: "1g",
      cpus: "1",
      pidsLimit: 100,
      network: "none",
      containerFactory: () => {
        const container = new FakeTaskContainer();
        containers.push(container);
        return container;
      },
    },
  });
  try {
    const created = service.create({
      account: "dev", title: "容器生命周期", description: "验证随会话存活",
      ticket: "DTS-CT1",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口到 idle");

    assert.equal(containers.length, 1, "首轮恰好拉起一个容器");
    const container = containers[0];
    assert.ok(container.events.includes("start"));
    assert.ok(!container.events.includes("stop"),
      "回合收口不得停容器(对齐需求流:容器随会话存活)");
    assert.ok(container.isAlive, "回合结束后容器仍在场");

    // idle 续聊:复用同一实例,不重建(旧世界这里会停了再起)。
    service.reply(created.id, "补充:现象还能复现");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续聊收口");
    assert.equal(containers.length, 1, "续聊复用原容器,不得重建");
    assert.ok(container.isAlive);

    // 终态停点:取消必须同步停净(用户可见的"已取消"以容器消失为前提)。
    await service.control(created.id, { action: "cancel" });
    assert.ok(container.events.includes("stop"), "取消必须停容器");
    assert.ok(!container.isAlive);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
