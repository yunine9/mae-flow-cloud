/** Task-pinned structural workflow profile projection and prompt fallback. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { compileWorkflow } from "./workflowCompiler.ts";
import type {
  WorkflowDefinition,
  WorkflowExecutionProfileV2,
  WorkflowPlanItem,
  WorkflowResolvedAsset,
} from "./workflowDefinition.ts";
import { WORKFLOW_DEFINITION_SCHEMA } from "./workflowDefinition.ts";

export const WORKFLOW_PROFILE_PATH = join(
  ".mae-flow-work", "workflow-profile.json");

/**
 * 创建时固定的是不可变资产身份；每次会话启动仍要对拍实际投影结果。
 * 单篇正文损坏时，只把对应资产标为不可用并重新编译那一项，替换操作
 * 会恢复 base item，其他有效定制和平台流程继续。
 */
export function reconcileWorkflowProfileAssets(
  profile: WorkflowExecutionProfileV2 | undefined,
  materializedPaths: Iterable<string>,
): WorkflowExecutionProfileV2 | undefined {
  if (!profile) return undefined;
  const available = new Set([...materializedPaths]
    .map((path) => path.replaceAll("\\", "/")));
  let changed = false;
  const resolved = profile.asset_manifest.map((asset) => {
    const path = asset.snapshot_path?.replaceAll("\\", "/");
    if (asset.state !== "available" || !path || available.has(path)) {
      return { ...asset };
    }
    changed = true;
    return {
      ...asset,
      state: "unavailable" as const,
      diagnostic: `${asset.registry}:${asset.id}@${asset.version} 的任务固定正文未能投影`,
    };
  });
  if (!changed) return profile;
  const definition: WorkflowDefinition = {
    schema: WORKFLOW_DEFINITION_SCHEMA,
    base: {
      standard_id: profile.base_snapshot.standard_id,
      standard_version: profile.base_snapshot.standard_version,
      catalog_digest: profile.base_snapshot.catalog_digest,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies: [],
    },
    edits: structuredClone(profile.edits),
  };
  return compileWorkflow({
    baseSnapshot: profile.base_snapshot,
    definition,
    source: profile.source,
    resolvedAssets: resolved,
  });
}

function resolvedAsset(
  profile: WorkflowExecutionProfileV2,
  item: WorkflowPlanItem,
): WorkflowResolvedAsset | undefined {
  const ref = item.asset_ref;
  if (!ref) return undefined;
  return profile.asset_manifest.find((asset) =>
    asset.registry === ref.registry && asset.id === ref.id
    && asset.version === ref.version && asset.digest === ref.digest
    && asset.business_module_id === ref.business_module_id
    && asset.repository === ref.repository
    && asset.revision === ref.revision
    && asset.relative_path === ref.relative_path);
}

function itemPrompt(
  profile: WorkflowExecutionProfileV2,
  item: WorkflowPlanItem,
  index: number,
): string {
  const asset = resolvedAsset(profile, item);
  const details = [item.instructions];
  if (asset?.snapshot_path) {
    details.push(`正文按需读取：${asset.snapshot_path}`);
  } else if (asset && ["team_skill", "repository_skill"]
      .includes(asset.registry)) {
    details.push(`固定 Skill：${asset.id}@${asset.version}（从任务 Skill 索引读取）`);
  }
  return `${index + 1}. ${item.title}${details.filter(Boolean).length
    ? `（${details.filter(Boolean).join("；")}）` : ""}`;
}

export function materializeWorkflowProfile(
  workspace: string,
  profile: WorkflowExecutionProfileV2 | undefined,
): string | undefined {
  if (!profile) return undefined;
  const path = join(workspace, WORKFLOW_PROFILE_PATH);
  const directory = join(workspace, ".mae-flow-work");
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o440,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o440);
    return path;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** 仅在非内核任务或现场文件投影失败时使用；不把资产正文灌入上下文。 */
export function workflowProfilePrompt(
  profile: WorkflowExecutionProfileV2 | undefined,
): string {
  if (!profile) return "";
  const source = profile.source.kind === "platform"
    ? "平台标准方案"
    : `${profile.source.kind === "workflow" ? "工作流" : "本任务定制"}`
      + ` ${profile.source.id}${profile.source.version
        ? `@${profile.source.version}` : ""}`;
  const lines = [
    `──── 已固定的最终执行方案（${source}） ────`,
    ...profile.final_snapshot.stages.flatMap((stage) => [
      `【${stage.phase} · ${stage.title}】`,
      stage.items.length
        ? stage.items.map((item, index) =>
            itemPrompt(profile, item, index)).join("\n")
        : "采用该阶段内核合同，不额外指定做法。",
    ]),
  ];
  if (profile.diagnostics.length) {
    lines.push("已明确降级：", ...profile.diagnostics.map((item) =>
      `- ${item.message}${item.fallback ? `；${item.fallback}` : ""}`));
  }
  lines.push(
    "边界：这里只描述阶段内采用的做法；阶段、退出条件、真实证据、"
      + "人工决定以及 Git/写入/交付权限仍以平台内核为准。",
  );
  return lines.join("\n");
}
