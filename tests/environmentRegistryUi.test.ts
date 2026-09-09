/**
 * 环境管理页签的 UI 契约(票 #149;先例:issueUiContracts.test.ts)。
 *
 * 只断言源码里外部可见的结构与交互锚点:导航入口、深链路由、列表列、
 * 表单字段、密码不回显语义、409 引导、删除二次确认、标签筛选与空态。
 * 不测样式实现细节;样式纪律(#146)由断言"全工具类、不 import css、
 * 不硬编码色值"表达,css 层不新增任何东西由 cssOverrideRatchet 兜底。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
const page = readFileSync(resolve("web/src/EnvironmentRegistry.tsx"), "utf-8");

test("环境管理:侧栏导航入口存在,且按团队资源分组(不进 admin 专属系统管理)", () => {
  const nav = app.slice(app.indexOf('aria-label="视图切换"'), app.indexOf("</nav>"));
  const adminNav = nav.slice(
    nav.indexOf('session.role === "admin" ? <>'), nav.indexOf("</> : <>"));
  const devNav = nav.slice(nav.indexOf("</> : <>"));
  for (const [branch, source] of [["admin", adminNav], ["developer", devNav]] as const) {
    assert.ok(source.includes('<NavButton view="environments"'),
      `${branch} 侧栏缺少环境管理入口`);
    assert.ok(source.includes('label="环境管理"'), `${branch} 入口文案缺失`);
  }
  // 台账是全局团队资源:admin 在「管理视角」组(与团队资产并列),
  // 排在 admin 专属的「系统管理」(admin-tools)之前;开发在「团队信息」组。
  assert.ok(adminNav.indexOf("环境管理") > adminNav.indexOf("管理视角")
    && adminNav.indexOf("环境管理") < adminNav.indexOf("admin-tools"),
    "admin 侧环境管理应在管理视角组、系统管理之前");
  assert.ok(devNav.indexOf("环境管理") > devNav.indexOf("团队信息"),
    "开发侧环境管理应归团队信息组");
});

test("环境管理:/environments 深链与视图接线(进可直达、后退真切页)", () => {
  assert.match(app, /\/\^\\\/environments\\\/\?\$\/\.test\(location\.pathname\)/,
    "缺少 /environments 路径匹配");
  assert.match(app, /if \(readEnvironmentRoute\(\)\) return "environments";/,
    "深链未接入 initialView(登录/刷新后应直达页签)");
  assert.match(app,
    /history\.pushState\(appHistoryState\("environments"\), "", "\/environments"\)/,
    "进页签应 pushState 换地址(可复制、可后退)");
  assert.match(app, /const syncEnvironmentRoute = \(event: PopStateEvent\) =>/,
    "浏览器前进/后退要真的切页(popstate 同步)");
  assert.match(app, /\{view === "environments" && <EnvironmentRegistry \/>\}/,
    "主区缺少环境管理视图渲染");
  assert.match(app, /import \{ EnvironmentRegistry \} from "\.\/EnvironmentRegistry";/);
});

test("环境管理:页面是新 Tailwind 轨道——tw-root 归一、零 css import、零硬编码色值", () => {
  assert.match(page, /className="tw-root /, "页面根必须挂 .tw-root(scoped 归一)");
  assert.doesNotMatch(page, /from "[^"]*\.css"/, "组件不得 import css 文件");
  assert.doesNotMatch(page, /!important/);
  // 令牌纪律(#146 第 4 条):禁止 bg-[#fff] 式任意值绕过 @theme 令牌。
  assert.doesNotMatch(page, /(bg|text|border|ring|fill|stroke|from|to|via)-\[#/,
    "禁止硬编码色值,颜色一律走令牌工具类");
});

test("环境管理:列表列锚点(主 IP/形态/端口/标签/状态/更新人/更新时间)", () => {
  const header = page.slice(page.indexOf("<TableHeader>"), page.indexOf("</TableHeader>"));
  for (const column of ["主 IP", "形态", "端口", "标签", "状态", "更新人", "更新时间"]) {
    assert.ok(header.includes(column), `列表缺少「${column}」列`);
  }
  // 状态列本期只有未验证一态;三态码表就位,#151 探活点亮其余。
  assert.match(page, /PROBE_TEXT: Record<EnvironmentView\["probe"\]\["state"\], string>/);
  assert.match(page, /unverified: "未验证",\s*\n\s*ok: "正常",\s*\n\s*failed: "异常"/);
});

test("环境管理:表单字段锚点(形态下拉、root 密码 placeholder、标签回车成签)", () => {
  assert.match(page, /虚拟化\(经网管节点\)/);
  assert.match(page, /<SelectItem value="k8s">容器化\(经 OM 节点\)<\/SelectItem>/);
  // root 密码:placeholder 引导"留空时与后台密码相同"(数据层恒有有效值)。
  assert.match(page,
    /root 密码\(可选\)[\s\S]*?placeholder="留空时与后台密码相同"/);
  // 标签:自由输入,回车成标签;输入法组词中的回车不算提交。
  assert.match(page, /function commitTagDraft\(event: KeyboardEvent<HTMLInputElement>\)/);
  assert.match(page, /if \(event\.key !== "Enter" \|\| event\.nativeEvent\.isComposing\) return;/);
});

test("环境管理:密码永不回显——编辑显示已配置占位,留空=不变(不进 payload)", () => {
  // 编辑态占位:只说"已配置",值永远不回填进表单。
  assert.match(page, /placeholder=\{existing \? "已配置——留空表示不变" : "[^"]*"\}/);
  assert.match(page, /后台密码[\s\S]*?type="password"/);
  // 留空 = 不变的 wire 语义:空串根本不进 PUT payload(缺席,而非空串)。
  assert.match(page,
    /\.\.\.\(backendPassword \? \{ backend_password: backendPassword \} : \{\}\)/);
  assert.match(page, /type="password"[\s\S]*?autoComplete="new-password"/);
  // api 镜像:patch 类型明确"缺席 = 不变"的可选形状。
  assert.match(api, /backend_password\?: string;/);
  assert.match(api, /root_password\?: string \| null;/);
  // 清显式 root 密码回落继承:PUT 送 null(缺席 = 不变,null = 清除)。
  assert.match(page, /\.\.\.\(clearRoot \? \{ root_password: null \}/);
  assert.match(page, /清除并回落继承/);
});

test("环境管理:视图零密码字段——机密只出两个非密布尔", () => {
  const viewIface = api.slice(
    api.indexOf("export interface EnvironmentView"),
    api.indexOf("export class EnvironmentIpConflictError"));
  assert.ok(viewIface.length > 0, "api.ts 缺少 EnvironmentView 镜像");
  assert.doesNotMatch(viewIface, /backend_password|backendPassword|root_password[^_]/,
    "台账视图不得携带任何密码字段");
  assert.match(viewIface, /root_password_inherited: boolean;/);
  assert.match(viewIface, /password_configured: boolean;/);
});

test("环境管理:IP 撞车 409 在表单内报「该 IP 已存在于台账」并引导编辑既有条目", () => {
  assert.match(page, /该 IP 已存在于台账/);
  assert.match(page, /编辑既有条目\(\{conflict\.ip\}\)/);
  assert.match(page, /cause instanceof EnvironmentIpConflictError/);
  assert.match(page,
    /environments\.find\(\(entry\) => entry\.id === cause\.existingId\)/);
  // api:409 带 existing_id,映射成带既有条目 id 的类型化错误。
  assert.match(api, /export class EnvironmentIpConflictError extends Error/);
  assert.match(api, /typeof body\.existing_id === "string"/);
  assert.match(api, /new EnvironmentIpConflictError\(body\.existing_id\)/);
});

test("环境管理:删除走全站 confirmDialog 二次确认,并交代快照不受影响", () => {
  const removal = page.slice(
    page.indexOf("async function removeEnvironment"),
    page.indexOf("return <section"));
  assert.match(removal, /await confirmDialog\(\{/);
  assert.match(removal, /danger: true/);
  assert.match(removal, /删除环境 \$\{entry\.ip\}/);
  assert.match(removal, /快照/);
  assert.match(removal, /await deleteEnvironment\(entry\.id\);/);
});

test("环境管理:标签筛选(下拉 + 点行内标签徽标)与清除筛选", () => {
  assert.match(page, /aria-label="按标签筛选"/);
  assert.match(page, /<SelectItem value=\{ALL_TAGS\}>全部标签<\/SelectItem>/);
  assert.match(page,
    /onClick=\{\(\) => setActiveTag\(tag === activeTag \? "" : tag\)\}/);
  assert.match(page, /清除筛选/);
});

test("环境管理:空态引导(还没有环境,点新增录入第一个)", () => {
  const empty = page.slice(
    page.indexOf('data-testid="environment-registry-empty"'),
    page.indexOf("<Table "));
  assert.match(empty, /还没有环境/);
  assert.match(empty, /新增环境/);
  assert.match(empty, /录入第一个网管环境/);
});

test("环境管理:数据加载沿视图自取惯例——挂载拉取,增改删后刷新台账", () => {
  assert.match(page, /useEffect\(\(\) => \{ void refreshEnvironments\(\); \}, \[\]\);/);
  assert.match(page, /setEnvironments\(await listEnvironments\(\)\);/);
  assert.match(page, /onSaved=\{\(\) => \{[\s\S]*?refreshEnvironments\(\)/);
  // 四个 API 函数都从 api.ts 取(api.ts 里存在类型化函数,形状由服务端测试兜底)。
  for (const name of ["listEnvironments", "createEnvironment", "updateEnvironment", "deleteEnvironment"]) {
    assert.match(api, new RegExp(`export async function ${name}\\(`),
      `api.ts 缺少 ${name}`);
    assert.match(page, new RegExp(`\\b${name}\\(`), `页面未使用 ${name}`);
  }
});
