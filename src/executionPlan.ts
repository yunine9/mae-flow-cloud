/**
 * Read the kernel's explanation contract without copying workflow semantics.
 *
 * The command is deliberately read-only.  Old kernels and non-kernel tasks
 * simply return no plan; Cloud never invents a second mapping as a fallback.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ExecutionPlanActivity {
  title: string;
  description: string;
  required: boolean;
}

export interface ExecutionPlanResource {
  kind: "guidance" | "standard" | "agent" | "platform" | "knowledge"
    | "skill" | "tool";
  name: string;
  ref?: string;
  usage: "required" | "when_needed" | "on_demand";
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
