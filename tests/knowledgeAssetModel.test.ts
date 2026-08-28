import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import {
  knowledgeMatchesTask,
  normalizeKnowledgeAssetMetadata,
  readSkillKnowledgeMetadata,
  writeSkillKnowledgeMetadata,
} from "../src/knowledgeAssetModel.ts";
import {
  resolveRepositoryProfiles,
  saveRepositoryProfile,
} from "../src/repositoryProfiles.ts";
import {
  createKnowledgeCandidate,
  decideKnowledgeCandidate,
} from "../src/knowledgeCandidates.ts";
import {
  materializeEngineeringKnowledge,
  snapshotEngineeringKnowledge,
} from "../src/engineeringKnowledgeRuntime.ts";

const SKILL = `---
name: order-troubleshooting
description: 定位订单服务故障
languages: [Java]
---

# 排障方法
`;

test("统一模型：Skill 是形态；工程知识可带模块上下文，业务实现混写必须拆分", () => {
  const engineering = normalizeKnowledgeAssetMetadata({
    nature: "engineering", form: "skill",
    business_module_ids: ["orders"],
    repositories: ["https://code.example/orders.git"],
    technologies: ["Java"],
  });
  assert.equal(engineering.nature, "engineering");
  assert.equal(engineering.form, "skill");
  assert.deepEqual(engineering.business_module_ids, ["orders"]);
  assert.ok(knowledgeMatchesTask(engineering, {
    repositories: ["https://code.example/orders.git"],
    technologies: ["java"], businessModuleIds: ["orders"],
  }));
  assert.equal(knowledgeMatchesTask(engineering, {
    repositories: ["https://code.example/orders.git"],
    technologies: ["java"], businessModuleIds: ["payments"],
  }), false, "模块上下文限定推荐范围，但不改变工程性质");
  assert.throws(() => normalizeKnowledgeAssetMetadata({
    nature: "business", form: "document",
    business_module_ids: ["orders"], repositories: [], technologies: ["java"],
  }), /业务知识不能标工程技术栈/);

  const legacy = readSkillKnowledgeMetadata(SKILL);
  assert.equal(legacy.nature, "engineering");
  assert.deepEqual(legacy.technologies, ["java"]);
  const migrated = writeSkillKnowledgeMetadata(SKILL, engineering);
  assert.match(migrated, /knowledge_nature: engineering/);
  assert.match(migrated, /technologies: \[java\]/);
  assert.doesNotMatch(migrated, /^languages:/m);
});

test("仓库技术画像首次人工确认并复用；明确暂不确定与系统漏采可区分", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-repository-profile-"));
  const repository = "https://code.example/team/mixed.git";
  assert.equal(resolveRepositoryProfiles(dataDir, [repository])[0].profile,
    undefined);
  const saved = saveRepositoryProfile(dataDir, {
    repository, technologies: ["C++", "js"], confirmed: true,
  }, "developer-a");
  assert.deepEqual(saved.technologies, ["cpp", "javascript"]);
  const resolved = resolveRepositoryProfiles(dataDir,
    ["https://code.example/team/mixed"])[0].profile!;
  assert.equal(resolved.confirmed, true);
  assert.deepEqual(resolved.technologies, ["cpp", "javascript"]);

  const unknown = saveRepositoryProfile(dataDir, {
    repository, technologies: [], confirmed: true,
  }, "developer-a");
  assert.equal(unknown.confirmed, true);
  assert.deepEqual(unknown.technologies, []);
});

test("工程知识候选发布后按任务画像快照；不匹配时不误推荐", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-engineering-knowledge-"));
  const dataDir = join(root, "data");
  const taskWorkspace = join(dataDir, "task-1");
  const runtimeWorkspace = join(taskWorkspace, "repo");
  mkdirSync(taskWorkspace, { recursive: true });
  mkdirSync(runtimeWorkspace, { recursive: true });
  const candidate = createKnowledgeCandidate(dataDir, {
    source_task_id: "task-source",
    title: "Java 慢编译定位",
    summary: "区分依赖下载、全量编译和卡死",
    when_to_use: "Java 仓编译超时或首次拉取依赖时",
    nature: "engineering", form: "document",
    business_module_ids: [],
    repositories: ["https://code.example/team/service.git"],
    technologies: ["java"],
    content: "# 慢编译定位\n\n先输出阶段耗时，不要把超时当基础设施故障。\n",
  }, "developer-a");
  decideKnowledgeCandidate(dataDir, candidate.id, "published", "admin-a", {
    published_target: `engineering-knowledge/${candidate.id}`,
  });

  const mismatch = snapshotEngineeringKnowledge({
    dataDir, taskWorkspace,
    repositories: ["https://code.example/team/service.git"],
    technologies: ["cpp"], businessModuleIds: [],
  });
  assert.equal(mismatch.length, 0);
  const selected = snapshotEngineeringKnowledge({
    dataDir, taskWorkspace,
    repositories: ["https://code.example/team/service.git"],
    technologies: ["java"], businessModuleIds: [],
  });
  assert.equal(selected.length, 1);
  const materialized = materializeEngineeringKnowledge({
    selected, taskWorkspace, runtimeWorkspace,
  });
  assert.deepEqual(materialized.warnings, []);
  assert.match(readFileSync(materialized.entries[0].path, "utf-8"),
    /不要把超时当基础设施故障/);
});

test("知识飞轮 HTTP 闭环：任务沉淀待审、管理员发布、后续任务固定版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-flywheel-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("dev", "developer-pass-1", "developer");
  const service = new TaskService({
    dataDir: join(root, "data"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const source = service.create("沉淀一次可复用的慢编译排障方法", {
    title: "知识沉淀来源任务", account: "dev",
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    const dev = await login("dev", "developer-pass-1");
    const boss = await login("boss", "administrator-pass");
    const submitted = await fetch(
      `${base}/tasks/${source.id}/knowledge-candidates`, {
        method: "POST", headers: { cookie: dev },
        body: JSON.stringify({
          title: "慢编译排障", summary: "区分慢编译和基础设施故障",
          when_to_use: "构建时间超过常规预算时",
          nature: "engineering", form: "document",
          business_module_ids: [], repositories: [], technologies: [],
          content: "# 慢编译排障\n\n先报告当前阶段和持续时间，再申请延长预算。\n",
        }),
      });
    assert.equal(submitted.status, 201);
    const candidate = await submitted.json() as { id: string; status: string };
    assert.equal(candidate.status, "pending", "任务沉淀不能绕过审核直接生效");

    const published = await fetch(
      `${base}/knowledge-candidates/${candidate.id}/publish`, {
        method: "POST", headers: { cookie: boss }, body: JSON.stringify({}),
      });
    assert.equal(published.status, 200);
    assert.equal((await published.json() as { status: string }).status, "published");

    const next = service.create("处理另一个慢编译任务", {
      title: "后续任务", account: "dev",
      selectedEngineeringKnowledgeIds: [candidate.id],
    });
    assert.deepEqual(next.engineering_knowledge?.map((item) => item.id),
      [candidate.id], "发布资产应在后续任务创建时固定快照");
  } finally {
    server.close();
  }
});
