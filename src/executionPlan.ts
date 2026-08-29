/**
 * Read the kernel's explanation contract without copying workflow semantics.
 *
 * The command is deliberately read-only.  Old kernels and non-kernel tasks
 * simply return no plan; Cloud never invents a second mapping as a fallback.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ExecutionPlanActivity {
  id: string;
  title: string;
  description: string;
  required: boolean;
  source?: "platform_default" | "customized";
}

export interface ExecutionPlanResource {
  id: string;
  kind: "guidance" | "standard" | "agent" | "platform" | "knowledge"
    | "skill" | "tool";
  name: string;
  ref?: string;
  usage: "required" | "when_needed" | "on_demand";
  preferred?: boolean;
}

export interface ExecutionPlaybookOption {
  id: string;
  version: string;
  title: string;
  summary: string;
  phase: string;
  activities: ExecutionPlanActivity[];
  resources: ExecutionPlanResource[];
}

export interface ExecutionPlan {
  schema: "mae-flow-execution-plan/1";
  plan_id: string;
  plan_revision: string;
  step: {
    id: string;
    title: string;
    phase: string;
    state_revision?: number;
  };
  strategy: {
    id: string;
    version: string;
    title: string;
    summary: string;
    source: "platform_default";
    selection_reason: string;
  };
  contract: {
    human_decision: boolean;
    evidence: Array<{ type: string; label: string }>;
    outputs: string[];
  };
  activities: ExecutionPlanActivity[];
  resources: ExecutionPlanResource[];
  knowledge: {
    loading: "indexed_on_demand";
    explanation: string;
  };
  customization: {
    mode: "bounded";
    customizable: string[];
    locked: string[];
    effective_source: "platform_default" | "platform_default+overrides";
    profile_revision?: string;
    layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      instructions: string;
    }>;
    stage_layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      playbook_id: string;
      instructions?: string;
      optional_activities: string[];
      preferred_resources: string[];
    }>;
  };
}

interface CacheEntry {
  fingerprint: string;
  value?: ExecutionPlan;
}

const cache = new Map<string, CacheEntry>();

function fingerprint(kernelRoot: string, workspace: string): string {
  return [
    join(workspace, ".mae-flow.json"),
    join(workspace, ".mae-flow-work", "execution-profile.json"),
    join(kernelRoot, "flow", "flow.json"),
    join(kernelRoot, "flow", "playbooks.json"),
  ].map((path) => {
    try {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path}:missing`;
    }
  }).join("\0");
}

function validPlan(value: unknown): value is ExecutionPlan {
  const plan = value as Partial<ExecutionPlan> | undefined;
  return plan?.schema === "mae-flow-execution-plan/1"
    && typeof plan.plan_id === "string"
    && typeof plan.plan_revision === "string"
    && typeof plan.step?.id === "string"
    && typeof plan.step?.title === "string"
    && typeof plan.strategy?.title === "string"
    && typeof plan.strategy?.version === "string"
    && Array.isArray(plan.activities)
    && Array.isArray(plan.resources)
    && Array.isArray(plan.contract?.evidence)
    && Array.isArray(plan.contract?.outputs)
    && Array.isArray(plan.customization?.locked)
    && (plan.customization?.layers === undefined
      || Array.isArray(plan.customization.layers));
}

export function readCurrentExecutionPlan(options: {
  kernelRoot?: string;
  workspace?: string;
  python?: string;
}): ExecutionPlan | undefined {
  const { kernelRoot, workspace } = options;
  if (!kernelRoot || !workspace) return undefined;
  const script = join(kernelRoot, "scripts", "mae-flow.py");
  const state = join(workspace, ".mae-flow.json");
  if (!existsSync(script) || !existsSync(state)) return undefined;
  const key = `${kernelRoot}\0${workspace}`;
  const currentFingerprint = fingerprint(kernelRoot, workspace);
  const cached = cache.get(key);
  if (cached?.fingerprint === currentFingerprint) return cached.value;

  let value: ExecutionPlan | undefined;
  try {
    const output = execFileSync(
      options.python ?? "python3",
      [script, "execution-plan", "--json"],
      {
        cwd: workspace,
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
    if (validPlan(parsed)) {
      value = {
        ...parsed,
        customization: {
          ...parsed.customization,
          layers: parsed.customization.layers ?? [],
          stage_layers: parsed.customization.stage_layers ?? [],
        },
      };
    }
  } catch {
    // 旧内核没有命令、状态正在原子替换或只读投影超时：不影响任务。
  }
  cache.set(key, { fingerprint: currentFingerprint, value });
  return value;
}

export function clearExecutionPlanCache(): void {
  cache.clear();
}

/** The launch/settings UI reads the same versioned catalog that the kernel
 * compiles.  Failure returns an empty catalog: the UI then offers no invented
 * customization, while the fixed workflow remains usable. */
export function readExecutionPlaybookOptions(
  kernelRoot: string | undefined,
): ExecutionPlaybookOption[] {
  if (!kernelRoot) return [];
  try {
    const value = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "playbooks.json"), "utf-8")) as {
        schema?: string;
        playbooks?: Array<Record<string, unknown>>;
      };
    if (value.schema !== "mae-flow-playbook-catalog/1"
        || !Array.isArray(value.playbooks)) return [];
    const parsed = value.playbooks.flatMap((raw) => {
      const id = String(raw.id ?? "").trim();
      const version = String(raw.version ?? "").trim();
      const title = String(raw.title ?? "").trim();
      const summary = String(raw.summary ?? "").trim();
      const phase = String(raw.phase ?? "").trim();
      if (!id || !version || !title || !summary || !phase) return [];
      const rawActivities = Array.isArray(raw.activities) ? raw.activities : [];
      const activities = rawActivities.flatMap((item) => {
            const activity = item as Record<string, unknown>;
            const activityId = String(activity.id ?? "").trim();
            const activityTitle = String(activity.title ?? "").trim();
            const description = String(activity.description ?? "").trim();
            if (!activityId || !activityTitle || !description) return [];
            return [{
              id: activityId,
              title: activityTitle,
              description,
              required: activity.required === true,
            }];
          });
      if (activities.length !== rawActivities.length) return [];
      const rawResources = Array.isArray(raw.resources) ? raw.resources : [];
      const resources = rawResources.flatMap((item) => {
            const resource = item as Record<string, unknown>;
            const resourceId = String(resource.id ?? "").trim();
            const name = String(resource.name ?? "").trim();
            const kind = String(resource.kind ?? "") as ExecutionPlanResource["kind"];
            const usage = String(resource.usage ?? "") as ExecutionPlanResource["usage"];
            if (!resourceId || !name
                || !["guidance", "standard", "agent", "platform", "knowledge",
                  "skill", "tool"].includes(kind)
                || !["required", "when_needed", "on_demand"].includes(usage)) {
              return [];
            }
            return [{
              id: resourceId,
              kind,
              name,
              ...(resource.ref ? { ref: String(resource.ref) } : {}),
              usage,
            }];
          });
      if (resources.length !== rawResources.length) return [];
      return [{ id, version, title, summary, phase, activities, resources }];
    });
    return parsed.length === value.playbooks.length ? parsed : [];
  } catch {
    return [];
  }
}
