import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const markdownSource = readFileSync(resolve("web/src/markdown.tsx"), "utf-8");
const cssSource = readFileSync(resolve("web/src/help.css"), "utf-8");
const lubanSource = readFileSync(resolve("web/src/LubanTokenCard.tsx"), "utf-8");
const settingsSource = readFileSync(resolve("web/src/SettingsView.tsx"), "utf-8");

test("使用帮助覆盖所有主功能，文章 id 和截图地址不会互相打架", () => {
  const ids = [...source.matchAll(/^\s{4}id: "([a-z-]+)",$/gm)]
    .map((match) => match[1]);
  assert.ok(ids.length >= 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of ["快速开始", "需求与问题", "团队协作", "团队资产", "设置与排障"]) {
    assert.match(source, new RegExp(`group: "${group}"`));
  }
  const screenshots = [...source.matchAll(/src: `\$\{SHOT_ROOT\}\/([^`]+\.png)`/g)]
    .map((match) => match[1]);
  assert.equal(screenshots.length, 13);
  assert.equal(new Set(screenshots).size, screenshots.length);
  for (const screenshot of screenshots) {
    assert.match(screenshot, /^\d{2}-[a-z-]+\.png$/);
    const png = readFileSync(resolve("web/public/help", screenshot));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a",
      `${screenshot} 必须是真实 PNG 文件`);
    assert.equal(png.readUInt32BE(16), 1600, `${screenshot} 视口宽度不统一`);
    assert.equal(png.readUInt32BE(20), 1000, `${screenshot} 视口高度不统一`);
  }
});

test("帮助文章能搜动作和提示，不要求用户记住内部功能名", () => {
  for (const phrase of ["/mfc", "编译超时", "自动匹配", "自由回复", "PlantUML"]) {
    assert.ok(source.includes(phrase), `缺少用户会直接搜索的词：${phrase}`);
  }
  assert.match(source, /article\.title, article\.summary, article\.group, article\.body/);
  assert.match(source, /article\.steps\.flatMap/);
});

test("个人设置的小鲁班卡直接说明 /mfc 激活前置条件", () => {
  assert.match(lubanSource, /手机回复/);
  assert.match(lubanSource, /<code>\/mfc<\/code> 激活 Mae-Flow 插件/);
});

test("服务设置总览汇总真实配置，并可进入四类完整管理表单", () => {
  for (const label of ["模型与图片识别", "真实部署自检", "团队统一约定", "现场与构建缓存"]) {
    assert.match(settingsSource, new RegExp(label));
  }
  for (const target of ["settings-models", "settings-check", "settings-policy", "settings-runtime"]) {
    assert.match(settingsSource, new RegExp(`go\\(\"${target}\"\\)`));
  }
  assert.match(settingsSource, /checkError \? "检查失败"/);
  assert.match(settingsSource,
    /<SystemCheckCard onResult=\{\(result, nextError = ""\) => \{/);
  assert.match(settingsSource, /密钥不会在总览或表单中回显/);
});

test("问题 FAQ 使用当前登记入口和真实口令边界", () => {
  assert.match(source, /手工登记（无单）/);
  assert.match(source, /团队资产 → 业务模块/);
  assert.match(source, /DTS 列表（已有单）/);
  assert.match(source, /页面账号默认 admin/);
  assert.match(source, /AI 上下文/);
  assert.match(source, /不会出现在会话列表、状态摘要或事件流中/);
  assert.match(source, /个人复用或生产口令/);
  assert.doesNotMatch(source, /有 DTS 单号时一并提供/);
  assert.doesNotMatch(source, /密码不会出现在聊天内容里/);
});

test("批注 FAQ 说明管理员代办的当前复检边界、二次确认和审计", () => {
  assert.match(source, /当前工作区复检/);
  assert.match(source, /本轮仍待闭环的他人已提交意见/);
  assert.match(source, /草稿、历史意见、已闭环意见和管理员自己的意见都不会显示入口/);
  assert.match(source, /第一次点击只进入确认，第二次点击才执行/);
  assert.match(source, /实际执行的管理员和原批注作者/);
});

test("角色保护覆盖目录、直链、快捷卡和相关推荐", () => {
  assert.match(source, /filterVisibleHelpItems\(HELP_ARTICLES, audience\)/);
  assert.match(source,
    /findHelpArticle\(initialArticleId, viewer\.role\)/);
  assert.match(source,
    /QUICK_LINKS\.filter\([\s\S]*canViewHelpItem\(target, viewer\.role\)/);
  assert.match(source,
    /visibleHelpItemsById\(\s*HELP_ARTICLES, article\.related \?\? \[\], viewer\.role\)/);
  assert.match(source,
    /quickLinks\.map\(\(item, index\)[\s\S]*String\(index \+ 1\)\.padStart\(2, "0"\)/,
  "快捷卡编号必须按当前角色可见列表重排，不能留下 03 这种断号");
});

test("外部路径变化会同步文章，点击文章会留下可前进后退的历史", () => {
  assert.match(source,
    /useEffect\(\(\) => \{[\s\S]*findHelpArticle\(initialArticleId, viewer\.role\)[\s\S]*setSelectedId\(next\.id\)[\s\S]*\}, \[initialArticleId, viewer\.role\]\)/);
  assert.match(appSource,
    /onArticleChange=\{\(articleId\) => \{[\s\S]*history\.pushState\(\{\}, "", `\/help\/\$\{encodeURIComponent\(articleId\)\}`\)/);
});

test("帮助说大白话，重点色只使用蓝绿红三种固定意思", () => {
  assert.match(source, /\{\{blue\|/);
  assert.match(source, /\{\{green\|/);
  assert.match(source, /\{\{red\|/);
  assert.match(markdownSource, /blue\|green\|red/);
  assert.doesNotMatch(source,
    /\b(?:revision|copied_from|Playbook|snapshot)\b|轻量索引|人工节点|生命周期|深链/);
});

test("真实截图可用键盘打开，并能通过关闭按钮、背景和 Esc 退出", () => {
  assert.match(source,
    /className="help-shot-frame"[\s\S]*onClick=\{\(\) => setExpanded\(true\)\}[\s\S]*aria-label=\{`放大查看：/);
  assert.match(source,
    /className="help-lightbox" role="dialog" aria-modal="true"/);
  assert.match(source, /aria-label="关闭图片预览"/);
  assert.match(source,
    /if \(event\.target === event\.currentTarget\) setExpanded\(false\)/);
  assert.match(source,
    /event\.key === "Escape"[\s\S]*setExpanded\(false\)/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /openButtonRef\.current\?\.focus\(\)/);
});

test("截图预览锁住背景且限制在视口内，加载失败不留下破图", () => {
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
  assert.match(source,
    /function hideOnError\(\) \{[\s\S]*setExpanded\(false\);[\s\S]*setFailed\(true\)/);
  assert.equal((source.match(/onError=\{hideOnError\}/g) ?? []).length, 2);
  assert.match(cssSource,
    /\.help-lightbox-backdrop \{[\s\S]*max-width: 100vw;[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/);
  assert.match(cssSource,
    /\.help-lightbox-image img \{[\s\S]*width: 100%;[\s\S]*max-width: 100%;[\s\S]*height: 100%;[\s\S]*max-height: 100%;[\s\S]*object-fit: contain;/);
});
