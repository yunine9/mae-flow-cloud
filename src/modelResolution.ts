/**
 * 模型网关解析的单一咽喉(ADR-0039)。
 *
 * 「管理页 settings 覆盖压部署参数(--models/--provider/--model)」这条
 * 合并链原本内联在 taskService/issueFlow 的每个会话启动点,共约九处,
 * 各写各的;任何新通道(如 Beta 白名单)若没有唯一合并点,就会散弹式
 * 漏站——主会话换了网关、摘要还走老网关之类。所有"本次会话用哪套
 * models.json + provider/model"的问题都从 resolveModelConfig 进。
 *
 * 视觉角色绑定不参与换装(ADR-0039):vision 恒走平台网关的绑定,
 * 校验口径归调用方的 activeVisionChoice/visionCapability(平台 json)。
 */

import type { ModelsSettings } from "./settings.ts";

/** 设置侧最小接口:RuntimeSettings 与各服务的 options.settings 子集
 *  类型都满足它,解析器不认完整类。 */
export interface ModelSettingsSource {
  models(): ModelsSettings;
}

/** 本会话应用的网关通道:任务记录 model_lane 标记认它。 */
export type ModelLane = "platform" | "beta";

export interface ResolvedModelConfig {
  lane: ModelLane;
  /** 现场 models.json 的内容(pi models.json 同形,含 apiKey);
   * 落盘纪律(0600/明文+掩码)归调用点。 */
  json: Record<string, unknown>;
  provider?: string;
  model?: string;
}

export interface DeploymentModels {
  modelsJson?: Record<string, unknown>;
  provider?: string;
  model?: string;
}

/** settings 逐字段压部署参数;Beta 白名单命中时整体换装(ADR-0039)。
 *  operator=会话归属人(任务=发起人,问题=责任人);缺席=平台口径。 */
export function resolveModelConfig(input: {
  settings?: ModelSettingsSource;
  deployment: DeploymentModels;
  operator?: string;
}): ResolvedModelConfig {
  const platform = input.settings?.models();
  return {
    lane: "platform",
    json: platform?.json ?? input.deployment.modelsJson ?? {},
    provider: platform?.provider ?? input.deployment.provider,
    model: platform?.model ?? input.deployment.model,
  };
}

/** Beta 配置是否完整可用:providers 里能解析出带 baseUrl+apiKey 的
 *  provider,且 model 在其目录中。残缺=视同未配(fail-open 走平台,
 *  ADR-0039;出声归调用点的日志口径)。 */
export function betaLaneUsable(beta: ModelsSettings | undefined): boolean {
  const providers = (beta?.json as {
    providers?: Record<string, {
      baseUrl?: unknown; apiKey?: unknown;
      models?: Array<{ id?: unknown }>;
    }>;
  } | undefined)?.providers;
  if (!providers || typeof providers !== "object") return false;
  const provider = beta?.provider || Object.keys(providers)[0];
  const spec = providers[provider ?? ""];
  if (!spec?.baseUrl || !spec.apiKey) return false;
  const model = beta?.model
    || (spec.models ?? []).map((item) => String(item?.id ?? ""))[0];
  return Boolean(provider && model
    && (spec.models ?? []).some((item) => String(item?.id ?? "") === model));
}
