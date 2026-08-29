/**
 * Immutable execution preferences resolved when a task is created.
 *
 * The workflow kernel still owns phase contracts, evidence and permissions.
 * These layers only add lower-priority guidance about focus, ordering and
 * collaboration.  Keeping the snapshot in the task makes retries and history
 * deterministic and gives the kernel one file contract instead of a Cloud DB
 * dependency.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const EXECUTION_PROFILE_SCHEMA = "mae-flow-execution-profile/1" as const;
export const EXECUTION_PROFILE_PATH = join(
  ".mae-flow-work", "execution-profile.json");
export const MAX_TASK_EXECUTION_INSTRUCTIONS = 2_000;
const MAX_REPOSITORY_DEFAULTS_BYTES = 64 * 1024;
const SCOPE_ORDER: Record<ExecutionProfileScope, number> = {
  team: 0, business_module: 1, repository: 2, task: 3,
};

export type ExecutionProfileScope =
  | "team"
  | "business_module"
  | "repository"
  | "task";

export interface ExecutionProfileLayer {
  scope: ExecutionProfileScope;
  source_id: string;
  title: string;
  instructions: string;
}

/** A stage customization can only add catalogued optional work, promote an
 * already available resource, or add lower-priority guidance.  It has no
 * representation for deleting required work or replacing the stage. */
export interface ExecutionStageCustomization {
  playbook_id: string;
  instructions?: string;
  optional_activities: string[];
  preferred_resources: string[];
}

export interface ExecutionProfileStageCustomization
  extends ExecutionStageCustomization {
  scope: ExecutionProfileScope;
  source_id: string;
  title: string;
}

export interface TaskExecutionProfile {
  schema: typeof EXECUTION_PROFILE_SCHEMA;
  revision: string;
  layers: ExecutionProfileLayer[];
  stage_customizations?: ExecutionProfileStageCustomization[];
}

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** Keep useful line breaks, reject binary/control transport and cap prompt size. */
function normalizeExecutionInstructions(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).replace(/\r\n?/g, "\n")
    .replace(/[\u0000\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n").map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n").trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_TASK_EXECUTION_INSTRUCTIONS) {
    throw new Error(
      `${label}不能超过 ${MAX_TASK_EXECUTION_INSTRUCTIONS} 个字符；`
      + "请只写关注点、顺序偏好和协作要求，详细需求放在需求正文",
    );
  }
  return normalized;
}

export function normalizeTaskExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "本任务执行补充");
}

export function normalizeTeamExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "团队执行约定");
}

export function normalizeRepositoryExecutionInstructions(
  value: string | undefined,
): string | undefined {
  return normalizeExecutionInstructions(value, "代码仓执行约定");
}

function normalizedIdList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const result = [...new Set(value.map((item) => String(item).trim())
    .filter(Boolean))];
  if (result.length > 24) throw new Error(`${label}最多选择 24 项`);
  for (const item of result) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(item)) {
      throw new Error(`${label}包含非法标识: ${item}`);
    }
  }
  return result.sort();
}

export function normalizeExecutionStageCustomizations(
  value: unknown,
  label: string,
): ExecutionStageCustomization[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (value.length > 16) throw new Error(`${label}最多配置 16 个阶段`);
  const byPlaybook = new Map<string, ExecutionStageCustomization>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${label}中的阶段配置必须是对象`);
    }
    const input = raw as Record<string, unknown>;
    const playbookId = String(input.playbook_id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(playbookId)) {
      throw new Error(`${label}包含非法方案标识: ${playbookId || "(空)"}`);
    }
    if (byPlaybook.has(playbookId)) {
      throw new Error(`${label}重复配置了方案 ${playbookId}`);
    }
    const instructions = normalizeExecutionInstructions(
      input.instructions == null ? undefined : String(input.instructions),
      `${label}（${playbookId}）`,
    );
    const optionalActivities = normalizedIdList(
      input.optional_activities, `${label}可选动作`);
    const preferredResources = normalizedIdList(
      input.preferred_resources, `${label}优先能力`);
    if (!instructions && !optionalActivities.length && !preferredResources.length) {
      continue;
    }
    byPlaybook.set(playbookId, {
      playbook_id: playbookId,
      ...(instructions ? { instructions } : {}),
      optional_activities: optionalActivities,
      preferred_resources: preferredResources,
    });
  }
  return [...byPlaybook.values()].sort((left, right) =>
    left.playbook_id.localeCompare(right.playbook_id));
}

export interface ExecutionCustomizationCatalogEntry {
  id: string;
  activities: Array<{ id: string; required: boolean }>;
  resources: Array<{ id: string; usage: "required" | "when_needed" | "on_demand" }>;
}

/** API callers cannot smuggle invented prompt fragments or resource names into
 * the pinned profile.  The human only selects IDs from the versioned catalog. */
export function validateExecutionStageCustomizations(
  value: unknown,
  label: string,
  catalog: ExecutionCustomizationCatalogEntry[],
): ExecutionStageCustomization[] {
  const normalized = normalizeExecutionStageCustomizations(value, label);
  const playbooks = new Map(catalog.map((item) => [item.id, item]));
  for (const item of normalized) {
    const playbook = playbooks.get(item.playbook_id);
    if (!playbook) {
      throw new Error(`${label}引用了不存在的阶段方案: ${item.playbook_id}`);
    }
    const optionalActivities = new Set(playbook.activities
      .filter((activity) => !activity.required).map((activity) => activity.id));
    const requiredActivities = new Set(playbook.activities
      .filter((activity) => activity.required).map((activity) => activity.id));
    for (const id of item.optional_activities) {
      if (requiredActivities.has(id)) {
        throw new Error(`${label}中的 ${id} 是平台必做动作，无需重复选择`);
      }
      if (!optionalActivities.has(id)) {
        throw new Error(`${label}引用了不存在的可选动作: ${id}`);
      }
    }
    const resources = new Map(playbook.resources.map((resource) =>
      [resource.id, resource]));
    for (const id of item.preferred_resources) {
      const resource = resources.get(id);
      if (!resource) {
        throw new Error(`${label}引用了不存在的能力: ${id}`);
      }
      if (resource.usage === "required") {
        throw new Error(`${label}中的 ${id} 是平台必用能力，无需设为优先`);
      }
    }
  }
  return normalized;
}

function orderedStageCustomizations(
  value: ExecutionProfileStageCustomization[],
): ExecutionProfileStageCustomization[] {
  return value.map((item) => ({
    ...item,
    optional_activities: [...item.optional_activities].sort(),
    preferred_resources: [...item.preferred_resources].sort(),
  })).sort((left, right) =>
    SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]
    || left.playbook_id.localeCompare(right.playbook_id)
    || left.source_id.localeCompare(right.source_id));
}

function profileRevision(
  layers: ExecutionProfileLayer[],
  stageCustomizations: ExecutionProfileStageCustomization[] = [],
): string {
  let payload = layers.map((layer) => [
    layer.scope,
    layer.source_id,
    layer.title,
    layer.instructions,
  ].join("\0")).join("\n");
  if (stageCustomizations.length) {
    payload += `${payload ? "\n" : ""}--stage-customizations--\n`;
    payload += stageCustomizations.map((item) => [
      item.scope,
      item.source_id,
      item.title,
      item.playbook_id,
      item.instructions ?? "",
      item.optional_activities.join("\u001f"),
      item.preferred_resources.join("\u001f"),
    ].join("\0")).join("\n");
  }
  return createHash("sha256").update(payload, "utf-8")
    .digest("hex").slice(0, 16);
}

export function buildTaskExecutionProfile(
  taskId: string,
  instructions: string | undefined,
  teamInstructions?: string,
  stageCustomizations?: {
    team?: unknown;
    task?: unknown;
  },
): TaskExecutionProfile | undefined {
  const normalized = normalizeTaskExecutionInstructions(instructions);
  const normalizedTeam = normalizeTeamExecutionInstructions(teamInstructions);
  const layers: ExecutionProfileLayer[] = [];
  if (normalizedTeam) layers.push({
    scope: "team",
    source_id: "team-default",
    title: "团队执行约定",
    instructions: normalizedTeam,
  });
  if (normalized) layers.push({
    scope: "task",
    source_id: oneLine(taskId).slice(0, 120),
    title: "本任务补充",
    instructions: normalized,
  });
  const taskSource = oneLine(taskId).slice(0, 120);
  const stages: ExecutionProfileStageCustomization[] = [
    ...normalizeExecutionStageCustomizations(
      stageCustomizations?.team, "团队阶段执行方案").map((item) => ({
        ...item,
        scope: "team" as const,
        source_id: "team-default",
        title: "团队阶段定制",
      })),
    ...normalizeExecutionStageCustomizations(
      stageCustomizations?.task, "本任务阶段执行方案").map((item) => ({
        ...item,
        scope: "task" as const,
        source_id: taskSource,
        title: "本任务阶段定制",
      })),
  ];
  return profileFromParts(layers, stages);
}

function profileFromParts(
  layers: ExecutionProfileLayer[],
  stageCustomizations: ExecutionProfileStageCustomization[] = [],
): TaskExecutionProfile | undefined {
  if (!layers.length && !stageCustomizations.length) return undefined;
  const ordered = layers.map((layer) => ({ ...layer }))
    .sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]);
  const orderedStages = orderedStageCustomizations(stageCustomizations);
  return {
    schema: EXECUTION_PROFILE_SCHEMA,
    revision: profileRevision(ordered, orderedStages),
    layers: ordered,
    ...(orderedStages.length ? { stage_customizations: orderedStages } : {}),
  };
}

/**
 * Resolve the repository-owned optional layer from its existing Mae-Flow
 * defaults file.  It is read once, after clone, then pinned into task.json.
 */
export function resolveRepositoryExecutionProfile(input: {
  workspace: string;
  repositoryId: string;
  profile?: TaskExecutionProfile;
}): { profile?: TaskExecutionProfile; warning?: string } {
  if (input.profile?.layers.some((layer) => layer.scope === "repository")) {
    return { profile: input.profile };
  }
  const path = join(input.workspace, ".mae-flow-defaults.json");
  if (!existsSync(path)) return { profile: input.profile };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(".mae-flow-defaults.json 必须是仓库内普通文件");
    }
    if (stat.size > MAX_REPOSITORY_DEFAULTS_BYTES) {
      throw new Error(".mae-flow-defaults.json 超过 64 KiB");
    }
    const defaults = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      throw new Error(".mae-flow-defaults.json 顶层必须是对象");
    }
    const raw = (defaults as Record<string, unknown>)["执行补充"];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return { profile: input.profile };
    }
    if (typeof raw !== "string") {
      throw new Error(".mae-flow-defaults.json 的「执行补充」必须是字符串");
    }
    const instructions = normalizeRepositoryExecutionInstructions(raw);
    const layers = [
      ...(input.profile?.layers ?? []).map((layer) => ({ ...layer })),
      ...(instructions ? [{
        scope: "repository" as const,
        source_id: oneLine(input.repositoryId).slice(0, 300),
        title: "代码仓执行约定",
        instructions,
      }] : []),
    ];
    return { profile: profileFromParts(
      layers,
      input.profile?.stage_customizations ?? [],
    ) };
  } catch (error) {
    return {
      profile: input.profile,
      warning: `代码仓执行约定未采用，继续使用其余执行方案：${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Atomically project the pinned profile into the cloned repository.  The
 * directory is already excluded from delivery and the kernel protects it
 * from Agent writes.
 */
export function materializeExecutionProfile(
  workspace: string,
  profile: TaskExecutionProfile | undefined,
): string | undefined {
  if (!profile) return undefined;
  const path = join(workspace, EXECUTION_PROFILE_PATH);
  const directory = join(workspace, ".mae-flow-work");
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o440,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o440);
    return path;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Used by non-kernel analysis tasks and as a visible fallback. */
export function executionProfilePrompt(
  profile: TaskExecutionProfile | undefined,
): string {
  if (!profile || (!profile.layers.length
      && !profile.stage_customizations?.length)) return "";
  return [
    "──── 已固定的执行补充（建议层） ────",
    ...profile.layers.flatMap((layer) => [
      `【${layer.title}】`, layer.instructions,
    ]),
    ...(profile.stage_customizations ?? []).flatMap((item) => [
      `【${item.title} · ${item.playbook_id}】`,
      item.instructions ?? "",
      item.optional_activities.length
        ? `增加可选动作：${item.optional_activities.join("、")}` : "",
      item.preferred_resources.length
        ? `优先能力：${item.preferred_resources.join("、")}` : "",
    ]).filter(Boolean),
    "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
      + "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
      + "继续按平台规则执行并明确说明。",
  ].join("\n");
}
