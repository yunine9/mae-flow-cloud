/**
 * 运行时服务设置(管理页的后端)——部署配置之上的一层"运行时覆盖"。
 *
 * 分界线(用户拍板):部署配置改"这套服务长什么样"(仓库/平台/端口,
 * 改了要重启+过自查清单);这里只放**改了即刻安全生效、错了随手改回来**
 * 的东西:运行参数(并发/修复轮/轮询)与模型网关。
 *
 * 落盘纪律:
 * - settings.json 住 --data 下(文件即真相),原子写(tmp+rename),
 *   权限 0600——里面有模型 apiKey;
 * - 读坏了 fail-open 回部署值并记日志:它是旁路覆盖,不许挡住服务;
 *   (对比 --config:那是部署配置,坏了拒启。两种失败语义都是刻意的。)
 * - 密钥只写不读:view() 给界面的永远是掩码(末 4 位),API 不回明文,
 *   不落日志——这是后面 Git token 等一切密钥的模板。
 *
 * 生效边界(诚实,写给界面看):
 * - 并发:下一次调度决策;修复轮/轮询:下一次红灯/下一轮轮询;
 * - 模型:下一个新会话(在跑的会话不换血)。
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  normalizeExecutionStageCustomizations,
  normalizeTeamExecutionInstructions,
  type ExecutionStageCustomization,
} from "./executionProfile.ts";

export interface RuntimeKnobs {
  max_concurrent?: number;
  repair_rounds?: number;
  poll_interval_s?: number;
  poll_timeout_s?: number;
  /** 现场保留期(天):终态任务过期后回收克隆等重货,台账原样留下。
   * 0 = 永不回收。改了下一轮清理生效(每天扫一次)。 */
  workspace_retention_days?: number;
  /** 仓库构建缓存连续未使用的保留期；0 = 不按时间回收。 */
  build_cache_retention_days?: number;
  /** 仓库构建缓存总容量上限(GB)；0 = 不设容量上限。 */
  build_cache_max_gb?: number;
}

export interface ModelsSettings {
  /** models.json 同形内容(providers 结构),含 apiKey——密钥所在。 */
  json?: Record<string, unknown>;
  provider?: string;
  model?: string;
  /** 专用视觉模型的角色绑定。连接信息仍在同一份 models.json 中，
   * 但它不参与主模型选择，也不会让主会话整段切模型。 */
  vision?: { provider: string; model: string };
}

export interface ExecutionPolicySettings {
  /** 新任务采用并固定；运行中与历史任务不漂移。 */
  team_instructions?: string;
  stage_customizations?: ExecutionStageCustomization[];
}

interface Stored {
  runtime?: RuntimeKnobs;
  models?: ModelsSettings;
  execution_policy?: ExecutionPolicySettings;
}

export class SettingsError extends Error {}

function mask(secret: string): string {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}

/** 数值项校验:只收非负有限数。"无限等待"不是合法取值——预算的
 * 存在性不是配置项,这里连表达它的语法都没有。 */
function knob(value: unknown, name: string, min = 0): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new SettingsError(`${name} 必须是 ≥${min} 的数字`);
  }
  return parsed;
}

function upsertModel(
  models: Array<Record<string, any>> | undefined,
  id: string,
  value: Record<string, any>,
): Array<Record<string, any>> {
  const items = [...(models ?? [])];
  const index = items.findIndex((item) => String(item?.id ?? "") === id);
  if (index < 0) return [...items, value];
  items[index] = value;
  return items;
}

export class RuntimeSettings {
  private readonly path: string;
  private cache?: Stored;

  constructor(dataDir: string, readonly log?: (m: string) => void) {
    this.path = join(dataDir, "settings.json");
  }

  private load(): Stored {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) return (this.cache = {});
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf-8")) as Stored;
    } catch (error) {
      // 旁路覆盖读坏了不许挡服务:回部署值,但要出声。
      this.log?.(`settings.json 读取失败,按无覆盖处理: ${String(error)}`);
      this.cache = {};
    }
    return this.cache;
  }

  private save(next: Stored): void {
    writeFileSync(this.path + ".tmp", JSON.stringify(next, null, 1));
    chmodSync(this.path + ".tmp", 0o600);
    renameSync(this.path + ".tmp", this.path);
    this.cache = next;
  }

  runtime(): RuntimeKnobs {
    return this.load().runtime ?? {};
  }

  models(): ModelsSettings {
    return this.load().models ?? {};
  }

  executionPolicy(): ExecutionPolicySettings {
    return this.load().execution_policy ?? {};
  }

  updateExecutionPolicy(patch: Record<string, unknown>): void {
    const teamInstructions = "team_instructions" in patch
      ? normalizeTeamExecutionInstructions(
          patch.team_instructions == null
            ? undefined : String(patch.team_instructions))
      : this.executionPolicy().team_instructions;
    const stageCustomizations = "stage_customizations" in patch
      ? normalizeExecutionStageCustomizations(
          patch.stage_customizations, "团队阶段执行方案")
      : this.executionPolicy().stage_customizations ?? [];
    this.save({
      ...this.load(),
      execution_policy: {
        team_instructions: teamInstructions,
        ...(stageCustomizations.length
          ? { stage_customizations: stageCustomizations } : {}),
      },
    });
  }

  updateRuntime(patch: Record<string, unknown>): void {
    const next: RuntimeKnobs = {
      ...this.runtime(),
      max_concurrent: knob(patch.max_concurrent, "并发数", 1)
        ?? (("max_concurrent" in patch) ? undefined : this.runtime().max_concurrent),
      repair_rounds: knob(patch.repair_rounds, "修复轮预算")
        ?? (("repair_rounds" in patch) ? undefined : this.runtime().repair_rounds),
      poll_interval_s: knob(patch.poll_interval_s, "轮询间隔", 1)
        ?? (("poll_interval_s" in patch) ? undefined : this.runtime().poll_interval_s),
      poll_timeout_s: knob(patch.poll_timeout_s, "轮询预算", 1)
        ?? (("poll_timeout_s" in patch) ? undefined : this.runtime().poll_timeout_s),
      // 最小值 0 而不是 1:0 是"永不回收",一个诚实且必须能表达的选择
      // (对比"无限等待"——那个连语法都不给,因为它没有正当用途)。
      workspace_retention_days:
        knob(patch.workspace_retention_days, "现场保留期")
        ?? (("workspace_retention_days" in patch)
          ? undefined : this.runtime().workspace_retention_days),
      build_cache_retention_days:
        knob(patch.build_cache_retention_days, "构建缓存保留期")
        ?? (("build_cache_retention_days" in patch)
          ? undefined : this.runtime().build_cache_retention_days),
      build_cache_max_gb:
        knob(patch.build_cache_max_gb, "构建缓存容量上限")
        ?? (("build_cache_max_gb" in patch)
          ? undefined : this.runtime().build_cache_max_gb),
    };
    this.save({ ...this.load(), runtime: next });
  }

  /** 模型网关。管理页使用地址/API Key/模型名三个简单字段；旧的 JSON
   * 参数只为兼容已有调用与落盘数据，provider/model 必须真实存在。 */
  updateModels(patch: {
    json?: unknown;
    provider?: unknown;
    model?: unknown;
    url?: unknown;
    api_key?: unknown;
  }): void {
    const current = this.models();
    // 管理页只暴露地址、密钥、模型名三项；内部仍转换成 pi 需要的
    // models.json 形状。api_key 留空表示保留现有密钥。
    if (patch.url !== undefined || patch.api_key !== undefined) {
      const existingProviders = (current.json as {
        providers?: Record<string, any>;
      } | undefined)?.providers ?? {};
      const provider = current.provider
        || Object.keys(existingProviders).find((name) =>
          name !== current.vision?.provider)
        || "maeflow";
      const existing = existingProviders[provider] ?? {};
      const url = patch.url === undefined
        ? String(existing.baseUrl ?? "").trim()
        : String(patch.url).trim();
      const suppliedKey = patch.api_key === undefined
        ? "" : String(patch.api_key).trim();
      const apiKey = suppliedKey || String(existing.apiKey ?? "").trim();
      const model = patch.model === undefined
        ? String(current.model ?? existing.models?.[0]?.id ?? "").trim()
        : String(patch.model).trim();
      if (!url || !apiKey || !model) {
        throw new SettingsError("请完整填写模型网关地址、API Key 和模型名称");
      }
      try { void new URL(url); } catch {
        throw new SettingsError(`模型网关地址不是合法 URL: ${url}`);
      }
      const previousModel = (existing.models ?? []).find(
        (item: { id?: string }) => item?.id === model) ?? {};
      const configuredModels = upsertModel(existing.models, model,
        { ...previousModel, id: model });
      const json = { providers: { ...existingProviders, [provider]: {
        ...existing,
        baseUrl: url,
        api: existing.api ?? "anthropic-messages",
        apiKey,
        models: configuredModels,
      } } };
      this.save({ ...this.load(), models: {
        ...current, json, provider, model,
      } });
      return;
    }
    const json = patch.json === undefined
      ? current.json
      : (patch.json as Record<string, unknown>);
    const provider = patch.provider === undefined
      ? current.provider : String(patch.provider).trim();
    const model = patch.model === undefined
      ? current.model : String(patch.model).trim();
    if (json !== undefined) {
      const providers = (json as { providers?: Record<string, any> }).providers;
      if (!providers || typeof providers !== "object") {
        throw new SettingsError("models 配置必须含 providers 对象(models.json 同形)");
      }
      if (provider && !providers[provider]) {
        throw new SettingsError(`providers 里没有 ${provider}`);
      }
      const ids = provider
        ? ((providers[provider]?.models ?? []) as Array<{ id?: string }>)
          .map((item) => String(item?.id ?? ""))
        : [];
      if (provider && model && !ids.includes(model)) {
        throw new SettingsError(`${provider} 下没有模型 ${model}(有: ${ids.join("、") || "无"})`);
      }
    }
    if ((provider || model) && json === undefined && current.json === undefined) {
      throw new SettingsError("先提供 models.json 内容,再指定 provider/model");
    }
    const providers = (json as { providers?: Record<string, any> } | undefined)
      ?.providers ?? {};
    const vision = current.vision
      && providers[current.vision.provider]?.models?.some(
        (item: { id?: string }) => item?.id === current.vision?.model)
      ? current.vision : undefined;
    this.save({ ...this.load(), models: { json, provider, model, vision } });
  }

  /** 图片识别模型独立角色配置。可与主模型共用 provider，也可使用独立
   * provider；保存时保留其他模型/provider，API Key 留空表示保留。 */
  updateVision(patch: {
    url?: unknown;
    api_key?: unknown;
    model?: unknown;
    api?: unknown;
    /** 部署层 models.json 仅由服务端补入，浏览器不负责也看不到。 */
    base_json?: unknown;
    base_vision?: unknown;
  }): void {
    const current = this.models();
    const sourceJson = current.json ?? patch.base_json;
    const providers = (sourceJson as {
      providers?: Record<string, any>;
    } | undefined)?.providers ?? {};
    const baseVision = patch.base_vision && typeof patch.base_vision === "object"
      ? patch.base_vision as { provider?: unknown; model?: unknown } : undefined;
    const provider = current.vision?.provider
      || String(baseVision?.provider ?? "").trim() || "maeflow-vision";
    const existing = providers[provider] ?? {};
    const url = patch.url === undefined
      ? String(existing.baseUrl ?? "").trim() : String(patch.url).trim();
    const suppliedKey = patch.api_key === undefined
      ? "" : String(patch.api_key).trim();
    const apiKey = suppliedKey || String(existing.apiKey ?? "").trim();
    const model = patch.model === undefined
      ? String(current.vision?.model ?? baseVision?.model
        ?? existing.models?.[0]?.id ?? "").trim()
      : String(patch.model).trim();
    const api = patch.api === undefined
      ? String(existing.api ?? "openai-completions").trim()
      : String(patch.api).trim();
    const allowedApis = new Set([
      "openai-completions", "openai-responses", "anthropic-messages",
    ]);
    if (!url || !apiKey || !model) {
      throw new SettingsError("请完整填写图片识别网关地址、API Key 和模型名称");
    }
    try { void new URL(url); } catch {
      throw new SettingsError(`图片识别网关地址不是合法 URL: ${url}`);
    }
    if (!allowedApis.has(api)) {
      throw new SettingsError(`不支持的图片识别接口协议: ${api}`);
    }
    const previousModel = (existing.models ?? []).find(
      (item: { id?: string }) => item?.id === model) ?? {};
    const configuredModels = upsertModel(existing.models, model, {
      ...previousModel,
      id: model,
      input: ["text", "image"],
      reasoning: false,
    });
    const json = { providers: { ...providers, [provider]: {
      ...existing,
      baseUrl: url,
      api,
      apiKey,
      models: configuredModels,
    } } };
    this.save({ ...this.load(), models: {
      ...current,
      json,
      vision: { provider, model },
    } });
  }

  /** 给界面的视图:密钥全部掩码。这里是"只写不读"的读半边——
   * 谁在这个函数里返回明文,谁就在给未来的泄漏签字。 */
  view(): {
    runtime: RuntimeKnobs;
    execution_policy: ExecutionPolicySettings;
    models: { configured: boolean; provider?: string; model?: string;
              url?: string; key_hint?: string;
              providers: Array<{ name: string; models: string[]; key_hint?: string }>;
              vision: { configured: boolean; provider?: string; model?: string;
                url?: string; api?: string; key_hint?: string } };
  } {
    const models = this.models();
    const providers = Object.entries(
      (models.json as { providers?: Record<string, any> } | undefined)
        ?.providers ?? {},
    ).map(([name, spec]) => ({
      name,
      models: ((spec?.models ?? []) as Array<{ id?: string }>)
        .map((item) => String(item?.id ?? "")).filter(Boolean),
      key_hint: spec?.apiKey ? mask(String(spec.apiKey)) : undefined,
    }));
    const selectedProvider = models.provider || providers[0]?.name;
    const selectedSpec = ((models.json as {
      providers?: Record<string, any>;
    } | undefined)?.providers ?? {})[selectedProvider ?? ""];
    const visionSpec = ((models.json as {
      providers?: Record<string, any>;
    } | undefined)?.providers ?? {})[models.vision?.provider ?? ""];
    return {
      runtime: this.runtime(),
      execution_policy: this.executionPolicy(),
      models: {
        configured: !!selectedSpec?.baseUrl && !!selectedSpec?.apiKey
          && !!models.model,
        provider: models.provider,
        model: models.model,
        url: selectedSpec?.baseUrl
          ? String(selectedSpec.baseUrl) : undefined,
        key_hint: selectedSpec?.apiKey
          ? mask(String(selectedSpec.apiKey)) : undefined,
        providers,
        vision: {
          configured: !!models.vision?.provider && !!models.vision?.model
            && !!visionSpec?.baseUrl && !!visionSpec?.apiKey,
          provider: models.vision?.provider,
          model: models.vision?.model,
          url: visionSpec?.baseUrl ? String(visionSpec.baseUrl) : undefined,
          api: visionSpec?.api ? String(visionSpec.api) : undefined,
          key_hint: visionSpec?.apiKey
            ? mask(String(visionSpec.apiKey)) : undefined,
        },
      },
    };
  }
}
