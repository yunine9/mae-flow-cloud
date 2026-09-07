import { readJson } from "./jsonBody.ts";
import type { GateItem, GateView } from "./mergeWatch.ts";

/** 查询指定 MR 的平台事实。监控允许缺失生命周期字段；再次交付必须
 * 严格核对。平台不可得返回 undefined，由调用方决定重试还是停止写入。 */
export async function fetchMrGates(options: {
  platformUrl?: string;
  repo: string;
  headers: Record<string, string>;
  delivery?: { source_branch?: string; target_branch?: string;
    mr_id?: string | number; mr_url?: string };
  requireExisting?: boolean;
  log?: (error: string) => void;
}): Promise<GateView | undefined> {
  const { platformUrl, delivery, requireExisting } = options;
  if (!platformUrl || !delivery
      || (!requireExisting && (!delivery.source_branch || !delivery.target_branch))) {
    return undefined;
  }
  try {
    const params = new URLSearchParams({ repo: options.repo,
      source_branch: delivery.source_branch ?? "",
      target_branch: delivery.target_branch ?? "" });
    if (delivery.mr_id !== undefined) params.set("mr", String(delivery.mr_id));
    else if (delivery.mr_url) params.set("mr", delivery.mr_url);
    const response = await fetch(`${platformUrl}/mr/gates?${params}`, {
      headers: options.headers, signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readJson(response);
    if (requireExisting && !["opened", "merged", "closed"].includes(body.mr_state)) {
      throw new Error("已有 MR 的生命周期状态缺失或无效");
    }
    const gates: GateItem[] = (Array.isArray(body.gates) ? body.gates : [])
      .filter((gate: any) => typeof gate?.name === "string"
        && typeof gate?.passed === "boolean")
      .map((gate: any) => ({ name: gate.name, passed: gate.passed,
        ...(gate.detail ? { detail: String(gate.detail) } : {}) }));
    const mrState = body.mr_state === "merged" || body.mr_state === "closed"
      ? body.mr_state : "opened";
    const sourceSha = typeof body.sha === "string" && body.sha.trim()
      ? body.sha.trim() : undefined;
    return { mrState, gates, ...(sourceSha ? { sourceSha } : {}) };
  } catch (error) {
    options.log?.(String(error));
    return undefined;
  }
}
