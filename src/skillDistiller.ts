/**
 * 沉淀环(roadmap §9,形态参照 memsearch 的 skill 蒸馏):
 * 从任务现场的真实证据起草 skill 修订稿,落进候选区等人裁决。
 *
 * 三条边界,设计期就钉死:
 * - 起草是旁路:单发无工具模型调用,带硬超时预算,失败如实报错,
 *   绝不引入任何等待环或第二记忆层("知识在仓"的拍板不动);
 * - 草稿只进候选区(skill-candidates/),**绝不自动上架**;采纳时走
 *   资产库同一道上架闸(装载器裁决+密钥扫描+权限归一+版本痕+留痕);
 * - 证据来自任务摘要里的可观察事实(足迹/修复轮/prepush 失败原文),
 *   提示词明确要求"只依据证据修订",不许模型编造踩坑。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { KnowledgeInsightTask, HostSkillEffect } from "./knowledgeInsights.ts";
import {
  SkillLibraryError,
  scanForSecrets,
  uploadHostSkill,
  type SkillOperationRecord,
  type SkillUploadFile,
} from "./hostSkillLibrary.ts";
import { readSkillKnowledgeMetadata } from "./knowledgeAssetModel.ts";

const CANDIDATES_DIR = "skill-candidates";
/** 单发补全的墙钟预算:起草不是交付,超时就放弃,人可以再点一次。 */
const DRAFT_TIMEOUT_MS = 180_000;
/** 证据包上限:最多取多少个任务、每段多长。控输入就是控成本。 */
const MAX_EVIDENCE_TASKS = 8;
const MAX_FIELD_CHARS = 600;

export class SkillDistillError extends Error {}

export interface SkillCandidateRecord {
  id: string;
  directory: string;
  created_at: string;
  operator: string;
  status: "drafted" | "adopted" | "discarded";
  evidence_tasks: string[];
  adopted_at?: string;
  adopted_by?: string;
}

/** 起草证据需要的任务事实——TaskSummary 的结构子集。 */
export interface DistillTaskFacts extends KnowledgeInsightTask {
  title?: string;
  requirement?: string;
  delivery?: {
    loop?: { round?: number; kind?: string; state?: string };
    prepush?: {
      state?: string;
      round?: number;
      issue?: { kind?: string; check?: string; message?: string };
    };
  };
}

function clip(value: unknown, max = MAX_FIELD_CHARS): string {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isHostSkillRead(resource: {
  kind: string;
  repository?: string;
  path: string;
  name: string;
  read_count: number;
}, skillName: string): boolean {
  return resource.kind === "skill" && !resource.repository
    && resource.name === skillName && resource.read_count > 0
    && (resource.path.startsWith(".mae-flow-work/host-skills/")
      || resource.path.startsWith("宿主技能/"));
}

/** 汇编证据包:只收"读过该 skill 的任务"的可观察事实。修复轮多、
 * prepush 失败带原文的任务优先——那才是修订线索所在。 */
export function collectSkillEvidence(
  tasks: DistillTaskFacts[],
  skillName: string,
): { taskIds: string[]; text: string } {
  const relevant = tasks
    .filter((task) => (task.knowledge_usage?.resources ?? [])
      .some((resource) => isHostSkillRead(resource, skillName)))
    .sort((left, right) =>
      ((right.delivery?.loop?.round ?? 0) - (left.delivery?.loop?.round ?? 0))
      || ((right.delivery?.prepush?.round ?? 0)
        - (left.delivery?.prepush?.round ?? 0)))
    .slice(0, MAX_EVIDENCE_TASKS);
  const blocks = relevant.map((task) => {
    const lines = [
      `## 任务 ${task.id}(状态 ${task.status})`,
      `需求:${clip(task.title ?? task.requirement) || "(无记录)"}`,
    ];
    const loop = task.delivery?.loop;
    if (loop?.round) {
      lines.push(`修复环:第 ${loop.round} 轮,状态 ${loop.state ?? "?"}`
        + `${loop.kind ? `,类别 ${loop.kind}` : ""}`);
    }
    const prepush = task.delivery?.prepush;
    if (prepush?.state) {
      lines.push(`推送前验证:${prepush.state},第 ${prepush.round ?? "?"} 轮`);
      if (prepush.issue?.message) {
        lines.push(`失败原文(${prepush.issue.check ?? prepush.issue.kind
          ?? "?"}):${clip(prepush.issue.message)}`);
      }
    }
    return lines.join("\n");
  });
  return {
    taskIds: relevant.map((task) => task.id),
    text: blocks.join("\n\n"),
  };
}

function effectSummary(effect: HostSkillEffect | undefined): string {
  if (!effect) return "(暂无效果账)";
  const lines = [
    `装载 ${effect.provided_tasks} 单,读取 ${effect.accessed_tasks} 单,`
    + `读后返修 ${effect.repair_tasks} 单`,
    `读后 prepush 一次过 ${effect.prepush_first_pass}/${effect.prepush_measured},`
    + `未读对照 ${effect.baseline_first_pass}/${effect.baseline_measured}`,
  ];
  if (effect.signal_evidence) lines.push(`修订信号:${effect.signal_evidence}`);
  return lines.join("\n");
}

export function buildDistillPrompt(input: {
  skillName: string;
  skillContent: string;
  effect?: HostSkillEffect;
  evidenceText: string;
}): { system: string; user: string } {
  return {
    system: [
      "你是团队 Skill(写法指南)的修订助手。你的唯一任务:根据真实任务",
      "现场的证据,起草这份 SKILL.md 的修订稿。铁的纪律:",
      "1. 只依据证据修订——证据没提到的坑不许编造;没有证据支持的段落",
      "   保持原样;",
      "2. skill 永远是写法指南,不是执行器:不许加执行步骤编排、门禁或",
      "   流程指令;",
      "3. 保留 frontmatter(name 不许改,description 可按证据微调);",
      "4. 任何令牌/密码/密钥形态的内容绝对禁止出现;",
      "5. 输出格式(严格遵守,不要输出其他任何文字):",
      "===SKILL===",
      "<修订后的 SKILL.md 全文>",
      "===NOTES===",
      "<修订说明:改了哪几处、各自依据哪条证据;没改的地方为什么不改>",
    ].join("\n"),
    user: [
      `# 待修订 skill:${input.skillName}`,
      "",
      "## 当前 SKILL.md 全文",
      "```markdown",
      input.skillContent,
      "```",
      "",
      "## 效果账(平台聚合,相关性观察)",
      effectSummary(input.effect),
      "",
      "## 读过该 skill 的任务现场证据",
      input.evidenceText || "(无)",
    ].join("\n"),
  };
}

export function parseDraft(text: string): { skill: string; notes: string } {
  const skillMatch = text.match(/===SKILL===\s*\n([\s\S]*?)\n\s*===NOTES===/);
  const notesMatch = text.match(/===NOTES===\s*\n([\s\S]*)$/);
  if (skillMatch) {
    return {
      skill: skillMatch[1].trim(),
      notes: (notesMatch?.[1] ?? "").trim(),
    };
  }
  // 标记缺失:整段当草稿,说明留空——候选区允许粗糙,采纳闸会兜底。
  return { skill: text.trim(), notes: "" };
}

/** 单发无工具补全。超时即弃,不做任何重试——起草是旁路,人可以再点。 */
export async function draftWithModel(input: {
  modelsJson: Record<string, unknown>;
  provider: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
}): Promise<string> {
  const agentDir = mkdtempSync(join(tmpdir(), "mfc-distill-"));
  try {
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(input.modelsJson));
    const runtime = await ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
    });
    const model = runtime.getModel(input.provider, input.model);
    if (!model) {
      throw new SkillDistillError(
        `models.json 里找不到模型 ${input.provider}/${input.model}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),
      input.timeoutMs ?? DRAFT_TIMEOUT_MS);
    try {
      const reply = await runtime.completeSimple(model, {
        systemPrompt: input.system,
        messages: [{
          role: "user", content: input.user, timestamp: Date.now(),
        }],
      }, { signal: controller.signal } as never);
      const text = (reply.content ?? [])
        .filter((item): item is { type: "text"; text: string } =>
          (item as { type?: string }).type === "text")
        .map((item) => item.text).join("\n").trim();
      if (!text) {
        throw new SkillDistillError(
          `模型没有返回草稿(stopReason=${String((reply as {
            stopReason?: string }).stopReason ?? "?")})`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function candidateRoot(dataDir: string, directory: string): string {
  return join(dataDir, CANDIDATES_DIR, directory);
}

export function saveSkillCandidate(
  dataDir: string,
  directory: string,
  draft: { skill: string; notes: string; evidence: string },
  taskIds: string[],
  operator: string,
): SkillCandidateRecord {
  // 草稿也走密钥扫描:候选区文件与 skill 同属可读区,纪律一致。
  scanForSecrets("SKILL.md(草稿)", Buffer.from(draft.skill, "utf-8"));
  // 毫秒戳 + 占位去重:同一秒连存两份草稿不许互相覆盖(实测踩过)。
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let id = stamp;
  for (let seq = 1; existsSync(
    join(candidateRoot(dataDir, directory), id)); seq += 1) {
    id = `${stamp}${seq}`;
  }
  const root = join(candidateRoot(dataDir, directory), id);
  mkdirSync(root, { recursive: true });
  const record: SkillCandidateRecord = {
    id,
    directory,
    created_at: new Date().toISOString(),
    operator,
    status: "drafted",
    evidence_tasks: taskIds,
  };
  writeFileSync(join(root, "SKILL.md"), draft.skill, { mode: 0o644 });
  writeFileSync(join(root, "NOTES.md"), draft.notes || "(模型未提供修订说明)",
    { mode: 0o644 });
  writeFileSync(join(root, "EVIDENCE.md"), draft.evidence, { mode: 0o644 });
  writeFileSync(join(root, "candidate.json"), JSON.stringify(record),
    { mode: 0o644 });
  return record;
}

export function listSkillCandidates(
  dataDir: string,
  directory: string,
): SkillCandidateRecord[] {
  const root = candidateRoot(dataDir, directory);
  if (!existsSync(root)) return [];
  const records: SkillCandidateRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      records.push(JSON.parse(readFileSync(
        join(root, entry.name, "candidate.json"), "utf-8")));
    } catch {
      // 坏候选跳过:候选区是旁路,读侧永远 fail-open。
    }
  }
  return records.sort((left, right) => right.id.localeCompare(left.id));
}

export function readSkillCandidate(
  dataDir: string,
  directory: string,
  id: string,
): { record: SkillCandidateRecord; skill: string; notes: string; evidence: string } {
  assertCandidateId(id);
  const root = join(candidateRoot(dataDir, directory), id);
  if (!existsSync(join(root, "candidate.json"))) {
    throw new SkillDistillError(`没有这个修订候选: ${id}`);
  }
  const read = (name: string) => {
    try {
      return readFileSync(join(root, name), "utf-8");
    } catch {
      return "";
    }
  };
  return {
    record: JSON.parse(readFileSync(join(root, "candidate.json"), "utf-8")),
    skill: read("SKILL.md"),
    notes: read("NOTES.md"),
    evidence: read("EVIDENCE.md"),
  };
}

function assertCandidateId(id: string): void {
  if (!/^[0-9TZ]+$/.test(id)) {
    throw new SkillDistillError(`候选编号不合法: ${id}`);
  }
}

/** 采纳:候选 SKILL.md + 在架包的其余文件,重新走完整上架闸。
 * 候选区本体不动(候选也留痕),只改状态。 */
export async function adoptSkillCandidate(
  dataDir: string,
  directory: string,
  id: string,
  operator: string,
): Promise<SkillOperationRecord> {
  const candidate = readSkillCandidate(dataDir, directory, id);
  if (candidate.record.status !== "drafted") {
    throw new SkillDistillError(`候选已是 ${candidate.record.status},不能再采纳`);
  }
  const files: SkillUploadFile[] = [{
    path: "SKILL.md",
    content_base64: Buffer.from(candidate.skill, "utf-8").toString("base64"),
  }];
  // 在架包的资源文件(模板等)原样保留——修订的是指南正文,不是附件。
  const live = join(dataDir, "skills", directory);
  if (existsSync(live)) {
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name);
        if (lstatSync(absolute).isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(absolute);
        else {
          const path = relative(live, absolute).split(sep).join("/");
          if (path === "SKILL.md") continue;
          files.push({
            path,
            content_base64: readFileSync(absolute).toString("base64"),
          });
        }
      }
    };
    walk(live);
  }
  let operation: SkillOperationRecord;
  try {
    if (!existsSync(join(live, "SKILL.md"))) {
      throw new SkillDistillError("在架 Skill 不存在，无法继承知识标签");
    }
    const metadata = readSkillKnowledgeMetadata(
      readFileSync(join(live, "SKILL.md"), "utf-8"));
    operation = await uploadHostSkill(
      dataDir, directory, files, operator, metadata);
  } catch (error) {
    if (error instanceof SkillLibraryError) {
      throw new SkillDistillError(`候选未通过上架闸: ${error.message}`);
    }
    throw error;
  }
  const record: SkillCandidateRecord = {
    ...candidate.record,
    status: "adopted",
    adopted_at: new Date().toISOString(),
    adopted_by: operator,
  };
  writeFileSync(
    join(candidateRoot(dataDir, directory), id, "candidate.json"),
    JSON.stringify(record), { mode: 0o644 });
  return operation;
}

export function discardSkillCandidate(
  dataDir: string,
  directory: string,
  id: string,
): void {
  assertCandidateId(id);
  const root = join(candidateRoot(dataDir, directory), id);
  if (!existsSync(root)) {
    throw new SkillDistillError(`没有这个修订候选: ${id}`);
  }
  rmSync(root, { recursive: true, force: true });
}
