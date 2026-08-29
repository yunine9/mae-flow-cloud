/**
 * MR 创建的公共客户端(需求交付与问题流共用)。
 *
 * 两个流程用同一格式调用同一个端点:交付平台适配层(src/
 * platformAdapter.ts)的 POST /mr——它负责真正的 codehub CLI 调用、
 * 模板占位符(含 {dts_no} → --e2e-issues 单号关联)、输出抽取与幂等。
 * 这里只做 HTTP 形状:个人身份走 percent 编码请求头(令牌不进请求体,
 * 请求体会被外部动作台账记进投影),90s 预算,错误带状态码上浮。
 */

export interface MergeRequestCredential {
  username: string;
  password: string;
}

export interface MergeRequestCall {
  platformUrl: string;
  /** 目标仓地址;缺席时适配层按自身单仓配置处理(与旧请求体一致)。 */
  repo?: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  /** 单号(REQ/DTS):适配层拿它填 CLI 的单号关联参数。 */
  dtsNo?: string;
  credential?: MergeRequestCredential;
  timeoutMs?: number;
}

export interface MergeRequestReceipt {
  url: string;
  id?: string | number;
  /** 平台返回的原始响应体。外部动作台账(主 spec §11)记的是"平台到底
   * 回了什么",恢复时要拿它对远端真实状态——抽剩 url/id 再入账等于自己
   * 把证据裁掉了,所以整体原样带出。 */
  raw: Record<string, unknown>;
}

export async function createMergeRequest(
  call: MergeRequestCall,
): Promise<MergeRequestReceipt> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (call.credential) {
    headers["x-mfc-git-user"] = encodeURIComponent(call.credential.username);
    headers["x-mfc-git-token"] = encodeURIComponent(call.credential.password);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 90_000);
  try {
    const response = await fetch(`${call.platformUrl.replace(/\/+$/, "")}/mr`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(call.repo ? { repo: call.repo } : {}),
        source_branch: call.sourceBranch,
        target_branch: call.targetBranch,
        title: call.title,
        ...(call.dtsNo ? { dts_no: call.dtsNo } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MR 创建失败 HTTP ${response.status}`
        + (text ? `: ${text.slice(0, 300)}` : ""));
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const url = String(body.url ?? "");
    if (!url) {
      throw new Error(`平台返回里没有 MR 链接(url): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return {
      url,
      ...(body.id !== undefined && body.id !== null && body.id !== ""
        ? { id: body.id as string | number } : {}),
      raw: body,
    };
  } finally {
    clearTimeout(timer);
  }
}
