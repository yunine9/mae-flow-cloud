/**
 * 模型网关连通性测试(管理页「测试连通」的后半边)。
 *
 * 一次 POST 同时回答两件事:
 * 1. 网络连通——网关可解析、可建连、TLS 正常(收到任何 HTTP 状态码即算通,
 *    拒连/超时/DNS/证书按原因分类报给人);
 * 2. 模型问答——与生产同款的 Anthropic Messages 请求(pi 走官方 SDK,
 *    同一发 x-api-key + /v1/messages),验证 200 且回复非空,并区分
 *    密钥错/路径错/模型名错/限流/网关 5xx/空回复。
 *
 * 刻意不引新依赖:pi-ai 只是传递依赖,直接 import 它是拿解析器赌博;
 * 裸 fetch 复刻线上流量,诊断粒度(HTTP 状态码原文)反而更细。
 */

import type {
  SystemCheckItem,
  SystemCheckResult,
  SystemCheckStatus,
} from "./taskService.ts";
import type { ModelsSettings } from "./settings.ts";

export class GatewayCheckError extends Error {}

export interface GatewayTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 表单草稿 > 管理页已存配置 > 部署 --models 兜底。密钥与 updateModels
 * 同口径:留空=沿用已存,界面永远不回填明文。三层拼完仍缺项就如实
 * 拒绝——测试打不出去的配置,报"没得测"比编造假结果诚实。 */
export function resolveGatewayTarget(
  body: { url?: unknown; api_key?: unknown; model?: unknown },
  stored: ModelsSettings | undefined,
  deployment: Record<string, unknown> | undefined,
): GatewayTarget {
  const storedProviders =
    (stored?.json as { providers?: Record<string, any> } | undefined)
      ?.providers ?? {};
  const storedProvider = stored?.provider
    || Object.keys(storedProviders)[0];
  const storedSpec = storedProviders[storedProvider ?? ""] ?? {};
  const deploymentProviders =
    (deployment as { providers?: Record<string, any> } | undefined)
      ?.providers ?? {};
  const deploymentSpec = deploymentProviders[Object.keys(deploymentProviders)[0] ?? ""] ?? {};
  const baseUrl = String(body.url ?? "").trim()
    || String(storedSpec.baseUrl ?? "").trim()
    || String(deploymentSpec.baseUrl ?? "").trim();
  const apiKey = String(body.api_key ?? "").trim()
    || String(storedSpec.apiKey ?? "").trim()
    || String(deploymentSpec.apiKey ?? "").trim();
  const model = String(body.model ?? "").trim()
    || String(stored?.model ?? "").trim()
    || String(deploymentSpec.models?.[0]?.id ?? "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new GatewayCheckError(
      "还没有可测试的模型网关配置:请先填写网关地址、API Key 和模型名称(或先保存)");
  }
  try {
    void new URL(baseUrl);
  } catch {
    throw new GatewayCheckError(`模型网关地址不是合法 URL: ${baseUrl}`);
  }
  return { baseUrl, apiKey, model };
}

/** fetch 的失败原因散落在 cause 链的 code/name/message 里,undici 各版本
 * 包法不一;全部摊平成一段文本再按特征分类,比逐层猜稳。 */
function flattenError(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  while (cursor && parts.length < 8) {
    const node = cursor as { code?: unknown; name?: unknown; message?: unknown };
    if (node.code !== undefined) parts.push(String(node.code));
    if (node.name) parts.push(String(node.name));
    if (node.message) parts.push(String(node.message));
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

function networkFailure(error: unknown): SystemCheckItem {
  const text = flattenError(error);
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "连接网关超时,未收到任何 HTTP 响应",
      suggestion: "检查网络/防火墙/代理是否放行该网关地址,或地址是否写错" };
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "域名解析失败(ENOTFOUND)",
      suggestion: "检查网关地址拼写与部署机的 DNS 配置" };
  }
  if (/ECONNREFUSED/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: "连接被拒绝(ECONNREFUSED):端口未开放或被防火墙拦截",
      suggestion: "核对网关端口,确认服务在监听、防火墙放行" };
  }
  if (/certificate|CERT_|SSL|TLS|self-signed/i.test(text)) {
    return { key: "network", label: "网络连通", status: "error",
      detail: `TLS 握手失败(证书问题): ${text.slice(0, 160)}`,
      suggestion: "内部 CA 需受系统信任;检查证书是否过期或域名不匹配" };
  }
  return { key: "network", label: "网络连通", status: "error",
    detail: `请求未能送达网关: ${text.slice(0, 200)}` };
}

function chatItem(
  status: number,
  bodyText: string,
  elapsedMs: number,
  endpoint: string,
): SystemCheckItem {
  const gatewayMessage = (() => {
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      return message ? String(message).slice(0, 160) : "";
    } catch {
      return "";
    }
  })();
  if (status === 200) {
    const reply = extractReply(bodyText);
    if (!reply) {
      return { key: "chat", label: "模型问答", status: "warning",
        detail: "网关返回 200,但回复里没有文本内容",
        suggestion: "部分代理会吞正文;用网关侧日志核对模型是否真的出话" };
    }
    return { key: "chat", label: "模型问答", status: "ok",
      detail: `问答正常(${elapsedMs}ms):${reply.slice(0, 60)}` };
  }
  if (status === 401 || status === 403) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关拒绝密钥(HTTP ${status})`
        + (gatewayMessage ? `:${gatewayMessage}` : ""),
      suggestion: "检查 API Key 是否正确、是否有该模型的调用权限" };
  }
  if (status === 404) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: "网关返回 404:接口路径不存在",
      suggestion: `测试请求发往 ${endpoint};确认网关地址指向 Anthropic Messages 兼容前缀` };
  }
  if (status === 400) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关拒绝请求(400)${gatewayMessage ? `:${gatewayMessage}` : ""}`,
      suggestion: "常见原因是模型名称不被网关识别;核对「模型名称」字段" };
  }
  if (status === 429) {
    return { key: "chat", label: "模型问答", status: "warning",
      detail: "网关可达且密钥有效,但当前限流(429)",
      suggestion: "网关与密钥本身没问题;稍后重试或调大配额" };
  }
  if (status >= 500) {
    return { key: "chat", label: "模型问答", status: "error",
      detail: `网关服务端错误(HTTP ${status})`
        + (gatewayMessage ? `:${gatewayMessage}` : ""),
      suggestion: "网络与密钥已通过;联系网关维护方排查服务端" };
  }
  return { key: "chat", label: "模型问答", status: "warning",
    detail: `网关返回了非预期状态 HTTP ${status}`
      + (gatewayMessage ? `:${gatewayMessage}` : ""),
    suggestion: "网络与密钥大概率没问题;核对网关对该接口的支持程度" };
}

function extractReply(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      content?: Array<{ type?: string; text?: unknown }> };
    return (parsed.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text ?? ""))
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

/** 一次真实请求,两项结论。网络项看"有没有 HTTP 响应",问答项看
 * "响应说了什么"——同一发请求,不重复打网关。 */
export async function checkModelGateway(
  target: GatewayTarget,
  timeoutMs = 15_000,
): Promise<SystemCheckResult> {
  const endpoint = `${target.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let status = 0;
  let bodyText = "";
  let network: SystemCheckItem;
  let chat: SystemCheckItem | undefined;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: 32,
        messages: [{
          role: "user",
          content: "连通性测试:请只回复两个字:正常",
        }],
        stream: false,
      }),
    });
    status = response.status;
    bodyText = await response.text();
    const elapsed = Date.now() - startedAt;
    network = { key: "network", label: "网络连通", status: "ok",
      detail: `网关可达,已收到 HTTP 响应(${elapsed}ms)` };
    chat = chatItem(status, bodyText, elapsed, endpoint);
  } catch (error) {
    if (controller.signal.aborted) {
      network = { key: "network", label: "网络连通", status: "error",
        detail: `连接网关超时(${timeoutMs / 1000} 秒),未收到任何 HTTP 响应`,
        suggestion: "检查网络/防火墙/代理是否放行该网关地址,或地址是否写错" };
    } else {
      network = networkFailure(error);
    }
    chat = { key: "chat", label: "模型问答", status: "warning",
      detail: "网络连通未通过,问答测试已跳过" };
  } finally {
    clearTimeout(timer);
  }
  const items = [network, chat];
  const overall: SystemCheckStatus = items.some((item) => item.status === "error")
    ? "error"
    : items.some((item) => item.status === "warning") ? "warning" : "ok";
  return { checked_at: new Date().toISOString(), overall, items };
}
