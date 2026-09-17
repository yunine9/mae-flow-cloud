/**
 * Beta 网关(ADR-0039)契约:
 * - 解析规则:白名单成员名下任务整体换装 Beta;名单外/缺席=平台口径;
 *   Beta 配置残缺 fail-open 走平台并出声;
 * - 视觉绑定不换装:平台 vision 的 provider 条目并入 Beta 现场 json,
 *   Beta 会话照样能解析出视觉模型;同名 provider 撞车连接信息以 Beta 为准;
 * - 密钥纪律与平台网关同款:明文只进 0600 文件,视图永远掩码;
 * - 名单语义:members 全量替换,空名单=通道停用但配置保留。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSettings } from "../src/settings.ts";
import {
  betaLaneUsable,
  resolveModelConfig,
} from "../src/modelResolution.ts";

function store(): RuntimeSettings {
  return new RuntimeSettings(mkdtempSync(join(tmpdir(), "mfc-beta-")));
}

function seedBeta(settings: RuntimeSettings, overrides: {
  url?: string; api_key?: string; model?: string; members?: string[];
} = {}): void {
  settings.updateModelsBeta({
    url: overrides.url ?? "http://beta-gw",
    api_key: overrides.api_key ?? "sk-beta-abcd4321",
    model: overrides.model ?? "beta-max",
    api: "openai-completions",
    members: overrides.members ?? ["张三"],
  });
}

const DEPLOYMENT = {
  modelsJson: { providers: { maeflow: {
    baseUrl: "http://deploy-gw", api: "openai-completions",
    apiKey: "sk-deploy", models: [{ id: "scripted-v1" }],
  } } },
  provider: "maeflow",
  model: "scripted-v1",
};

test("解析器:名单外成员与缺席 operator 一律平台口径", () => {
  const settings = store();
  seedBeta(settings);
  for (const operator of [undefined, "李四", ""]) {
    const resolved = resolveModelConfig({
      settings, deployment: DEPLOYMENT,
      ...(operator ? { operator } : {}),
    });
    assert.equal(resolved.lane, "platform");
    assert.deepEqual(resolved.json, DEPLOYMENT.modelsJson);
  }
});

test("解析器:白名单成员整体换装 Beta,部署参数与平台配置不掺和", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  seedBeta(settings, { members: ["张三"] });
  const resolved = resolveModelConfig({
    settings, deployment: DEPLOYMENT, operator: "张三",
  });
  assert.equal(resolved.lane, "beta");
  assert.equal(resolved.provider, "maeflow-beta");
  assert.equal(resolved.model, "beta-max");
  const spec = (resolved.json as any).providers["maeflow-beta"];
  assert.equal(spec.baseUrl, "http://beta-gw");
  assert.equal(spec.apiKey, "sk-beta-abcd4321",
    "Beta 会话的现场 json 必须带 Beta 自己的密钥");
  assert.ok(!("maeflow" in (resolved.json as any).providers),
    "平台网关的 provider 不该整目录带进 Beta 现场");
});

test("解析器:Beta 配置残缺 fail-open 走平台,并出一行日志", () => {
  const settings = store();
  // 只有名单、没有连接配置:usable=false,视同未配。
  settings.updateModelsBeta({ members: ["张三"] });
  const logs: string[] = [];
  const resolved = resolveModelConfig({
    settings, deployment: DEPLOYMENT, operator: "张三",
    log: (message) => logs.push(message),
  });
  assert.equal(resolved.lane, "platform");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fail-open/);
  assert.ok(betaLaneUsable(undefined) === false);
});

test("解析器:平台 vision 的 provider 条目并入 Beta 现场 json,视觉绑定不换装", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  settings.updateVision({
    url: "http://vision-gw", api_key: "sk-vision", model: "vision-1",
    api: "openai-completions",
  });
  seedBeta(settings);
  const resolved = resolveModelConfig({
    settings, deployment: DEPLOYMENT, operator: "张三",
  });
  assert.equal(resolved.lane, "beta");
  const visionSpec = (resolved.json as any).providers["maeflow-vision"];
  assert.ok(visionSpec, "Beta 现场 json 必须含平台 vision provider");
  assert.equal(visionSpec.apiKey, "sk-vision");
  assert.ok(visionSpec.models.some((item: any) => item.id === "vision-1"));
});

test("解析器:换装不改 settings 缓存对象(深拷贝纪律)", () => {
  const settings = store();
  settings.updateModels({
    url: "http://platform-gw", api_key: "sk-platform", model: "glm-5.1",
  });
  seedBeta(settings);
  const before = JSON.stringify(settings.modelsBeta().json);
  resolveModelConfig({ settings, deployment: DEPLOYMENT, operator: "张三" });
  resolveModelConfig({ settings, deployment: DEPLOYMENT, operator: "张三" });
  assert.equal(JSON.stringify(settings.modelsBeta().json), before);
});

test("Beta 密钥纪律:明文只进 0600 文件,视图永远掩码", () => {
  const settings = store();
  seedBeta(settings);
  const view = JSON.stringify(settings.view());
  assert.ok(!view.includes("sk-beta-abcd4321"), "Beta apiKey 明文漏进视图");
  assert.match(view, /••••4321/);
  const betaView = settings.view().models_beta;
  assert.equal(betaView.enabled, true);
  assert.deepEqual(betaView.members, ["张三"]);
  assert.equal(betaView.model, "beta-max");
  const path = join(tmpdir(), "mfc-beta-");
  void path;
  const stored = mkdtempSync(join(tmpdir(), "mfc-beta-perm-"));
  const persisted = new RuntimeSettings(stored);
  seedBeta(persisted);
  const dataFile = join(stored, "settings.json");
  assert.equal(statSync(dataFile).mode & 0o777, 0o600,
    "settings.json 必须是 0600(里面有 Beta 密钥)");
});

test("Beta 名单语义:members 全量替换,空名单=停用但配置保留;留空=沿用密钥", () => {
  const settings = store();
  seedBeta(settings);
  settings.updateModelsBeta({ members: ["张三", "李四", "张三", " "] });
  assert.deepEqual(settings.view().models_beta.members, ["张三", "李四"],
    "名单要归一:去空去重");
  settings.updateModelsBeta({ members: [] });
  const view = settings.view().models_beta;
  assert.equal(view.enabled, false, "空名单=通道停用");
  assert.equal(view.configured, true, "停用不清配置");
  settings.updateModelsBeta({ members: ["王五"], api_key: "", url: "http://beta-gw" });
  assert.equal(
    (settings.modelsBeta().json as any).providers["maeflow-beta"].apiKey,
    "sk-beta-abcd4321", "编辑时 API Key 留空应保留原密钥");
  assert.deepEqual(settings.view().models_beta.members, ["王五"]);
});

test("Beta 表单校验:坏 URL/缺项/坏接口格式照平台网关同款拒绝", () => {
  const settings = store();
  assert.throws(() => settings.updateModelsBeta({
    url: "http://gw", api_key: "sk", model: "m", api: "gemini",
  }), /接口格式/);
  assert.throws(() => settings.updateModelsBeta({
    url: "not-a-url", api_key: "sk", model: "m",
  }), /合法 URL/);
  assert.throws(() => settings.updateModelsBeta({
    url: "", api_key: "sk", model: "m",
  }), /完整填写/);
});
