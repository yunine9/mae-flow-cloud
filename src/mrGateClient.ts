import { readJson } from "./jsonBody.ts";
import type { GateItem, GateView } from "./mergeWatch.ts";

/** 错误只读取前 300 字符，响应未结束也有独立的 10 秒预算。 */
export async function readMrFailureBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    const decoder = new TextDecoder(); let text = "";
    while (text.length < 300) {
      const part = await reader.read();
      if (part.done) return (text + decoder.decode()).slice(0, 300);
      text += decoder.decode(part.value, { stream: true });
    }
    return text.slice(0, 300);
  })();
  try {
    return await Promise.race([reading, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MR 平台错误正文读取超时（10 秒）")), 10_000);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}

/** 查询指定 MR 的平台事实。监控允许缺失生命周期字段；再次交付必须
 * 严格核对。不可得仍返回 undefined，但失败原因必须交给调用方分类，
 * 不能让一次网络抖动和确定性鉴权错误都变成直接停摆。 */
export async function fetchMrGates(options: {
  platformUrl?: string;
  repo: string;
  headers: Record<string, string>;
  delivery?: { source_branch?: string; target_branch?: string;
    mr_id?: string | number; mr_url?: string };
  requireExisting?: boolean;
  log?: (error: string) => void;
  onFailure?: (reason: string) => void;
  /** 知识归档需要展示平台原文；其他调用方保留原来的失败字符串。 */
  includeFailureBody?: boolean;
}): Promise<GateView | undefined> {
  const { platformUrl, delivery, requireExisting } = options;
  const failed = (reason: string): undefined => {
    options.log?.(reason);
    options.onFailure?.(reason);
    return undefined;
  };
  if (!platformUrl || !delivery) {
    return failed("交付平台响应不完整：MR 查询缺少平台地址或交付信息");
  }
  if (!requireExisting && (!delivery.source_branch || !delivery.target_branch)) return undefined;
  try {
    const params = new URLSearchParams({ repo: options.repo,
      source_branch: delivery.source_branch ?? "",
      target_branch: delivery.target_branch ?? "" });
    // 旧现场 mr_create 曾保存全局 id，而 gate 需要项目内 iid。
    // 标准 MR 链接中的 iid 是公开定位键，优先修正这些历史记录。
    let urlIid: string | undefined;
    if (delivery.mr_url) {
      try {
        urlIid = new URL(delivery.mr_url).pathname
          .match(/\/merge_requests\/(\d+)\/?$/)?.[1];
      } catch { /* 非标准链接沿用原标识。 */ }
    }
    if (urlIid) params.set("mr", urlIid);
    else if (delivery.mr_id !== undefined) params.set("mr", String(delivery.mr_id));
    else if (delivery.mr_url) params.set("mr", delivery.mr_url);
    const response = await fetch(`${platformUrl}/mr/gates?${params}`, {
      headers: options.headers, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      if (!options.includeFailureBody) throw new Error(`HTTP ${response.status}`);
      const detail = await readMrFailureBody(response).catch(error => error instanceof Error ? error.message : String(error));
      throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    let body;
    try {
      body = await readJson(response);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return failed("交付平台响应不完整：MR 状态响应不是合法 JSON");
      }
      throw error; // Response-body timeout/disconnect is still a transport failure.
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return failed("交付平台响应不完整：MR 状态响应不是对象");
    }
    if (requireExisting && !["opened", "merged", "closed"].includes(body.mr_state)) {
      return failed("交付平台响应不完整：已有 MR 的生命周期状态缺失或无效");
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
    return failed(error instanceof Error ? error.message : String(error));
  }
}
