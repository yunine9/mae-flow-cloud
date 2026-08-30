/**
 * 沉淀环契约(roadmap §9,形态参照 memsearch 蒸馏):
 * - 证据只收"真读过该 skill 的任务"的可观察事实,修复重的排前面;
 * - 起草=单发无工具模型调用,草稿只进候选区,绝不自动上架;
 * - 草稿同样过密钥扫描;采纳走资产库同一道上架闸(坏 frontmatter 拒);
 * - 没有消费足迹时如实拒绝起草,不许无证据编 skill。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillDistillError,
  adoptSkillCandidate,
  collectSkillEvidence,
  discardSkillCandidate,
  listSkillCandidates,
  parseDraft,
  readSkillCandidate,
  saveSkillCandidate,
  type DistillTaskFacts,
} from "../src/skillDistiller.ts";
import { uploadHostSkill } from "../src/hostSkillLibrary.ts";
import { listHostSkillShelf } from "../src/hostSkillShelf.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const encode = (text: string) => Buffer.from(text, "utf-8").toString("base64");

function skillMd(description: string, body: string): string {
  return `---\nname: java-autout\ndescription: ${description}\nknowledge_nature: engineering\ntechnologies: [java]\n---\n\n${body}\n`;
}

const ENGINEERING_METADATA = {
  nature: "engineering" as const,
  business_module_ids: [], repositories: [], technologies: ["java"],
};

function readerTask(options: {
  id: string;
  reads: number;
  repairRound?: number;
  prepushIssue?: string;
}): DistillTaskFacts {
  return {
    id: options.id,
    status: "verifying",
    title: `需求 ${options.id}`,
    knowledge_usage: {
      summary: { resources: 1, loaded: 0, used: 1, skills_used: 1,
        selected_unused: 0 },
      resources: [{
        id: "skill:java-autout",
        kind: "skill",
        name: "java-autout",
        path: ".mae-flow-work/host-skills/cafe0123abcd/SKILL.md",
        state: options.reads > 0 ? "used" : "available",
        available_count: 1,
        loaded_count: 0,
        read_count: options.reads,
      }],
      events: [],
    },
    delivery: {
      ...(options.repairRound
        ? { loop: { round: options.repairRound, state: "repairing" } } : {}),
      ...(options.prepushIssue
        ? { prepush: { state: "blocked", round: 2,
            issue: { check: "unit_test", message: options.prepushIssue } } }
        : {}),
    },
  };
}

test("证据包:只收读过的任务,修复重的排前,prepush 失败原文入包", () => {
  const evidence = collectSkillEvidence([
    readerTask({ id: "light", reads: 1 }),
    readerTask({ id: "unread", reads: 0 }),
    readerTask({ id: "heavy", reads: 2, repairRound: 3,
      prepushIssue: "AssertionError: 三段命名不符合约定" }),
  ], "java-autout");
  assert.deepEqual(evidence.taskIds, ["heavy", "light"],
    "没读的不进证据;修复轮多的排前面");
  assert.match(evidence.text, /三段命名不符合约定/);
  assert.match(evidence.text, /修复环:第 3 轮/);
});

test("草稿解析:标记齐全按段切,缺标记整段当草稿", () => {
  const parsed = parseDraft(
    "===SKILL===\n---\nname: x\n---\n正文\n===NOTES===\n改了三处");
  assert.equal(parsed.skill, "---\nname: x\n---\n正文");
  assert.equal(parsed.notes, "改了三处");
  const fallback = parseDraft("没按格式来的输出");
  assert.equal(fallback.skill, "没按格式来的输出");
  assert.equal(fallback.notes, "");
});

test("候选区纪律:草稿过密钥扫描;采纳走上架闸,坏草稿拒并保持原版", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-distill-lib-"));
  await uploadHostSkill(dataDir, "java-autout", [
    { path: "SKILL.md", content_base64: encode(skillMd("v1", "老写法")) },
    { path: "templates/case.md", content_base64: encode("模板\n") },
  ], "admin", ENGINEERING_METADATA);

  // 含密钥的草稿在存候选时就拒——候选区与 skill 同属权限全开区。
  assert.throws(() => saveSkillCandidate(dataDir, "java-autout", {
    skill: skillMd("v2", "api_key = sk_live_abcd1234efgh"),
    notes: "", evidence: "",
  }, ["t1"], "admin"), (error) => error instanceof Error
    && /令牌|密钥/.test(error.message));
  assert.equal(listSkillCandidates(dataDir, "java-autout").length, 0);

  // 坏 frontmatter 的草稿能进候选区(候选允许粗糙),但采纳被上架闸拒。
  const bad = saveSkillCandidate(dataDir, "java-autout", {
    skill: "没有 frontmatter 的草稿", notes: "", evidence: "",
  }, ["t1"], "admin");
  await assert.rejects(
    adoptSkillCandidate(dataDir, "java-autout", bad.id, "admin"),
    (error) => error instanceof SkillDistillError
      && /上架闸/.test(error.message));
  assert.match(listHostSkillShelf(dataDir).skills[0].description, /v1/,
    "采纳失败必须保持原版在架");

  // 好草稿:采纳=新版本上架,附件保留,候选状态翻 adopted 且不能二采。
  const good = saveSkillCandidate(dataDir, "java-autout", {
    skill: skillMd("v2 修订", "新写法:先读模板再写测试"),
    notes: "依据 heavy 单的失败原文补了命名约定",
    evidence: "## 任务 heavy",
  }, ["heavy"], "admin");
  const operation = await adoptSkillCandidate(
    dataDir, "java-autout", good.id, "admin");
  assert.equal(operation.action, "update");
  const shelf = listHostSkillShelf(dataDir);
  assert.match(shelf.skills[0].description, /v2 修订/);
  assert.ok(existsSync(join(dataDir, "skills", "java-autout",
    "templates", "case.md")), "采纳只换正文,附件原样保留");
  assert.equal(
    readSkillCandidate(dataDir, "java-autout", good.id).record.status,
    "adopted");
  await assert.rejects(
    adoptSkillCandidate(dataDir, "java-autout", good.id, "admin"),
    /不能再采纳/);
  discardSkillCandidate(dataDir, "java-autout", bad.id);
  assert.equal(listSkillCandidates(dataDir, "java-autout").length, 1);
});

test("端到端:distillSkillDraft 用真实足迹起草;无足迹如实拒绝", async () => {
  // linear=剧本跨会话顺演:第 1 个请求收口任务会话,第 2 个是蒸馏调用。
  const model = new ScriptedModelServer([
    { text: "首轮会话收口。" },
    { text: "===SKILL===\n" + skillMd("修订版", "按失败原文补了三段命名约定")
      + "===NOTES===\n依据 prepush 失败原文修订" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-distill-e2e-"));
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    await uploadHostSkill(dataDir, "java-autout", [
      { path: "SKILL.md", content_base64: encode(skillMd("v1", "老写法")) },
    ], "admin", ENGINEERING_METADATA);

    await assert.rejects(
      service.distillSkillDraft("java-autout", "boss"),
      /还没有任务真正读过/,
      "零足迹必须拒绝起草——不许无证据编 skill");

    const id = service.create("蒸馏演练任务").id;
    const deadline = Date.now() + 20_000;
    while (service.get(id)?.status !== "completed") {
      if (Date.now() > deadline) throw new Error("首轮会话未收口");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const internal = (service as any).tasks.get(id);
    writeFileSync(join(internal.summary.workspace, "knowledge-events.jsonl"),
      `${JSON.stringify({
        id: "skill:java-autout", kind: "skill", name: "java-autout",
        path: ".mae-flow-work/host-skills/cafe0123abcd/SKILL.md",
        ts: new Date().toISOString(), task_id: id, session_id: "main",
        session_role: "main", action: "read",
      })}\n`);
    internal.summary.delivery = {
      ...internal.summary.delivery,
      prepush: { schema: "mfc/prepush-state/1", state: "blocked", round: 2,
        message: "unit_test 失败", sha: "x", workspace_fingerprint: "y",
        updated_at: new Date().toISOString(),
        checks: {}, issue: { kind: "code_failure", check: "unit_test",
          message: "AssertionError: 命名不符合三段式", at: "now" } },
    };

    const candidate = await service.distillSkillDraft("java-autout", "boss");
    assert.equal(candidate.status, "drafted");
    assert.deepEqual(candidate.evidence_tasks, [id]);
    const detail = readSkillCandidate(dataDir, "java-autout", candidate.id);
    assert.match(detail.skill, /三段命名约定/);
    assert.match(detail.notes, /依据 prepush 失败原文/);
    assert.match(detail.evidence, /命名不符合三段式/,
      "证据包要带失败原文,检视人不用回现场翻");
    assert.equal(service.hostSkillShelf().skills[0].candidates, 1,
      "货架条目带待裁决候选数");
  } finally {
    await model.stop();
  }
});
