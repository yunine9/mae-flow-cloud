/**
 * 登记描述 AI 润色(spec #184):一次性(非会话)主模型组装。
 *
 * 测试人员的描述往往口语化、要素缺失;润色把 标题+描述 整理成标准
 * 提单格式(结构模板住 assets/issue-prompts/polish.md,ADR-0016 文案
 * 纪律——本文件不写提示词句子)。与问题会话的 agent 通路不同,这里是
 * 单轮调用:识图(有图时)与润色各自一次 completeSimple,走与识图探测
 * 同款的临时 models.json + ModelRuntime 通路,不裸 fetch。
 *
 * 口径:
 * - 图片侧沿用 issueImages 的红线——图片字节只进专用识图模型,换回的
 *   文字观察进润色提示;描述里的 issue-images/ 引用原样保留。
 * - fail-open:识图未配置/失败不阻塞润色,给 vision_note 让前端明示
 *   「未参考截图」;润色主调用失败才整体失败(PolishModelError → 502)。
 * - 服务端不落库:润色稿只存在于前端确认流,替换前原稿不动。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  describeImageBytes,
  type VisionModelChoice,
} from "../visionCapability.ts";
import { IssueControlError, PolishModelError } from "./errors.ts";
import { extractIssueImagePaths, readStagedImage } from "./issueImages.ts";
import { promptCopy } from "./promptCopy.ts";

/** 单次润色参与识读的截图上限,与 inspect_image 的 MAX_IMAGES 同口径。 */
export const POLISH_IMAGE_LIMIT = 4;

const POLISH_TIMEOUT_MS = 120_000;
const POLISH_VISION_TIMEOUT_MS = 45_000;
const POLISH_MAX_TOKENS = 4096;

/** 模型选择(与 IssueFlowService.modelChoice 同形)。 */
export interface PolishModelChoice {
  provider: string;
  model: string;
  json: Record<string, unknown>;
}

/** 一次性模型通路的结构最小面(与 visionCapability.VisionRuntime 同
 * 形):生产是 pi-coding-agent 的 ModelRuntime,测试注入假件。 */
export interface PolishRuntime {
  getModel(provider: string, model: string): unknown;
  completeSimple(
    model: unknown,
    context: unknown,
    options?: unknown,
  ): Promise<any>;
}

/** 运行时句柄:dispose 负责临时 models.json 目录的清理(密钥不残留)。 */
export interface PolishRuntimeHandle {
  runtime: PolishRuntime;
  dispose(): void;
}

export interface PolishDeps {
  dataDir: string;
  mainModel: PolishModelChoice;
  /** 识图角色:缺席 = 润色不看图(vision_used=false + 明示)。 */
  visionChoice?: VisionModelChoice;
  log?: (message: string) => void;
  /** 测试注入点:假件运行时工厂;生产默认临时目录物化 models.json。 */
  createRuntime?: (
    modelsJson: Record<string, unknown>,
  ) => Promise<PolishRuntimeHandle>;
}

export interface PolishInput {
  title: string;
  description: string;
  module?: string;
  environmentName?: string;
}

export interface PolishOutcome {
  title: string;
  description: string;
  vision_used: boolean;
  vision_note?: string;
}

/** 生产运行时:与识图探测(probeVisionCapability)同款——临时目录写
 * models.json(0600),ModelRuntime 读它建通路,dispose 整目录删除。 */
async function defaultRuntimeHandle(
  modelsJson: Record<string, unknown>,
): Promise<PolishRuntimeHandle> {
  const dir = mkdtempSync(join(tmpdir(), "mae-flow-issue-polish-"));
  try {
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(modelsJson), { mode: 0o600 });
    chmodSync(modelsPath, 0o600);
    const runtime = await ModelRuntime.create({
      modelsPath,
    }) as unknown as PolishRuntime;
    return { runtime, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new PolishModelError(
      `润色模型运行时初始化失败：${redactSecrets(String(error))}`);
  }
}

/** 错误消息出域前的密钥擦除(与 visionCapability.safeError 同款正则)。 */
function redactSecrets(message: string): string {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~-]{8,}\b/g, "[REDACTED]");
}

/** 用户内容里的 {{ 会与 promptCopy 的占位符判定相撞(用户贴过模板
 * 片段时,替换后残留检查会当场抛错);零宽空格中和——视觉不变,
 * placeholder 判定失效。 */
export function neutralizeTemplateMarks(value: string): string {
  return value.replace(/\{\{/g, "{\u200b{");
}

/** 润色输出解析(首行「标题：…」契约,见 polish.md system 段)。整体
 * 被代码块包裹时先剥壳(模型偶发违令);解析不出标题行则标题缺席,
 * 调用方保留原标题——描述永不因解析失败而丢。 */
export function splitPolishTitle(output: string): {
  title?: string;
  description: string;
} {
  let text = output.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  const lines = text.split("\n");
  const head =
    /^#{0,4}\s*\**\s*标题\s*[:：]\s*(.+?)\s*\**\s*$/.exec(lines[0] ?? "");
  if (!head || lines.length === 1) return { description: text };
  return { title: head[1], description: lines.slice(1).join("\n").trim() };
}

/** 从描述提取 staging 截图并读出字节(引用序去重后截上限)。missing =
 * 超出上限 + staging 缺失的引用数——fail-open 口径,润色不因缺图失败,
 * 但要让模型(经 image_observations 尾注)知道有图没看上。 */
export function collectStagedImages(input: {
  description: string;
  dataDir: string;
  limit?: number;
}): { images: Array<{ label: string; data: Buffer; mimeType: string }>; missing: number } {
  const limit = input.limit ?? POLISH_IMAGE_LIMIT;
  const paths = extractIssueImagePaths(input.description);
  const images: Array<{ label: string; data: Buffer; mimeType: string }> = [];
  let missing = Math.max(0, paths.length - limit);
  for (const path of paths.slice(0, limit)) {
    const image = readStagedImage({ path, dataDir: input.dataDir });
    if (!image) {
      missing += 1;
      continue;
    }
    images.push({ label: path, data: image.data, mimeType: image.mime_type });
  }
  return { images, missing };
}

/** 润色主流程:识图观察(可选)→ 文案挂载 → 一次性主模型 → 解析。
 * 标题解析不出就保留原标题;描述永远是模型的完整正文。 */
export async function polishIssueDescription(
  deps: PolishDeps,
  input: PolishInput,
): Promise<PolishOutcome> {
  if (!input.description.trim()) {
    throw new IssueControlError("描述为空,无需润色——先写几句现象再点润色");
  }
  const { images, missing } = collectStagedImages({
    description: input.description,
    dataDir: deps.dataDir,
  });
  const handle = await (deps.createRuntime ?? defaultRuntimeHandle)(
    deps.mainModel.json,
  );
  try {
    let visionUsed = false;
    let visionNote: string | undefined;
    let observations = "（无截图，未参考图片内容。）";
    if (images.length) {
      if (!deps.visionChoice) {
        visionNote = "识图服务未配置，本次润色未参考截图内容";
      } else {
        try {
          observations = await describeImageBytes({
            runtime: handle.runtime,
            choice: deps.visionChoice,
            cacheDir: join(deps.dataDir, "vision-cache"),
            images,
            question: promptCopy("polish", "vision-question"),
            timeoutMs: POLISH_VISION_TIMEOUT_MS,
            sessionId: "issues:polish:vision",
          });
          visionUsed = true;
        } catch (error) {
          visionNote = "识图失败，本次润色未参考截图内容";
          observations = "（截图存在但未识读：识图服务不可用。）";
          deps.log?.(`识图失败(fail-open): ${redactSecrets(String(error))}`);
        }
      }
      if (missing > 0) {
        observations += `\n（另有 ${missing} 张截图未参与识读。）`;
      }
    }

    const systemPrompt = promptCopy("polish", "system");
    const userPrompt = promptCopy("polish", "user", {
      title: neutralizeTemplateMarks(input.title || "（未填写）"),
      description: neutralizeTemplateMarks(input.description),
      module: neutralizeTemplateMarks(input.module || "未提供"),
      environment: neutralizeTemplateMarks(input.environmentName || "未提供"),
      now: new Date().toLocaleString("zh-CN", { hour12: false }),
      image_observations: neutralizeTemplateMarks(observations),
    });

    const model = handle.runtime.getModel(
      deps.mainModel.provider, deps.mainModel.model);
    if (!model) {
      throw new PolishModelError(
        `润色模型不存在：${deps.mainModel.provider}/${deps.mainModel.model}`);
    }
    let response: any;
    try {
      response = await handle.runtime.completeSimple(model, {
        systemPrompt,
        messages: [{
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: userPrompt }],
        }],
      }, {
        timeoutMs: POLISH_TIMEOUT_MS,
        maxRetries: 0,
        maxTokens: POLISH_MAX_TOKENS,
        reasoning: "off",
        sessionId: "issues:polish",
      });
    } catch (error) {
      throw new PolishModelError(`润色请求失败：${redactSecrets(String(error))}`);
    }
    if (response?.stopReason === "error" || response?.stopReason === "aborted") {
      throw new PolishModelError(
        `润色请求失败：${redactSecrets(String(response.errorMessage || response.stopReason))}`);
    }
    const text = (response?.content ?? [])
      .filter((item: any) => item?.type === "text")
      .map((item: any) => String(item.text ?? ""))
      .join("\n").trim();
    if (!text) throw new PolishModelError("润色模型返回了空结果");

    const parsed = splitPolishTitle(text);
    return {
      title: parsed.title ?? input.title,
      description: parsed.description,
      vision_used: visionUsed,
      ...(visionNote ? { vision_note: visionNote } : {}),
    };
  } finally {
    handle.dispose();
  }
}
