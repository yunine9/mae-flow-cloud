/** Trusted Cloud adapter for Mae-Flow's continuous-review delivery commands. */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createSafeGitView } from "./safeGit.ts";

export interface KernelDeliveryHost {
  kernelRoot: string;
  python?: string;
}

export interface KernelFeedbackItem {
  id: string;
  source: string;
  source_id: string;
  source_revision: number;
  kind: string;
  summary: string;
  material?: string;
  verification: string;
  file?: string;
  line?: number;
}

export interface KernelFeedbackBatch {
  schema: "mae-flow-feedback-batch/1";
  batch_id: string;
  task_id: string;
  base_sha: string;
  opened_at: string;
  items: KernelFeedbackItem[];
}

export interface KernelDeliveryRecord {
  schema: "mae-flow-delivery-loop/1";
  idempotent: boolean;
  current?: string;
  batch_id?: string;
  migration_id?: string;
  status?: string;
  event_id?: string;
  sha?: string;
}

export interface KernelFeedbackResultItem {
  id: string;
  status: "fixed" | "explained" | "needs_human" | "not_applicable";
  summary: string;
  evidence?: string;
}

export class KernelDeliveryError extends Error {}

function factsPath(workspace: string, label: string, payload: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  const dir = join(workspace, "kernel-delivery");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${label}-${digest}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function invoke(input: {
  host: KernelDeliveryHost;
  cwd: string;
  args: string[];
}): KernelDeliveryRecord {
  const gitView = createSafeGitView(input.cwd);
  try {
    const result = spawnSync(
      input.host.python ?? "python3",
      [join(input.host.kernelRoot, "scripts", "mae-flow.py"),
       "delivery", ...input.args],
      {
        cwd: input.cwd,
        encoding: "utf-8",
        env: gitView.environment(),
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    let record: KernelDeliveryRecord | undefined;
    try { record = JSON.parse(line) as KernelDeliveryRecord; } catch { /* below */ }
    if (result.error || result.status !== 0
        || record?.schema !== "mae-flow-delivery-loop/1") {
      const detail = [result.error?.message, stderr, stdout]
        .filter(Boolean).join("\n").trim();
      throw new KernelDeliveryError(
        `内核持续检视命令失败：${detail || "没有返回结构化结果"}`);
    }
    return record;
  } finally {
    gitView.cleanup();
  }
}

export function openKernelFeedback(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  batch: KernelFeedbackBatch;
}): KernelDeliveryRecord {
  const path = factsPath(input.workspace, "feedback-open", input.batch);
  return invoke({
    host: input.host, cwd: input.cwd,
    args: ["feedback-open", "--file", path],
  });
}

export function adoptKernelDeliveryWatch(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  migrationId: string;
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-batch/1",
    mode: "adopt-watch",
    batch_id: input.migrationId,
  };
  const path = factsPath(input.workspace, "adopt-watch", payload);
  return invoke({
    host: input.host, cwd: input.cwd,
    args: ["feedback-open", "--file", path],
  });
}

export function recordKernelFeedbackResult(input: {
  host: KernelDeliveryHost;
  cwd: string;
  workspace: string;
  batchId: string;
  changed: boolean;
  results: KernelFeedbackResultItem[];
}): KernelDeliveryRecord {
  const payload = {
    schema: "mae-flow-feedback-result/1",
    batch_id: input.batchId,
    changed: input.changed,
    results: input.results,
  };
  const path = factsPath(input.workspace, "feedback-result", payload);
  return invoke({
    host: input.host, cwd: input.cwd,
    args: ["feedback-result", "--file", path],
  });
}

export function closeKernelDelivery(input: {
  host: KernelDeliveryHost;
  cwd: string;
  sha: string;
  eventId: string;
}): KernelDeliveryRecord {
  return invoke({
    host: input.host, cwd: input.cwd,
    args: ["close", "--reason", "merged", "--sha", input.sha,
      "--event-id", input.eventId],
  });
}
