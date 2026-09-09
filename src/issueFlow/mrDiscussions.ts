/** CodeHub MR 检视讨论客户端(问题流,票 01 发现与落账)。
 *
 * 只做 HTTP 形状,与 mrClient/pipelineClient 同一纪律:个人身份走
 * percent 编码请求头(令牌不进请求体,身份头构造与 pipelineClient
 * 共用一份),超时预算,错误带状态码上浮。语义是 fail-open 的查询口
 * ——适配层未配置(404)/坏响应/网络失败都归 unavailable 并带原因,
 * 调用方决定等下一轮还是降级,本客户端绝不抛错打断监看。
 */

import { pipelineHeaders } from "../pipelineClient.ts";

export interface MrDiscussionItem {
  id: string;
  revision?: number;
  updated_at?: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body?: string;
}

export type MrDiscussionsFetch =
  | { kind: "available"; items: MrDiscussionItem[] }
  | { kind: "unavailable"; reason: string };

export interface MrDiscussionsCredential {
  username: string;
  password: string;
}

export async function fetchMrDiscussions(input: {
  platformUrl: string;
  repo: string;
  /** MR 标识:iid 或完整 URL,按适配层命令模板的 {mr} 占位而定。 */
  mr?: string | number;
  credential?: MrDiscussionsCredential;
  timeoutMs?: number;
}): Promise<MrDiscussionsFetch> {
  const headers = pipelineHeaders(input.credential);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
  try {
    const params = new URLSearchParams({ repo: input.repo });
    if (input.mr !== undefined) params.set("mr", String(input.mr));
    const response = await fetch(
      `${input.platformUrl.replace(/\/+$/, "")}/mr/discussions?${params}`,
      { headers, signal: controller.signal });
    if (!response.ok) {
      return { kind: "unavailable", reason: `HTTP ${response.status}` };
    }
    const body = await response.json() as { discussions?: unknown };
    const items = (Array.isArray(body.discussions) ? body.discussions : [])
      .filter((item: any) => typeof item?.id === "string" && item.id)
      .map((item: any) => ({
        id: String(item.id),
        ...(item.revision !== undefined
          && Number.isSafeInteger(Number(item.revision))
          ? { revision: Number(item.revision) } : {}),
        ...(item.updated_at !== undefined
          ? { updated_at: String(item.updated_at) } : {}),
        ...(item.file !== undefined ? { file: String(item.file) } : {}),
        ...(item.line !== undefined ? { line: Number(item.line) } : {}),
        ...(item.severity !== undefined
          ? { severity: String(item.severity) } : {}),
        ...(item.author !== undefined ? { author: String(item.author) } : {}),
        ...(item.body !== undefined ? { body: String(item.body) } : {}),
      }));
    return { kind: "available", items };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: String(error instanceof Error ? error.message : error),
    };
  } finally {
    clearTimeout(timer);
  }
}
