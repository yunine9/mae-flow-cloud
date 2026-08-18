/**
 * 运行时服务设置(管理页的后端)——部署配置之上的一层"运行时覆盖"。
 *
 * 分界线(用户拍板):部署配置改"这套服务长什么样"(仓库/平台/端口,
 * 改了要重启+过自查清单);这里只放**改了即刻安全生效、错了随手改回来**
 * 的东西:运行参数(并发/修复轮/轮询)、通知端点、模型网关。
 *
 * 落盘纪律:
 * - settings.json 住 --data 下(文件即真相),原子写(tmp+rename),
 *   权限 0600——里面有通知鉴权头和模型 apiKey;
 * - 读坏了 fail-open 回部署值并记日志:它是旁路覆盖,不许挡住服务;
 *   (对比 --config:那是部署配置,坏了拒启。两种失败语义都是刻意的。)
 * - 密钥只写不读:view() 给界面的永远是掩码(末 4 位),API 不回明文,
 *   不落日志——这是后面 Git token 等一切密钥的模板。
 *
 * 生效边界(诚实,写给界面看):
 * - 并发:下一次调度决策;修复轮/轮询:下一次红灯/下一轮轮询;
 * - 通知:下一条消息;模型:下一个新会话(在跑的会话不换血)。
 */

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface RuntimeKnobs {
  max_concurrent?: number;
  repair_rounds?: number;
  poll_interval_s?: number;
  poll_timeout_s?: number;
}

export interface LubanSettings {
  endpoint?: string;
  headers?: Record<string, string>;
}

export interface ModelsSettings {
  /** models.json 同形内容(providers 结构),含 apiKey——密钥所在。 */
  json?: Record<string, unknown>;
  provider?: string;
  model?: string;
}

/** 服务形态(用户拍板"这些不该是启动项"):平台适配层地址、默认
 * 交付仓、免编译开关。全部热改:平台/仓=下一次交付动作,免编译=
 * 下一个新会话。唯一要重启的例外:服务启动时既没有 --repo 也没有
 * 这里的默认仓,内核模式根本没开——从无到有要重启一次(部署形态
 * 变化),界面上如实写着。 */
export interface ServiceSettings {
  platform_url?: string;
  default_repo?: string;
  verify_via_pipeline?: boolean;
  /** 提交信息规范(一句话,进每个会话开场)。平台钩子按正则拒收不
   * 合规提交,规矩得让 agent 第一次就知道(内网实测被拒过)。 */
  commit_convention?: string;
}

interface Stored {
  runtime?: RuntimeKnobs;
  luban?: LubanSettings;
  models?: ModelsSettings;
  service?: ServiceSettings;
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

  luban(): LubanSettings {
    return this.load().luban ?? {};
  }

  models(): ModelsSettings {
    return this.load().models ?? {};
  }

  service(): ServiceSettings {
    return this.load().service ?? {};
  }

  /** 服务形态。语义同各节:undefined=保留,空串=删除。 */
  updateService(patch: {
    platform_url?: unknown;
    default_repo?: unknown;
    verify_via_pipeline?: unknown;
    commit_convention?: unknown;
  }): void {
    const current = this.service();
    const next: ServiceSettings = { ...current };
    if (patch.platform_url !== undefined) {
      const url = String(patch.platform_url).trim();
      if (!url) delete next.platform_url;
      else {
        try {
          void new URL(url);
        } catch {
          throw new SettingsError(`平台地址不是合法 URL: ${url}`);
        }
        next.platform_url = url;
      }
    }
    if (patch.default_repo !== undefined) {
      const repo = String(patch.default_repo).trim();
      if (!repo) delete next.default_repo;
      else {
        if (/\s/.test(repo)) {
          throw new SettingsError("代码仓地址不能含空白字符");
        }
        if (/^https?:\/\//i.test(repo)) {
          const parsed = new URL(repo);
          if (parsed.username || parsed.password) {
            throw new SettingsError(
              "代码仓 URL 不许携带账号密码——鉴权使用个人 CodeHub Token");
          }
        }
        next.default_repo = repo;
      }
    }
    if (patch.verify_via_pipeline !== undefined) {
      const raw = patch.verify_via_pipeline;
      if (raw === "" || raw === null) delete next.verify_via_pipeline;
      else if (raw === true || raw === "true") next.verify_via_pipeline = true;
      else if (raw === false || raw === "false") {
        next.verify_via_pipeline = false;
      } else {
        throw new SettingsError(
          `免编译开关只认 true/false/空(跟随部署),收到: ${String(raw)}`);
      }
    }
    if (patch.commit_convention !== undefined) {
      // 一句话规矩,原样进提示词。长度设上限只为防止有人把整份规范
      // 贴进来挤占开场白(那该放仓里的 AGENTS.md,知识在仓不在平台)。
      const text = String(patch.commit_convention).trim();
      if (!text) delete next.commit_convention;
      else if (text.length > 500) {
        throw new SettingsError(
          "提交信息规范请压到 500 字以内(完整规范放仓里的 AGENTS.md)");
      } else next.commit_convention = text;
    }
    this.save({ ...this.load(), service: next });
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
    };
    this.save({ ...this.load(), runtime: next });
  }

  /** 通知设置。headers 按键合并:给值=替换,给空串=删除,不给=保留
   * ——界面拿到的是掩码,只写不读的语义下它没法"原样回填",所以
   * 服务端必须替它记住没动过的键。 */
  updateLuban(patch: {
    endpoint?: unknown;
    headers?: Record<string, unknown>;
  }): void {
    const current = this.luban();
    const endpoint = patch.endpoint === undefined
      ? current.endpoint
      : String(patch.endpoint).trim() || undefined;
    if (endpoint !== undefined) {
      try {
        void new URL(endpoint);
      } catch {
        throw new SettingsError(`通知端点不是合法 URL: ${endpoint}`);
      }
    }
    const headers = { ...(current.headers ?? {}) };
    for (const [name, value] of Object.entries(patch.headers ?? {})) {
      const key = name.trim();
      if (!key) continue;
      if (value === "" || value === null) delete headers[key];
      else headers[key] = String(value);
    }
    this.save({
      ...this.load(),
      luban: {
        endpoint,
        headers: Object.keys(headers).length ? headers : undefined,
      },
    });
  }

  /** 模型网关。整份 models.json 同形内容 + 默认 provider/model;
   * provider/model 必须真实存在于给的 json 里,不收"以后再补"。 */
  updateModels(patch: {
    json?: unknown;
    provider?: unknown;
    model?: unknown;
  }): void {
    const current = this.models();
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
    this.save({ ...this.load(), models: { json, provider, model } });
  }

  /** 给界面的视图:密钥全部掩码。这里是"只写不读"的读半边——
   * 谁在这个函数里返回明文,谁就在给未来的泄漏签字。 */
  view(): {
    runtime: RuntimeKnobs;
    luban: { endpoint?: string; headers: Array<{ name: string; hint: string }> };
    models: { configured: boolean; provider?: string; model?: string;
              providers: Array<{ name: string; models: string[]; key_hint?: string }> };
    service: ServiceSettings;
  } {
    const luban = this.luban();
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
    return {
      runtime: this.runtime(),
      service: this.service(),
      luban: {
        endpoint: luban.endpoint,
        headers: Object.entries(luban.headers ?? {}).map(([name, value]) => ({
          name,
          hint: mask(value),
        })),
      },
      models: {
        configured: models.json !== undefined,
        provider: models.provider,
        model: models.model,
        providers,
      },
    };
  }
}
