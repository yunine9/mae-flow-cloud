import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";
import {
  createKnowledgeCandidate,
  decideKnowledgeCandidate,
} from "../src/knowledgeCandidates.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";
import { WorkflowAssetLibrary } from "../src/workflowAssetLibrary.ts";

function service(dataDir: string): TaskService {
  return new TaskService({
    dataDir, provider: "test", model: "test-1", maxConcurrent: 0,
    modelsJson: { providers: { test: { models: [{ id: "test-1" }] } } },
    host: { kernelRoot: "/tmp", repoPath: "/tmp/fixed-demo-repo" },
    delivery: { platformUrl: "http://127.0.0.1:1" },
  });
}

function profile(technologies: string[]) {
  return [{ repository: "https://code.example/team/orders.git",
    technologies, confirmed: true }];
}

function publishEngineering(
  dataDir: string,
  index: number,
  content = `工程知识 ${index}`,
) {
  const pending = createKnowledgeCandidate(dataDir, {
    source_task_id: "task-source",
    title: `工程知识 ${index}`,
    summary: `摘要 ${index}`,
    when_to_use: "修改 Java 服务时",
    nature: "engineering",
    form: "rule",
    repositories: ["https://code.example/team/orders.git"],
    technologies: ["java"],
    content,
  }, "developer");
  return decideKnowledgeCandidate(
    dataDir, pending.id, "published", "admin");
}

function workflowDefinition(moduleId: string, asset: {
  id: string; version: number; digest: string;
}) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "test", standard_version: "1",
      catalog_digest: `sha256:${"a".repeat(64)}` },
    applicability: { business_module_ids: [], repositories: [],
      technologies: [] },
    edits: [{
      edit_id: "add-business-knowledge",
      stage_id: "exploration",
      op: "add",
      item: {
        id: "business-knowledge",
        kind: "knowledge",
        title: "订单状态规则",
        locked: false,
        editable: true,
        source: "workflow",
        asset_ref: {
          registry: "business_knowledge",
          business_module_id: moduleId,
          id: asset.id,
          version: String(asset.version),
          digest: asset.digest,
        },
      },
    }],
  };
}

test("发起前预匹配与任务快照共用 40 项上限和稳定版本身份", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-count-"));
  for (let index = 0; index < 41; index += 1) {
    publishEngineering(dataDir, index);
  }
  const taskService = service(dataDir);
  const input = { repositories: [profile([])[0].repository],
    repositoryProfiles: profile(["java"]) };
  const preview = taskService.previewLaunchKnowledge(input);
  assert.equal(preview.engineering_knowledge.length, 40);
  assert.deepEqual(preview.limits.engineering_knowledge, {
    max_assets: 40,
    max_total_bytes: 4 * 1024 * 1024,
    matched: 41,
    selected: 40,
    omitted: 1,
  });
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "engineering_knowledge"
      && warning.code === "limit_applied"), true);
  assert.equal(preview.complete, true,
    "容量上限是权威选择的一部分，不是目录降级");

  const task = taskService.create("核对预匹配", {
    repo: input.repositories[0],
    repositoryProfiles: profile(["java"]).map((item) => ({
      ...item, updated_at: new Date().toISOString(), updated_by: "tester",
    })),
    knowledgePreviewDigest: preview.selection_digest,
  });
  assert.deepEqual(task.engineering_knowledge?.map((item) => item.id),
    preview.engineering_knowledge.map((item) => item.id),
    "页面预览必须就是任务最终固定的有序集合");
  assert.match(preview.engineering_knowledge[0].digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.engineering_knowledge[0].matched_repositories,
    input.repositories);
  assert.deepEqual(preview.engineering_knowledge[0].matched_technologies,
    ["java"]);
});

test("4 MiB 上限与任务创建对拍，不能把匹配项全数冒充已注入", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-bytes-"));
  const content = "x".repeat(256 * 1024);
  for (let index = 0; index < 17; index += 1) {
    publishEngineering(dataDir, index, content);
  }
  const taskService = service(dataDir);
  const input = { repositories: [profile([])[0].repository],
    repositoryProfiles: profile(["java"]) };
  const preview = taskService.previewLaunchKnowledge(input);
  assert.equal(preview.engineering_knowledge.length, 16);
  assert.equal(preview.limits.engineering_knowledge.omitted, 1);
  const task = taskService.create("核对字节限额", {
    repo: input.repositories[0],
    repositoryProfiles: profile(["java"]).map((item) => ({
      ...item, updated_at: new Date().toISOString(), updated_by: "tester",
    })),
  });
  assert.deepEqual(task.engineering_knowledge?.map((item) => item.id),
    preview.engineering_knowledge.map((item) => item.id));
});

test("工作流引用强制并入业务模块；预览返回管理定位、版本与真正命中交集",
  () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-flow-"));
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
      repositories: ["https://code.example/team/orders.git"],
    }, "admin");
    const module = publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: ["https://code.example/team/orders.git"],
      content: "# 订单状态规则\n",
    }, "owner");
    const asset = module.assets.find((item) => item.id === "state")!;
    const taskService = service(dataDir);
    const definition = workflowDefinition("orders", asset);
    const preview = taskService.previewLaunchKnowledge({
      repositories: ["https://code.example/team/orders.git"],
      selectedBusinessModuleIds: [],
      workflowDefinition: definition,
    });
    assert.deepEqual(preview.scope.business_module_ids, ["orders"]);
    assert.deepEqual(preview.scope.workflow_business_module_ids, ["orders"]);
    assert.deepEqual(preview.business_knowledge.map((item) => ({
      module_id: item.module_id,
      id: item.id,
      version: item.version,
      digest: item.digest,
      matched_business_module_ids: item.matched_business_module_ids,
      matched_repositories: item.matched_repositories,
    })), [{
      module_id: "orders",
      id: "state",
      version: 1,
      digest: asset.digest,
      matched_business_module_ids: ["orders"],
      matched_repositories: ["https://code.example/team/orders.git"],
    }]);
  });

test("目录损坏显式返回 source 告警与 degraded，不伪装成零匹配", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-degrade-"));
  mkdirSync(join(dataDir, "business-modules", "broken"), { recursive: true });
  writeFileSync(join(dataDir, "business-modules", "broken", "module.json"),
    "{broken");
  writeFileSync(join(dataDir, "knowledge-candidates"), "not-a-directory");
  const preview = service(dataDir).previewLaunchKnowledge({});
  assert.equal(preview.complete, false);
  assert.equal(preview.degraded, true);
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "business_modules"
      && warning.code === "catalog_warning"), true);
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "engineering_knowledge"
      && warning.code === "catalog_unavailable"), true);
});

test("工程知识正文损坏不能伪装成完整清单，旧 digest 创建必须拒绝", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-corrupt-"));
  const repository = "https://code.example/team/orders.git";
  const candidate = publishEngineering(dataDir, 1);
  const taskService = service(dataDir);
  const repositoryProfiles = [{
    repository, technologies: ["java"], confirmed: true,
    updated_at: new Date().toISOString(), updated_by: "tester",
  }];
  const input = { repositories: [repository], repositoryProfiles };
  const trusted = taskService.previewLaunchKnowledge(input);
  assert.equal(trusted.complete, true);
  assert.deepEqual(trusted.engineering_knowledge.map((item) => item.id),
    [candidate.id]);

  const file = join(dataDir, "knowledge-candidates", `${candidate.id}.json`);
  const stored = JSON.parse(readFileSync(file, "utf-8")) as {
    content: string;
  };
  stored.content = "# 被替换但未重签的正文\n";
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);

  const degraded = taskService.previewLaunchKnowledge(input);
  assert.equal(degraded.complete, false);
  assert.equal(degraded.degraded, true);
  assert.deepEqual(degraded.engineering_knowledge, []);
  assert.equal(degraded.warnings.some((warning) =>
    warning.source === "engineering_knowledge"
      && warning.code === "catalog_warning"
      && warning.message.includes(candidate.id)
      && warning.message.includes("正文与发布指纹不一致")), true);

  assert.throws(() => taskService.create("不能固定损坏的知识清单", {
    repo: repository,
    repositoryProfiles,
    knowledgePreviewDigest: trusted.selection_digest,
  }), /知识清单暂时无法完整核对/);
  assert.deepEqual(taskService.list(), []);
  assert.equal(existsSync(join(dataDir, "task-1")), false,
    "目录降级必须在 task id 分配和现场创建前拒绝");
});

test("团队 Skill 预览复用快照包验收，坏包不会冒充最终已固定", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-skill-"));
  const valid = join(dataDir, "skills", "java-review");
  const oversized = join(dataDir, "skills", "oversized");
  mkdirSync(valid, { recursive: true });
  mkdirSync(oversized, { recursive: true });
  writeFileSync(join(valid, "SKILL.md"), [
    "---", "name: java-review", "description: Java review",
    "knowledge_nature: engineering", "technologies: [java]", "---",
    "", "# Review",
  ].join("\n"));
  writeFileSync(join(oversized, "SKILL.md"), [
    "---", "name: oversized", "description: Oversized skill",
    "knowledge_nature: engineering", "technologies: [java]", "---",
    "", "x".repeat(129 * 1024),
  ].join("\n"));
  const taskService = service(dataDir);
  const repositories = [profile([])[0].repository];
  const repositoryProfiles = profile(["java"]);
  const preview = taskService.previewLaunchKnowledge({
    repositories, repositoryProfiles,
  });
  assert.deepEqual(preview.team_skills.map((skill) => skill.path),
    ["java-review/SKILL.md"], JSON.stringify(preview.warnings));
  assert.match(preview.team_skills[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(preview.warnings.some((warning) =>
    warning.source === "team_skills" && /128 KiB/.test(warning.message)), true);
  assert.equal(preview.complete, false,
    "坏包存在时清单必须显式标为不可用于最终固定");
  rmSync(oversized, { recursive: true });
  const verifiedPreview = taskService.previewLaunchKnowledge({
    repositories, repositoryProfiles,
  });
  assert.equal(verifiedPreview.complete, true,
    JSON.stringify(verifiedPreview.warnings));
  const task = taskService.create("核对团队 Skill", {
    repo: repositories[0],
    repositoryProfiles: repositoryProfiles.map((item) => ({
      ...item, updated_at: new Date().toISOString(), updated_by: "tester",
    })),
    knowledgePreviewDigest: verifiedPreview.selection_digest,
  });
  assert.deepEqual(task.team_skills?.map((skill) =>
    skill.source_path ?? skill.path),
    verifiedPreview.team_skills.map((skill) => skill.path));
});

test("知识清单指纹绑定创建：旧清单拒绝且不占 task id，未变化清单放行",
  () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-digest-"));
    const repository = "https://code.example/team/orders.git";
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
      repositories: [repository],
    }, "admin");
    publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: [repository], content: "# 状态规则 v1\n",
    }, "owner");
    const taskService = service(dataDir);
    const repositoryProfiles = [{
      repository, technologies: ["java"], confirmed: true,
      updated_at: new Date().toISOString(), updated_by: "tester",
    }];
    const selection = {
      repositories: [repository],
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
    };
    const stalePreview = taskService.previewLaunchKnowledge(selection);
    assert.equal(stalePreview.complete, true);
    assert.match(stalePreview.selection_digest, /^[a-f0-9]{64}$/);

    publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束 v2",
      when_to_use: "修改订单状态时", form: "rule",
      repositories: [repository], content: "# 状态规则 v2\n",
    }, "owner");
    const refreshedPreview = taskService.previewLaunchKnowledge(selection);
    assert.notEqual(refreshedPreview.selection_digest,
      stalePreview.selection_digest, "知识版本变化必须改变清单指纹");

    assert.throws(() => taskService.create("不能静默换知识", {
      repo: repository,
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
      knowledgePreviewDigest: stalePreview.selection_digest,
    }), /知识清单已变化/);
    assert.deepEqual(taskService.list(), [], "旧指纹不能产生半张任务台账");
    assert.equal(existsSync(join(dataDir, "task-1")), false,
      "指纹校验必须发生在 task id 分配与现场创建之前");

    const task = taskService.create("使用核对过的知识", {
      repo: repository,
      selectedBusinessModuleIds: ["orders"],
      repositoryProfiles,
      knowledgePreviewDigest: refreshedPreview.selection_digest,
    });
    assert.equal(task.id, "task-1", "被拒请求不能消耗任务序号");
    assert.equal(task.business_modules?.[0].assets[0].version, 2);
  });

test("技术画像记忆失败时，本单仍使用已核对画像而不静默缩小匹配范围",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-profile-write-"));
    const repository = "https://code.example/team/orders.git";
    const engineering = publishEngineering(dataDir, 1);
    // profiles.json 故意做成目录，让“记住供下次使用”失败；当前请求的
    // 画像仍然是合法输入，不能因此从 Java 匹配退化成无技术栈。
    mkdirSync(join(dataDir, "repository-profiles", "profiles.json"), {
      recursive: true,
    });
    const taskService = service(dataDir);
    const repositoryProfiles = [{
      repository, technologies: ["java"], confirmed: true,
    }];
    const preview = taskService.previewLaunchKnowledge({
      repositories: [repository], repositoryProfiles,
    });
    assert.deepEqual(preview.engineering_knowledge.map((item) => item.id),
      [engineering.id]);
    const server = createTaskServer(taskService);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${
      (server.address() as AddressInfo).port}`;
    try {
      const unreviewed = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "不能绕过自动匹配清单核对",
          repos: [repository],
          repository_profiles: repositoryProfiles,
        }),
      });
      assert.equal(unreviewed.status, 409,
        "匹配到知识时，直接 POST 不能省略清单指纹");
      assert.match(await unreviewed.text(), /先在发起页核对自动匹配知识/);
      const blankDigest = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "空指纹也不能绕过",
          repos: [repository],
          repository_profiles: repositoryProfiles,
          knowledge_preview_digest: "",
        }),
      });
      assert.equal(blankDigest.status, 400);
      const response = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          requirement: "沿用本单确认的 Java 技术画像",
          repos: [repository],
          repository_profiles: repositoryProfiles,
          knowledge_preview_digest: preview.selection_digest,
        }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const task = await response.json() as {
        engineering_knowledge?: Array<{ id: string }>;
        repository_profiles?: Array<{ technologies: string[] }>;
      };
      assert.deepEqual(task.repository_profiles?.[0].technologies, ["java"]);
      assert.deepEqual(task.engineering_knowledge?.map((item) => item.id),
        [engineering.id]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
  });

test("POST 预匹配由服务端解析已发布 workflow_selection，不创建任务现场",
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-launch-authority-route-"));
    createBusinessModule(dataDir, {
      id: "orders", name: "订单域", description: "订单边界", owner: "owner",
    }, "admin");
    const module = publishBusinessKnowledgeAsset(dataDir, "orders", {
      id: "state", title: "状态规则", summary: "状态迁移约束",
      when_to_use: "修改订单状态时", content: "# 状态规则\n",
    }, "owner");
    const asset = module.assets.find((item) => item.id === "state")!;
    const library = new WorkflowAssetLibrary(dataDir);
    library.create({ id: "order-flow", name: "订单流程", scope: "team",
      owner: "owner", definition: workflowDefinition("orders", asset) });
    library.submitForReview("order-flow", { actor: "owner" });
    library.approve("order-flow", { actor: "admin" });
    const taskService = service(dataDir);
    const server = createTaskServer(taskService);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${
      (server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${base}/launch-knowledge-preview`, {
        method: "POST",
        body: JSON.stringify({
          workflow_selection: { id: "order-flow", version: "v1" },
          selected_business_module_ids: [],
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const preview = await response.json() as {
        business_knowledge: Array<{ module_id: string; id: string; version: number }>;
        scope: { workflow_business_module_ids: string[] };
      };
      assert.deepEqual(preview.scope.workflow_business_module_ids, ["orders"]);
      assert.deepEqual(preview.business_knowledge.map((item) => ({
        module_id: item.module_id, id: item.id, version: item.version,
      })), [{
        module_id: "orders", id: "state", version: 1,
      }], "响应必须保留可直达管理位的稳定身份");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) =>
        error ? reject(error) : resolve()));
    }
    assert.deepEqual(taskService.list(), []);
  });
