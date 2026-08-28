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

export interface TaskExecutionProfile {
  schema: typeof EXECUTION_PROFILE_SCHEMA;
  revision: string;
  layers: ExecutionProfileLayer[];
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

function profileRevision(layers: ExecutionProfileLayer[]): string {
  const payload = layers.map((layer) => [
    layer.scope,
    layer.source_id,
    layer.title,
    layer.instructions,
  ].join("\0")).join("\n");
  return createHash("sha256").update(payload, "utf-8")
    .digest("hex").slice(0, 16);
}

export function buildTaskExecutionProfile(
  taskId: string,
  instructions: string | undefined,
  teamInstructions?: string,
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
  if (!layers.length) return undefined;
  return {
    schema: EXECUTION_PROFILE_SCHEMA,
    revision: profileRevision(layers),
    layers,
  };
}

function profileFromLayers(
  layers: ExecutionProfileLayer[],
): TaskExecutionProfile | undefined {
  if (!layers.length) return undefined;
  const ordered = layers.map((layer) => ({ ...layer }))
    .sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope]);
  return {
    schema: EXECUTION_PROFILE_SCHEMA,
    revision: profileRevision(ordered),
    layers: ordered,
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
    return { profile: profileFromLayers(layers) };
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
  if (!profile?.layers.length) return "";
  return [
    "──── 已固定的执行补充（建议层） ────",
    ...profile.layers.flatMap((layer) => [
      `【${layer.title}】`, layer.instructions,
    ]),
    "边界：这些补充只调整关注点、执行顺序和协作方式；若与当前阶段指令、"
      + "真实证据、人工决定或 Git/写入/交付权限冲突，冲突部分无效，"
      + "继续按平台规则执行并明确说明。",
  ].join("\n");
}
