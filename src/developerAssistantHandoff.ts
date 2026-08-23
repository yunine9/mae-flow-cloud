/**
 * Developer-assistant/core hand-off contract.
 *
 * The assistant remains a Cloud sidecar: it never receives KernelHost hooks.
 * This module only answers two mechanical questions at the boundary:
 *
 * 1. Does the current Mae-Flow step explicitly allow general source edits?
 * 2. What changed in the worktree while the main session was paused?
 *
 * It deliberately does not invent transitions or mark any core evidence PASS.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runSafeWorktreeGit } from "./safeGit.ts";

export type DeveloperAssistantAvailabilityCode =
  | "edit_window"
  | "approval_pending"
  | "tests_only"
  | "host_wait"
  | "not_editable"
  | "core_unavailable"
  | "session_only";

export interface DeveloperAssistantCoreCheckpoint {
  step: string;
  title?: string;
  revision?: number;
  approval_subject_id?: string;
}

export interface DeveloperAssistantAvailability {
  available: boolean;
  code: DeveloperAssistantAvailabilityCode;
  mode: "edit" | "unavailable";
  reason: string;
  core?: DeveloperAssistantCoreCheckpoint;
}

export interface DeveloperAssistantWorktreeCheckpoint {
  sha: string;
  fingerprint: string;
  paths: string[];
  path_fingerprints: Record<string, string>;
}

export interface DeveloperAssistantHandoff {
  state: "running" | "unchanged" | "changed" | "returned" | "blocked";
  started_at: string;
  finished_at?: string;
  returned_at?: string;
  core?: DeveloperAssistantCoreCheckpoint;
  initial: DeveloperAssistantWorktreeCheckpoint;
  current?: DeveloperAssistantWorktreeCheckpoint;
  changed_paths?: string[];
  message: string;
}

const CONTROL_PATHSPECS = [
  ":(exclude).mae-flow.json",
  ":(exclude).mae-flow.json.*",
  ":(exclude).mae-flow-*",
  ":(exclude).mae-flow-work",
  ":(exclude).mae-flow-work/**",
  ":(exclude).codecheckcli",
  ":(exclude).codecheckcli/**",
] as const;

function readNoFollowJson(path: string): Record<string, unknown> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(readFileSync(descriptor, "utf-8")) as Record<string, unknown>;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function coreCheckpoint(
  state: Record<string, unknown>,
  step: string,
  title?: string,
): DeveloperAssistantCoreCheckpoint {
  const revision = Number(state.revision);
  const approval = state.approval_subject;
  const approvalId = approval && typeof approval === "object"
    ? String((approval as Record<string, unknown>).id ?? "").trim() : "";
  return {
    step,
    ...(title ? { title } : {}),
    ...(Number.isFinite(revision) ? { revision } : {}),
    ...(approvalId ? { approval_subject_id: approvalId } : {}),
  };
}

/** Read-only compatibility check. Missing host means a scripted/session-only task. */
export function inspectDeveloperAssistantAvailability(
  cwd: string | undefined,
  kernelRoot: string | undefined,
): DeveloperAssistantAvailability {
  if (!kernelRoot) {
    return {
      available: true,
      code: "session_only",
      mode: "edit",
      reason: "当前任务不使用 Mae-Flow 内核，可直接处理代码现场",
    };
  }
  if (!cwd) {
    return {
      available: false,
      code: "core_unavailable",
      mode: "unavailable",
      reason: "代码现场尚未就绪，暂不能启动开发助手",
    };
  }
  try {
    const statePath = join(cwd, ".mae-flow.json");
    if (!existsSync(statePath)) throw new Error("流程尚未初始化");
    const state = readNoFollowJson(statePath);
    const stepId = String(state.current ?? "").trim();
    if (!stepId) throw new Error("内核没有给出当前步骤");
    const flow = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "flow.json"), "utf-8")) as {
        steps?: Record<string, Record<string, unknown>>;
      };
    const step = flow.steps?.[stepId];
    if (!step) throw new Error(`内核步骤 ${stepId} 不在流程定义中`);
    const title = String(step.title ?? "").trim() || undefined;
    const core = coreCheckpoint(state, stepId, title);
    if (step.user_ack || step.approval_subject) {
      return {
        available: false,
        code: "approval_pending",
        mode: "unavailable",
        core,
        reason: `当前正在「${title ?? stepId}」等待检视；如需改代码，请先选择“需要调整”进入返工阶段`,
      };
    }
    if (step.tests_only) {
      return {
        available: false,
        code: "tests_only",
        mode: "unavailable",
        core,
        reason: `当前「${title ?? stepId}」只允许测试范围修改，通用开发助手可能越界，请先交由主任务完成该步骤`,
      };
    }
    if (step.host_wait) {
      return {
        available: false,
        code: "host_wait",
        mode: "unavailable",
        core,
        reason: `当前「${title ?? stepId}」由宿主等待外部结果，不开放旁路修改`,
      };
    }
    if (step.allow_source_edit === true) {
      return {
        available: true,
        code: "edit_window",
        mode: "edit",
        core,
        reason: `当前「${title ?? stepId}」允许修改源码，助手完成后会把现场交还主任务`,
      };
    }
    return {
      available: false,
      code: "not_editable",
      mode: "unavailable",
      core,
      reason: `当前「${title ?? stepId}」不是源码修改阶段，请先让主任务推进到可修改步骤`,
    };
  } catch (error) {
    return {
      available: false,
      code: "core_unavailable",
      mode: "unavailable",
      reason: `无法确认内核修改边界，已安全停用开发助手：${String(error)}`,
    };
  }
}

function gitOutput(cwd: string, args: string[], label: string): string {
  const result = runSafeWorktreeGit(cwd, args);
  if (result.status !== 0) {
    throw new Error(`${label}失败：${String(result.stderr ?? "").trim()}`);
  }
  return String(result.stdout ?? "");
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function fingerprintPath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  if (!contained(root, absolute) || !existsSync(absolute)) return "missing";
  const info = lstatSync(absolute);
  const hash = createHash("sha256")
    .update(String(info.mode)).update("\0").update(String(info.size)).update("\0");
  if (info.isSymbolicLink()) {
    return hash.update("symlink\0").update(readlinkSync(absolute)).digest("hex");
  }
  if (!info.isFile()) return hash.update("other").digest("hex");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const size = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function splitZero(text: string): string[] {
  return text.split("\0").map((item) => item.trim()).filter(Boolean);
}

/** Exact-enough content snapshot for hand-off, not a quality/approval receipt. */
export function captureDeveloperAssistantWorktree(
  cwd: string,
): DeveloperAssistantWorktreeCheckpoint {
  const root = resolve(cwd);
  const sha = gitOutput(root, ["rev-parse", "--verify", "HEAD"], "读取 HEAD").trim();
  const pathspec = ["--", ".", ...CONTROL_PATHSPECS];
  const diff = gitOutput(root,
    ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspec], "读取代码差异");
  const status = gitOutput(root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec],
    "读取工作区状态");
  const tracked = splitZero(gitOutput(root,
    ["diff", "--name-only", "-z", "HEAD", ...pathspec], "读取变更文件"));
  const untracked = splitZero(gitOutput(root,
    ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
    "读取新文件"));
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const pathFingerprints = Object.fromEntries(paths.map((path) =>
    [path, fingerprintPath(root, path)]));
  const fingerprint = createHash("sha256")
    .update(sha).update("\0").update(diff).update("\0").update(status)
    .update("\0").update(JSON.stringify(pathFingerprints)).digest("hex");
  return {
    sha,
    fingerprint,
    paths,
    path_fingerprints: pathFingerprints,
  };
}

function sameCore(
  left: DeveloperAssistantCoreCheckpoint | undefined,
  right: DeveloperAssistantCoreCheckpoint | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.step === right.step && left.revision === right.revision
    && left.approval_subject_id === right.approval_subject_id;
}

export function beginDeveloperAssistantHandoff(
  previous: DeveloperAssistantHandoff | undefined,
  availability: DeveloperAssistantAvailability,
  worktree: DeveloperAssistantWorktreeCheckpoint,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  if (previous && previous.state !== "returned"
      && sameCore(previous.core, availability.core)) {
    return {
      ...previous,
      state: "running",
      current: undefined,
      finished_at: undefined,
      changed_paths: undefined,
      message: "开发助手正在处理，主任务继续保持暂停",
    };
  }
  return {
    state: "running",
    started_at: at,
    core: availability.core,
    initial: worktree,
    message: "已冻结交还起点，开发助手正在处理",
  };
}

export function finishDeveloperAssistantHandoff(
  handoff: DeveloperAssistantHandoff,
  current: DeveloperAssistantWorktreeCheckpoint,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  if (handoff.initial.sha !== current.sha) {
    return {
      ...handoff,
      state: "blocked",
      current,
      finished_at: at,
      changed_paths: [...new Set([
        ...handoff.initial.paths, ...current.paths,
      ])].sort(),
      message: "开发助手运行期间 Git HEAD 发生变化；平台已阻止直接交还，避免绕过主流程提交边界",
    };
  }
  const candidates = new Set([
    ...Object.keys(handoff.initial.path_fingerprints),
    ...Object.keys(current.path_fingerprints),
  ]);
  let changedPaths = [...candidates].filter((path) =>
    handoff.initial.path_fingerprints[path]
      !== current.path_fingerprints[path]).sort();
  const changed = handoff.initial.fingerprint !== current.fingerprint;
  if (changed && changedPaths.length === 0) {
    changedPaths = [...new Set([
      ...handoff.initial.paths, ...current.paths,
    ])].sort();
  }
  return {
    ...handoff,
    state: changed ? "changed" : "unchanged",
    current,
    finished_at: at,
    changed_paths: changedPaths,
    message: changed
      ? `助手修改了 ${changedPaths.length || "若干"} 个文件；交还后主任务会收到完整现场摘要`
      : "助手没有改变业务代码，可直接交还主任务",
  };
}

export function handoffCoreStillMatches(
  handoff: DeveloperAssistantHandoff,
  availability: DeveloperAssistantAvailability,
): boolean {
  return sameCore(handoff.core, availability.core);
}

export function markDeveloperAssistantReturned(
  handoff: DeveloperAssistantHandoff,
  at = new Date().toISOString(),
): DeveloperAssistantHandoff {
  return {
    ...handoff,
    state: "returned",
    returned_at: at,
    message: handoff.state === "changed"
      ? "现场摘要已交给主任务，主任务将从原内核步骤继续"
      : "已交还主任务",
  };
}
