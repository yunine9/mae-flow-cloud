/**
 * Cloud 对“任务已经结束”的本地只读核对。
 *
 * task.json 是编排投影，不是流程真相。真正能为 completed/await_merge
 * 背书的是：内核状态停在 flow 声明的 terminal 节点；若执行契约把质量
 * 动作交给流水线，还必须有绑定当前 HEAD 的逐项 PASS。这个模块故意不
 * 修改任何状态，恢复、交付、依赖解锁都可以复用同一把尺子。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSafeWorktreeGit } from "./safeGit.ts";

const PIPELINE_DIMENSIONS = {
  compile: "COMPILE",
  ut_run: "UT",
  codecheck: "CODECHECK",
} as const;

export type KernelAttestationKind =
  | "terminal"
  | "external_verify"
  | "active"
  | "invalid";

export interface KernelCompletionAttestation {
  kind: KernelAttestationKind;
  current?: string;
  /** 内核 flow 明示当前节点是 terminal。 */
  terminal: boolean;
  /** 当前任务是否有必须由权威流水线核销的质量维度。 */
  external_required: boolean;
  /** 所有外部维度是否逐项通过且绑定工作区当前 HEAD。 */
  external_passed: boolean;
  required_dimensions: string[];
  head?: string;
  reason: string;
  /** completed / await_merge / 下游解锁共同使用的最终结论。 */
  complete: boolean;
}

function readJson(path: string): any | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function declaredTerminal(kernelRoot: string | undefined, current: string): boolean {
  if (!current) return false;
  if (kernelRoot) {
    const flow = readJson(join(kernelRoot, "flow", "flow.json"));
    if (flow?.steps?.[current]?.terminal === true) return true;
    // 能读到 flow 就必须尊重它，不能让状态文件自称 end 绕过定义。
    if (flow?.steps && typeof flow.steps === "object") return false;
  }
  // 兼容随旧任务恢复时内核目录暂不可读；end 是内核长期稳定的终态 id。
  return current === "end";
}

function requiredDimensions(state: any, pipelineByDefault: boolean): string[] {
  const contract = state?.execution_contract;
  if (contract && typeof contract === "object") {
    return Object.entries(PIPELINE_DIMENSIONS)
      .filter(([key]) => String(contract[key] ?? "").toLowerCase() === "pipeline")
      .map(([, dimension]) => dimension);
  }
  // Cloud 旧单没有持久化 execution_contract；它仍然不能因为字段缺席
  // 就把编译/UT/CodeCheck 当作已做。调用方显式给出宿主默认值。
  return pipelineByDefault ? Object.values(PIPELINE_DIMENSIONS) : [];
}

function gitHead(cwd: string): string | undefined {
  try {
    const result = runSafeWorktreeGit(cwd, ["rev-parse", "HEAD"]);
    return result.status === 0
      ? String(result.stdout ?? "").trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

export function inspectKernelCompletion(
  cwd: string | undefined,
  kernelRoot: string | undefined,
  pipelineByDefault = true,
): KernelCompletionAttestation {
  if (!cwd) {
    return {
      kind: "invalid", terminal: false,
      external_required: pipelineByDefault, external_passed: false,
      required_dimensions: pipelineByDefault
        ? Object.values(PIPELINE_DIMENSIONS) : [],
      reason: "任务没有内核工作区，不能证明流程已结束",
      complete: false,
    };
  }
  const statePath = join(cwd, ".mae-flow.json");
  if (!existsSync(statePath)) {
    return {
      kind: "invalid", terminal: false,
      external_required: pipelineByDefault, external_passed: false,
      required_dimensions: pipelineByDefault
        ? Object.values(PIPELINE_DIMENSIONS) : [],
      reason: "内核状态文件不存在，流程尚未初始化",
      complete: false,
    };
  }
  const state = readJson(statePath);
  if (!state || typeof state !== "object") {
    return {
      kind: "invalid", terminal: false,
      external_required: pipelineByDefault, external_passed: false,
      required_dimensions: pipelineByDefault
        ? Object.values(PIPELINE_DIMENSIONS) : [],
      reason: "内核状态文件不可解析，不能推断终态",
      complete: false,
    };
  }
  const current = typeof state.current === "string" ? state.current : "";
  const terminal = declaredTerminal(kernelRoot, current);
  const required = requiredDimensions(state, pipelineByDefault);
  const externalRequired = required.length > 0;
  const head = externalRequired ? gitHead(cwd) : undefined;
  const record = state?.quality?.external_verification;
  const recordedRequired = new Set(
    Array.isArray(record?.required)
      ? record.required.map((value: unknown) => String(value).toUpperCase())
      : [],
  );
  const checks = record?.checks && typeof record.checks === "object"
    ? record.checks : {};
  const externalPassed = !externalRequired || (
    Boolean(head)
    && record?.verdict === "PASS"
    && record?.sha === head
    && required.every((dimension) => recordedRequired.has(dimension)
      && checks?.[dimension]?.status === "passed"
      && checks?.[dimension]?.sha === head)
  );
  const kind: KernelAttestationKind = terminal
    ? "terminal"
    : current === "external_verify"
      ? "external_verify"
      : current ? "active" : "invalid";
  let reason: string;
  if (!terminal) {
    reason = current
      ? `内核当前步骤是 ${current}，尚未到 terminal`
      : "内核 current 缺失，不能推断终态";
  } else if (!externalPassed) {
    reason = !head
      ? "无法读取工作区 HEAD，不能核对流水线版本"
      : `权威流水线尚未逐项通过并绑定 ${head.slice(0, 12)}`;
  } else {
    reason = externalRequired
      ? `内核已终态，外部质量义务 PASS@${head!.slice(0, 12)}`
      : "内核已终态，无外部质量义务";
  }
  return {
    kind,
    ...(current ? { current } : {}),
    terminal,
    external_required: externalRequired,
    external_passed: externalPassed,
    required_dimensions: required,
    ...(head ? { head } : {}),
    reason,
    complete: terminal && externalPassed,
  };
}
