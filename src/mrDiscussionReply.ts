/**
 * CodeHub MR 检视回复的投递原语(需求侧与问题流共用,2026-09-16 抽取)。
 *
 * 只收"怎么发":端点形状、幂等键头、请求体契约、非 2xx 抛错。
 * 何时发、SHA 怎么绑、重试几票是两侧各自拍板的政策(需求侧持票等
 * 匹配收据,问题侧漂移即作废、超限交人工),不进这里——两边的差异
 * 是各自的设计决策,不是漂移,不许在这里悄悄统一。
 */

export interface MrDiscussionReplyRequest {
  platformUrl: string;
  /** 讨论 id,按路径段编码。 */
  discussionId: string;
  repo: string;
  body: string;
  resolve: boolean;
  /** 幂等键:同键重放不产生第二条 CodeHub 回复。 */
  idempotencyKey: string;
  mr?: string | number;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export async function postMrDiscussionReply(
  request: MrDiscussionReplyRequest,
): Promise<void> {
  const response = await fetch(
    `${request.platformUrl.replace(/\/+$/, "")}/mr/discussions/`
      + `${encodeURIComponent(request.discussionId)}/reply`, {
      method: "POST",
      ...(request.signal ? { signal: request.signal } : {}),
      headers: {
        ...request.headers,
        "content-type": "application/json",
        "Idempotency-Key": request.idempotencyKey,
      },
      body: JSON.stringify({
        repo: request.repo,
        ...(request.mr !== undefined ? { mr: request.mr } : {}),
        body: request.body,
        resolve: request.resolve,
        idempotency_key: request.idempotencyKey,
      }),
    });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
