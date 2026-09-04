/**
 * 流水线的公共客户端(需求交付与问题流共用)。
 *
 * 与 mrClient.ts 同一纪律:两流程用同一格式调适配层(src/
 * platformAdapter.ts)的流水线端点——POST /pipeline/trigger(触发,
 * 假件必须显式触发,真件幂等无害)与 GET /pipeline/status(按 SHA
 * 查运行记录)。这里只做 HTTP 形状:个人身份走 percent 编码请求头
 * (令牌不进 URL——URL 会进日志),响应过 parsePipelineChecks 才算
 * 逐项质量事实,畸形输入整体按"没有证据"处理,不拿总体绿灯补猜。
 *
 * 需求侧 taskService 的既有内联 fetch 本期不迁移过来(行为微差:
 * 那边不查 response.ok 也不设超时),避免无谓回归面;新调用方一律
 * 用本客户端。
 */

import {
  parsePipelineChecks,
  type PipelineCheck,
} from "./pipelineContract.ts";

export interface PipelineCredential {
  username: string;
  password: string;
}

export interface PipelineCallBase {
  platformUrl: string;
  /** 目标仓地址;缺席时适配层按自身单仓配置处理。 */
  repo?: string;
  /** MR 内部 id(iid)。适配层的状态命令模板可能引用 {mr} 按单过滤:
   * 缺了它模板渲染失败(真实环境 502 实测)。知道就传,别让模板空转。 */
  mr?: string;
  credential?: PipelineCredential;
  timeoutMs?: number;
}

/** 触发一次流水线(对指定提交跑编译/UT/代码检查)。 */
export interface TriggerPipelineCall extends PipelineCallBase {
  sha: string;
}

export interface PipelineRun {
  status: "success" | "failed" | "running";
  log?: string;
  checks?: PipelineCheck[];
  /** 适配层回传的 run 归属(陈灯防御的判断依据):sha=该 run 绑定的
   * 提交;is_valid=false=MR 头上挂的陈灯。缺席=旧适配层/旧配置,
   * 下游按无陈灯信息处理(行为与透传前一致)。 */
  sha?: string;
  is_valid?: boolean;
}

export interface PipelineStatus extends PipelineRun {
  /** 查询命中的 run 记录(按 SHA 精确匹配,同体里的原样形状)。 */
  runs: PipelineRun[];
}

const CONTRACT_STATUS = new Set(["success", "failed", "running"]);

function pipelineHeaders(
  credential: PipelineCredential | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (credential) {
    headers["x-mfc-git-user"] = encodeURIComponent(credential.username);
    headers["x-mfc-git-token"] = encodeURIComponent(credential.password);
  }
  return headers;
}

async function pipelineFetch(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  what: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${what}失败 HTTP ${response.status}`
        + (text ? `: ${text.slice(0, 300)}` : ""));
    }
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** 契约状态校验:适配层对不认识的状态约定 502 拒猜,这里同样不猜。 */
function contractStatus(raw: unknown, what: string): PipelineRun["status"] {
  const status = String(raw ?? "");
  if (!CONTRACT_STATUS.has(status)) {
    throw new Error(`${what}返回未知状态: ${status || "(empty)"}`);
  }
  return status as PipelineRun["status"];
}

/** 触发流水线。返回可能是终态(假件当场出结果)也可能 running。 */
export async function triggerPipeline(
  call: TriggerPipelineCall,
): Promise<PipelineRun> {
  const base = call.platformUrl.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    ...pipelineHeaders(call.credential),
  };
  const body = await pipelineFetch(
    `${base}/pipeline/trigger`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        sha: call.sha,
        ...(call.repo ? { repo: call.repo } : {}),
      }),
    },
    call.timeoutMs ?? 30_000,
    "流水线触发",
  );
  const status = contractStatus(body.status, "流水线触发");
  const checks = parsePipelineChecks(body.checks);
  return {
    status,
    ...(typeof body.log === "string" && body.log
      ? { log: body.log } : {}),
    ...(typeof body.sha === "string" && body.sha
      ? { sha: body.sha } : {}),
    ...(typeof body.is_valid === "boolean"
      ? { is_valid: body.is_valid } : {}),
    ...(checks !== undefined ? { checks } : {}),
  };
}

/** 按 SHA 查流水线状态。SHA 精确匹配——旧绿灯不背书新提交。 */
export async function getPipelineStatus(
  call: PipelineCallBase & { sha: string },
): Promise<PipelineStatus> {
  const base = call.platformUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ sha: call.sha });
  if (call.repo) query.set("repo", call.repo);
  if (call.mr) query.set("mr", call.mr);
  const body = await pipelineFetch(
    `${base}/pipeline/status?${query.toString()}`,
    { method: "GET", headers: pipelineHeaders(call.credential) },
    call.timeoutMs ?? 30_000,
    "流水线状态查询",
  );
  const runsRaw = Array.isArray(body.runs) ? body.runs : [];
  const runs: PipelineRun[] = [];
  for (const raw of runsRaw) {
    if (!raw || typeof raw !== "object") continue;
    const run = raw as Record<string, unknown>;
    const status = contractStatus(run.status, "流水线状态");
    const checks = parsePipelineChecks(run.checks);
    runs.push({
      status,
      ...(typeof run.log === "string" && run.log
        ? { log: run.log } : {}),
      ...(checks !== undefined ? { checks } : {}),
      ...(typeof run.sha === "string" && run.sha
        ? { sha: run.sha } : {}),
      ...(typeof run.is_valid === "boolean"
        ? { is_valid: run.is_valid } : {}),
    });
  }
  // 顶层字段(单 run 形态)与 runs 数组并存时以 runs 为准;顶层只在
  // runs 缺席时兜底,避免适配层两种回形造成语义分叉。
  if (runs.length === 0 && body.status !== undefined) {
    const status = contractStatus(body.status, "流水线状态");
    const checks = parsePipelineChecks(body.checks);
    return {
      status,
      runs: [{
        status,
        ...(typeof body.log === "string" && body.log
          ? { log: body.log } : {}),
        ...(checks !== undefined ? { checks } : {}),
        ...(typeof body.sha === "string" && body.sha
          ? { sha: body.sha } : {}),
        ...(typeof body.is_valid === "boolean"
          ? { is_valid: body.is_valid } : {}),
      }],
    };
  }
  const last = runs.at(-1);
  return {
    status: last?.status ?? "running",
    runs,
    ...(last?.checks !== undefined ? { checks: last.checks } : {}),
  };
}

/** 给"喂给 AI 的失败摘要"用的格式化:红项逐条列出,绿项一句带过。 */
export function describePipelineRun(run: PipelineRun): string {
  const lines = [`流水线状态: ${run.status}`];
  if (run.log) lines.push(`日志(截断): ${run.log.slice(0, 1_500)}`);
  if (run.checks?.length) {
    for (const check of run.checks) {
      lines.push(`- ${check.dimension} ${check.status}`
        + (check.url ? ` (${check.url})` : ""));
    }
  }
  return lines.join("\n");
}
