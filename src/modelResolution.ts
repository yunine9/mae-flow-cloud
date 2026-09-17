/**
 * 模型网关解析的单一咽喉(ADR-0039)。
 *
 * 「管理页 settings 覆盖压部署参数(--models/--provider/--model)」这条
 * 合并链原本内联在 taskService/issueFlow 的每个会话启动点,共约九处,
 * 各写各的;任何新通道若没有唯一合并点,就会散弹式漏站——主会话换了
 * 网关、摘要还走老网关之类。所有"本次会话用哪套 models.json +
 * provider/model"的问题都从 resolveModelConfig 进。
 *
 * Beta 通道(ADR-0039):白名单成员名下任务的模型调用整体换装 Beta
 * 网关。任务级 model_choice 的让位由调用点执行(它不在解析器手里);
 * 视觉角色绑定不参与换装——vision 恒走平台网关的绑定,校验口径归
 * 调用方的 activeVisionChoice/visionCapability(平台 json),解析器只
 * 负责把平台 vision 的 provider 条目并进 Beta 现场 json,保证 Beta
 * 会话照样能解析出视觉模型。
 *
 * fail-open 口径(ADR-0039):Beta 配置残缺(解析不出可用的
 * provider+model)视同未配,静默按平台网关走,只出一行日志;运行期
 * 的网关故障不中途换道,靠下次会话启动的现算自愈。
 */

import type { ModelsSettings } from "./settings.ts";

/** 设置侧最小接口:RuntimeSettings 与各服务的 options.settings 子集
 *  类型都满足它,解析器不认完整类。 */
export interface ModelSettingsSource {
  models(): ModelsSettings;
  modelsBeta?(): ModelsSettings & { members?: string[] };
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
  /** 部署层视觉角色(settings 未配 vision 时的兜底),只用于 Beta
   *  现场 json 的 vision provider 合并,不参与主模型选择。 */
  vision?: { provider: string; model: string };
}

/** settings 逐字段压部署参数;Beta 白名单命中且配置完整时整体换装
 *  (ADR-0039)。operator=会话归属人(任务=发起人,问题=责任人),
 *  缺席=平台口径。 */
export function resolveModelConfig(input: {
  settings?: ModelSettingsSource;
  deployment: DeploymentModels;
  operator?: string;
  log?: (message: string) => void;
}): ResolvedModelConfig {
  const platform = input.settings?.models();
  const platformJson = platform?.json ?? input.deployment.modelsJson;
  const vision = platform?.vision ?? input.deployment.vision;
  const beta = input.settings?.modelsBeta?.();
  if (input.operator && beta
      && (beta.members ?? []).includes(input.operator)) {
    if (betaLaneUsable(beta)) {
      return {
        lane: "beta",
        json: withPlatformVision(beta.json, vision, platformJson),
        provider: betaProvider(beta),
        model: beta.model,
      };
    }
    input.log?.(`Beta 网关配置残缺(白名单成员 ${input.operator}),`
      + "本次按平台网关处理(fail-open,ADR-0039)");
  }
  return {
    lane: "platform",
    json: platformJson ?? {},
    provider: platform?.provider ?? input.deployment.provider,
    model: platform?.model ?? input.deployment.model,
  };
}

function betaProvider(beta: ModelsSettings): string | undefined {
  return beta.provider
    || Object.keys(betaJsonProviders(beta.json))[0] || undefined;
}

function betaJsonProviders(json: Record<string, unknown> | undefined):
  Record<string, any> {
  return (json as { providers?: Record<string, any> } | undefined)
    ?.providers ?? {};
}

/** Beta 配置是否完整可用:providers 里能解析出带 baseUrl+apiKey 的
 *  provider,且 model 在其目录中。残缺=视同未配(fail-open 走平台)。 */
export function betaLaneUsable(beta: ModelsSettings | undefined): boolean {
  if (!beta) return false;
  const providers = betaJsonProviders(beta.json);
  if (!Object.keys(providers).length) return false;
  const provider = betaProvider(beta);
  const spec = providers[provider ?? ""];
  if (!spec?.baseUrl || !spec.apiKey) return false;
  const listed = (spec.models ?? [])
    .map((item: { id?: unknown }) => String(item?.id ?? ""))
    .filter(Boolean);
  const model = beta.model || listed[0];
  return Boolean(provider && model && listed.includes(model));
}

/** 平台 vision 的 provider 条目并进 Beta 现场 json(ADR-0039):Beta
 *  会话的 models.json 必须能解析出视觉模型,否则 inspect_image 在
 *  pi 侧直接失踪。同名 provider 撞车时连接信息以 Beta 为准,只补
 *  vision 模型条目。深拷贝返回,绝不改到 settings 的缓存对象。 */
function withPlatformVision(
  betaJson: Record<string, unknown> | undefined,
  vision: { provider: string; model: string } | undefined,
  platformJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cloned = structuredClone(betaJson ?? {});
  if (!vision?.provider || !vision?.model) return cloned;
  const providers = betaJsonProviders(cloned);
  const source = betaJsonProviders(platformJson)[vision.provider];
  if (!source) return cloned;
  const visionModel = (source.models ?? []).find(
    (item: { id?: unknown }) => String(item?.id ?? "") === vision.model);
  const existing = providers[vision.provider];
  if (!existing) {
    providers[vision.provider] = structuredClone(source);
    return cloned;
  }
  existing.models = upsertVisionModel(existing.models, visionModel
    ?? { id: vision.model });
  return cloned;
}

function upsertVisionModel(
  models: Array<Record<string, any>> | undefined,
  entry: Record<string, any>,
): Array<Record<string, any>> {
  const items = [...(models ?? [])];
  const index = items.findIndex((item) =>
    String(item?.id ?? "") === String(entry.id ?? ""));
  if (index < 0) return [...items, structuredClone(entry)];
  items[index] = { ...items[index], ...structuredClone(entry) };
  return items;
}
