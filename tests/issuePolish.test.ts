/**
 * 登记描述 AI 润色契约(#184):文案挂载(polish.md 三锚点 + 图片引用
 * 保留 + 待补充令牌条款)、纯函数解析(标题行契约/占位符中和/staging
 * 取图 fail-open)、真路由契约(注入假件运行时,不真调网关——识图观察
 * 进上下文、fail-open 明示、错误族 409/502 映射)、前端接线(润色按钮
 * /确认弹窗/渲染器染红行为)。文案锚点模式同 helpCenter,真路由过线
 * 协议同 issueFlowContract 的 issuePost。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import {
  mountedPromptAnchors,
  promptCopy,
} from "../src/issueFlow/promptCopy.ts";
import { stageIssueImage } from "../src/issueFlow/issueImages.ts";
import {
  collectStagedImages,
  neutralizeTemplateMarks,
  polishIssueDescription,
  splitPolishTitle,
  type PolishRuntimeHandle,
} from "../src/issueFlow/polish.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import { Markdown, hasPendingMark } from "../web/src/markdown.tsx";
import {
  displayUrlToRef,
  refToDisplayUrl,
} from "../web/src/issues/issueImageRef.ts";
import { mfcTemp } from "./mfcTmp.ts";

// markdown.tsx 走经典 JSX 运行时(React 全局),同 markdownRenderer 先挂。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

// ---- 文案契约:polish.md 挂载与条款(#184 拍板的模板适配) ----

test("润色文案:三锚点在册,system 段含图片引用保留与待补充条款", () => {
  for (const anchor of ["polish.system", "polish.user", "polish.vision-question",
    "polish-template.example"]) {
    assert.ok(mountedPromptAnchors().includes(anchor), `锚点未挂载: ${anchor}`);
  }
  const system = promptCopy("polish", "system");
  assert.match(system, /标题：</, "输出契约:首行「标题：…」");
  assert.match(system, /issue-images\//, "图片引用格式点名");
  assert.match(system, /【待补充】/, "缺失信息标注令牌");
  assert.match(system, /不得发明[^。]*attachment:\/\//,
    "对 attachment:// 等其他图片协议的禁止性条款在文(#184 拍板)");
  // 与现实的冲突点已按拍板适配:无 tmpName 目录、无 Read 工具(识图走
  // 图片观察注入),提示词在 md 不在代码字符串。
  const source = readFileSync(
    resolve("assets/issue-prompts/polish.md"), "utf-8");
  assert.doesNotMatch(source, /tmpName/);
  assert.doesNotMatch(source, /Read 工具/);
  const user = promptCopy("polish", "user", {
    title: "T", description: "D", module: "M", environment: "E",
    now: "N", image_observations: "O", template: "TPL",
  });
  assert.match(user, /### 参考模板/, "模板注入槽在位");
  for (const [name, value] of [["标题", "T"], ["D", "D"], ["M", "M"],
    ["E", "E"], ["N", "N"], ["O", "O"]] as const) {
    assert.ok(user.includes(String(value)), `user 模板缺变量占位: ${name}`);
  }
});

test("参考模板独立成档:polish-template.md 与提示词分文件,注入进 user", () => {
  const templatePath = resolve("assets/issue-prompts/polish-template.md");
  const template = readFileSync(templatePath, "utf-8");
  const promptSource = readFileSync(
    resolve("assets/issue-prompts/polish.md"), "utf-8");
  // 分文件拍板(2026-09-11):模板不在提示词 md 里,提示词有注入槽。
  assert.ok(promptSource.includes("{{template}}"),
    "polish.md 有 {{template}} 注入槽");
  assert.doesNotMatch(promptSource, /## 基本信息/, 
    "成品范例不在提示词 md 里维护");
  assert.match(template, /## example/);
  assert.match(template, /^标题：/m, "模板含标题行示例");
  for (const section of ["基本信息", "问题描述", "预期结果", "环境信息"]) {
    assert.ok(template.includes(section), `模板缺章节: ${section}`);
  }
  assert.match(template, /【待补充/, "模板示范待补充令牌");
  assert.doesNotMatch(template, /issue-images\/[0-9a-f]{16}/,
    "模板不得出现可被照抄的图片哈希");
  assert.doesNotMatch(template, /attachment:\/\//);
  // polish.ts 注入链在位。
  const polish = readFileSync(resolve("src/issueFlow/polish.ts"), "utf-8");
  assert.match(polish, /promptCopy\("polish-template", "example"\)/);
});

// ---- 纯函数:输出解析 / 占位符中和 / staging 取图 ----

test("润色输出解析:标题行契约、整体代码块剥壳、无标题行保底", () => {
  const parsed = splitPolishTitle("标题：播放器偶发黑屏\n\n## 基本信息\n\n正文");
  assert.equal(parsed.title, "播放器偶发黑屏");
  assert.match(parsed.description, /^## 基本信息/);
  const fenced = splitPolishTitle("```markdown\n标题：A\n\n正文B\n```");
  assert.equal(fenced.title, "A");
  assert.equal(fenced.description, "正文B");
  const headed = splitPolishTitle("# 标题：A\n\n正文");
  assert.equal(headed.title, "A");
  const noTitle = splitPolishTitle("直接就是正文");
  assert.equal(noTitle.title, undefined);
  assert.equal(noTitle.description, "直接就是正文");
});

test("占位符中和:用户内容里的 {{ 不再撞 promptCopy 残留检查", () => {
  assert.equal(neutralizeTemplateMarks("贴个模板 {{a}} 或 {{b}}"),
    "贴个模板 {\u200b{a}} 或 {\u200b{b}}");
  const vars = {
    title: "T", module: "M", environment: "E", now: "N",
    image_observations: "O", template: "TPL",
  };
  assert.throws(() => promptCopy("polish", "user", {
    ...vars, description: "用户贴了 {{evil}} 模板",
  }), /残留占位符/, "未中和:残留检查应当场抛错");
  const resolved = promptCopy("polish", "user", {
    ...vars, description: neutralizeTemplateMarks("用户贴了 {{evil}} 模板"),
  });
  assert.ok(resolved.includes("用户贴了 {\u200b{evil}} 模板"),
    "中和后的内容原样进模板,placeholder 判定失效");
});

test("staging 取图:引用序去重、上限截断、缺失计数 fail-open", () => {
  const dataDir = mfcTemp("mfc-issue-polish-staging-");
  const pngA = visionProbePng();
  const pngB = Buffer.concat([visionProbePng(), Buffer.from([1])]);
  const refA = stageIssueImage({ data: pngA, contentType: "image/png", dataDir }).path;
  const refB = stageIssueImage({ data: pngB, contentType: "image/png", dataDir }).path;
  const description =
    `![a](${refA}) ![again](${refA}) ![b](${refB}) ![ghost](issue-images/ffffffffffffffff.png)`;
  const { images, missing } = collectStagedImages({ description, dataDir });
  assert.deepEqual(images.map((image) => image.label), [refA, refB],
    "去重保序,缺失引用跳过");
  assert.equal(missing, 1, "staging 缺失计 1");
  const capped = collectStagedImages({ description, dataDir, limit: 1 });
  assert.equal(capped.images.length, 1, "上限截断只留前 1 张");
  assert.equal(capped.missing, 2, "超限引用都进 missing(去重后 3 路 - 1 张)");
});

// ---- 真路由契约:假件运行时注入,不真调网关 ----

interface PolishScene {
  visionText?: string;
  mainText: string;
  visionFail?: boolean;
  mainFail?: boolean;
  calls: { vision: number; main: number };
}

function fakeRuntimeHandle(scene: PolishScene): PolishRuntimeHandle {
  return {
    runtime: {
      getModel: () => ({ id: "fake", input: ["text", "image"] }),
      completeSimple: async (_model: unknown, context: unknown) => {
        const system = String((context as { systemPrompt?: string })?.systemPrompt ?? "");
        if (system.includes("问题单描述撰写助手")) {
          scene.calls.main += 1;
          if (scene.mainFail) {
            return { stopReason: "error", errorMessage: "upstream boom" };
          }
          return { content: [{ type: "text", text: scene.mainText }] };
        }
        scene.calls.vision += 1;
        if (scene.visionFail) throw new Error("识图网关不可达");
        return { content: [{ type: "text", text: scene.visionText ?? "截图显示报错弹窗" }] };
      },
    },
    dispose() { /* 假件无临时目录 */ },
  };
}

/** 与 issueFlowContract 的 issuePost 同款过线协议(浏览器 readBody 路径)。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

const MODELS_JSON = {
  providers: {
    glm: { models: [{ id: "glm-5.1" }, { id: "glm-v", input: ["text", "image"] }] },
  },
};

function polishService(
  dataDir: string,
  options: { vision?: boolean; scene?: PolishScene },
): IssueFlowService {
  return new IssueFlowService({
    dataDir,
    provider: "glm",
    model: "glm-5.1",
    modelsJson: MODELS_JSON,
    ...(options.vision ? { vision: { provider: "glm", model: "glm-v" } } : {}),
    ...(options.scene ? {
      polishRuntimeFactory: async () => fakeRuntimeHandle(options.scene!),
    } : {}),
  });
}

test("真路由契约:润色一次成型,识图观察与截距信息进上下文", async () => {
  const dataDir = mfcTemp("mfc-issue-polish-route-");
  const ref = stageIssueImage({
    data: visionProbePng(), contentType: "image/png", dataDir,
  }).path;
  const scene: PolishScene = {
    visionText: "截图显示登录页报错弹窗:500",
    mainText: "标题：登录页报错弹窗（润色）\n\n## 基本信息\n\n时间：**【待补充】**\n\n![截图](" + ref + ")",
    calls: { vision: 0, main: 0 },
  };
  const service = polishService(dataDir, { vision: true, scene });
  try {
    const detail = await issuePost(["issues", "polish-description"], {
      title: "登录页挂了",
      description: `打开就白屏 ![截图](${ref})`,
      module: "支付核心",
      environment: "10.0.0.8",
    }, service);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.vision_used, true);
    assert.equal(scene.calls.vision, 1, "有图且识图已配:恰一次识图");
    assert.equal(scene.calls.main, 1, "主模型恰一次");
    assert.equal(detail.body.title, "登录页报错弹窗（润色）");
    assert.match(detail.body.description, /【待补充】/);
    assert.match(detail.body.description, new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "图片引用原样保留");
    assert.equal(detail.body.vision_note, undefined, "识图成功无需明示");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("真路由契约:识图未配置/识图失败都 fail-open,回执明示未参考截图", async () => {
  const dataDir = mfcTemp("mfc-issue-polish-failopen-");
  const ref = stageIssueImage({
    data: visionProbePng(), contentType: "image/png", dataDir,
  }).path;
  const payload = {
    title: "登录页挂了",
    description: `打开就白屏 ![截图](${ref})`,
  };
  // 未配置识图:润色照常,note 说明未配置。
  const unconfigured = polishService(dataDir, {
    scene: {
      mainText: "标题：A\n\n正文", calls: { vision: 0, main: 0 },
    },
  });
  try {
    const detail = await issuePost(["issues", "polish-description"], payload,
      unconfigured);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.vision_used, false);
    assert.match(detail.body.vision_note, /未配置/);
    assert.equal(detail.body.title, "A");
  } finally {
    await unconfigured.shutdown().catch(() => undefined);
  }
  // 已配置但识图失败:同样放行,note 说明识图失败。
  const failingScene: PolishScene = {
    mainText: "标题：B\n\n正文",
    visionFail: true,
    calls: { vision: 0, main: 0 },
  };
  const failing = polishService(dataDir, { vision: true, scene: failingScene });
  try {
    const detail = await issuePost(["issues", "polish-description"], payload,
      failing);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.vision_used, false);
    assert.match(detail.body.vision_note, /识图失败/);
    assert.equal(failingScene.calls.main, 1, "识图失败不阻塞主调用");
  } finally {
    await failing.shutdown().catch(() => undefined);
  }
});

test("真路由契约:主模型上游失败 502,空描述 409 人话打回", async () => {
  const dataDir = mfcTemp("mfc-issue-polish-error-");
  const failing = polishService(dataDir, {
    scene: {
      mainText: "", mainFail: true, calls: { vision: 0, main: 0 },
    },
  });
  try {
    const upstream = await issuePost(["issues", "polish-description"], {
      title: "T", description: "描述正文",
    }, failing);
    assert.equal(upstream.status, 502, "PolishModelError → 502(上游故障)");
    assert.match(upstream.body.error, /润色/);
  } finally {
    await failing.shutdown().catch(() => undefined);
  }
  const plain = polishService(dataDir, {});
  try {
    const empty = await issuePost(["issues", "polish-description"], {
      title: "T", description: "   ",
    }, plain);
    assert.equal(empty.status, 409);
    assert.match(empty.body.error, /描述为空/);
  } finally {
    await plain.shutdown().catch(() => undefined);
  }
});

// ---- 前端接线:润色按钮 / 确认弹窗 / 渲染器染红行为 ----

test("登记页接线锚点:润色按钮、确认弹窗、图片预览", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  assert.match(registration, /polishing \? "润色中…" : "AI 润色"/);
  assert.match(registration, /问题描述 <i className="req">\*<\/i><\/span>/,
    "字段名拍板:现象描述→问题描述");
  assert.match(registration,
    /disabled=\{!description\.trim\(\) \|\| polishing\}/,
    "描述为空不可点,润色中防重复");
  assert.match(registration, /polishIssueDescription\(/);
  assert.match(registration, /AI 润色预览/);
  assert.match(registration, /替换原稿/);
  assert.match(registration, />放弃</);
  assert.match(registration, /<Markdown text=\{polishResult\.description\}/,
    "弹窗用自有渲染器预览润色稿");
  assert.match(registration,
    /resolveImage=\{\(path\) => issueImageUrl\(path\)\}/,
    "预览里截图引用渲染成缩略图");
  assert.match(registration, /issue-polish-note/, "识图明示条");
  const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.match(api, /issues\/polish-description/);
  // UI 轨道纪律(CONTEXT.md 2026-09-11):新轨页面的按钮只准 ui/ 包装层。
  assert.match(registration, /@\/components\/ui\/button/,
    "润色按钮与弹窗按钮走 ui/button");
  // 回归锚(2026-09-11 用户实测):润色按钮不许住进 label——label 的
  // 激活转发会把点进描述区的动作转给按钮,改成描述就"自动润色"。
  const btnAt = registration.indexOf("AI 润色");
  const beforeBtn = registration.slice(0, btnAt);
  assert.ok(
    beforeBtn.lastIndexOf("<div") > beforeBtn.lastIndexOf("<label"),
    "润色按钮最近的容器开标签必须是 div,不能是 label");
  // 交互位置拍板(2026-09-11):按钮在描述区下方右下角,魔法星星前缀。
  assert.match(registration, /issue-desc-foot/);
  assert.match(registration, /<Sparkles aria-hidden \/>/);
  // 大图拍板(2026-09-11 方案1):编辑器限高成缩略 + 点击灯箱看原图,
  // 不往 description 里写尺寸标记。
  const editor = readFileSync(
    resolve("web/src/issues/DescriptionEditor.tsx"), "utf-8");
  assert.match(editor, /issue-image-lightbox/);
  assert.match(editor, /setZoom\(target\.getAttribute\("src"\)\)/);
  const css = readFileSync(resolve("web/src/style.css"), "utf-8");
  assert.match(css,
    /\.issue-desc-editor \.ProseMirror img \{[^}]*max-height: 200px/,
    "编辑器图片限高 200px");
  assert.match(css,
    /\.issue-polish-preview img \{[^}]*max-height: 200px/,
    "润色预览图片限高 200px");
  assert.match(css, /\.issue-image-lightbox \{/);
  assert.doesNotMatch(css, /issue-polish-btn/, "手搓按钮皮不许回潮");
});

test("识图熔断门:连续失败 2 次暂停尝试,不烧第三次调用", async () => {
  const { createVisionGate } = await import("../src/issueFlow/polish.ts");
  const gate = createVisionGate(2);
  assert.equal(gate.allow(), true);
  gate.record(false);
  assert.equal(gate.allow(), true, "第 1 次失败后仍允许");
  gate.record(false);
  assert.equal(gate.allow(), false, "连续 2 失败即熔断");
  gate.record(true);
  assert.equal(gate.allow(), true, "一次成功复位");
});

test("真路由契约:识图熔断后第三次请求不再调识图,回执仍明示", async () => {
  const dataDir = mfcTemp("mfc-issue-polish-circuit-");
  const ref = stageIssueImage({
    data: visionProbePng(), contentType: "image/png", dataDir,
  }).path;
  const scene: PolishScene = {
    mainText: "标题：A\n\n正文",
    visionFail: true,
    calls: { vision: 0, main: 0 },
  };
  const service = polishService(dataDir, { vision: true, scene });
  try {
    const payload = { title: "T", description: `白屏 ![截图](${ref})` };
    for (let round = 1; round <= 3; round += 1) {
      const detail = await issuePost(["issues", "polish-description"],
        payload, service);
      assert.equal(detail.status, 200, `第 ${round} 轮仍放行润色`);
    }
    assert.equal(scene.calls.vision, 2, "熔断前恰好尝试 2 次");
    assert.equal(scene.calls.main, 3, "润色主调用全程不被熔断阻塞");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("待补充令牌染红:加粗含令牌才带 md-pending,普通加粗不带", () => {
  assert.ok(hasPendingMark("**【待补充】**".slice(2, -2)));
  const html = renderToStaticMarkup(
    React.createElement(Markdown, {
      text: "**【待补充：版本】** 与 **普通加粗**",
    }));
  assert.match(html, /<b class="md-pending">/, "含令牌的加粗染红");
  assert.match(html, /<b>普通加粗<\/b>/, "普通加粗不受牵连");
});


// ---- 票2:所见即所得编辑器(milkdown)与引用两个世界的映射 ----

test("截图引用映射:存储相对引用与编辑器预览 URL 双向收敛", () => {
  const ref = "issue-images/abcd1234ef567890.png";
  const url = `/issues/issue-image?path=${encodeURIComponent(ref)}`;
  const markdown = `前文\n\n![截图](${ref})\n\n后文 **【待补充】**`;
  const displayed = refToDisplayUrl(markdown, (r) =>
    `/issues/issue-image?path=${encodeURIComponent(r)}`);
  assert.match(displayed, new RegExp(`!\\[截图\\]\\(${url.replace(/[?]/g, "\\?")}\\)`),
    "进编辑器:引用换成可显示的预览 URL");
  const serialized = `前文\n\n![截图](${url})\n\n后文`;
  assert.equal(displayUrlToRef(serialized),
    `前文\n\n![截图](${ref})\n\n后文`,
    "出编辑器:序列化文本换回相对引用,管线不见预览 URL");
  assert.equal(displayUrlToRef(markdown), markdown,
    "本来就相对引用的文本原样通过");
});

test("登记页接线锚点:描述框是 milkdown 编辑器,粘贴上传走原接口", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  assert.match(registration,
    /<DescriptionEditor value=\{description\} onChange=\{setDescription\}/,
    "描述框换成所见即所得编辑器,值回路接 description");
  assert.match(registration, /onUploadImage=\{uploadIssueFile\}/,
    "编辑器上传钩子接登记上传");
  assert.match(registration, /uploadIssueImage\(file\)/,
    "上传仍走既有 staging 接口");
  assert.doesNotMatch(registration, /<textarea/,
    "裸 textarea 退役——描述框是它的最后据点");
  const editor = readFileSync(
    resolve("web/src/issues/DescriptionEditor.tsx"), "utf-8");
  assert.match(editor, /@milkdown\/kit\/core/, "milkdown(ProseMirror 内核)");
  assert.match(editor, /preset\/commonmark/);
  assert.match(editor, /preset\/gfm/, "表格/任务列表");
  assert.match(editor, /@milkdown\/kit\/plugin\/upload/, "粘贴/拖拽上传插件");
  assert.match(editor, /uploader: async \(files: FileList, schema: any\)/,
    "自定义上传器:上传后插入光标位置");
  assert.match(editor, /createAndFill\?\.\(\{/, 
    "图片节点用 ProseMirror 标准构造(createAndFill)");
  assert.match(editor, /issueImageUrl\(ref\)/, "插入的是预览 URL(显示世界)");
  assert.match(editor, /displayUrlToRef\(markdown\)/, "出场即映射回相对引用");
  assert.match(editor, /replaceAll\(refToDisplayUrl\(value, issueImageUrl\)\)/,
    "外部值变更(润色替换回填)整体重排");
  assert.match(editor, /【待补充】/, "令牌约定留痕:编辑器内不做特殊化");
  const refModule = readFileSync(
    resolve("web/src/issues/issueImageRef.ts"), "utf-8");
  assert.match(refModule, /issue-images\\\/\[0-9a-f\]\{16\}/,
    "引用形态与 issueImages.parseIssueImagePath 同口径");
});
