import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const taskCard = readFileSync(
  join(process.cwd(), "web/src/TaskCard.tsx"), "utf8");

test("决策背景展开后由外层真实占位，不能与后续问题重叠", () => {
  const legacyWorkspaceRule = css.indexOf(".ws-decision .waiting-context {");
  const layoutOverride = css.lastIndexOf(".ws-decision .waiting-context {");
  assert.ok(legacyWorkspaceRule >= 0, "应覆盖工作台原有的决策背景规则");
  assert.ok(layoutOverride > legacyWorkspaceRule,
    "解除高度上限的规则必须位于旧工作台规则之后，才能赢得层叠");

  const overrideBody = css.slice(layoutOverride, layoutOverride + 120);
  assert.match(overrideBody, /max-height:\s*none/);
  assert.match(overrideBody, /overflow:\s*visible/);
});

test("长检视内容在抽屉内自己滚动，不把整页撑高", () => {
  assert.match(workspace,
    /className="workspace-review-drawer"\s+role="complementary"/);
  assert.match(css, /\.workspace-review-drawer\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.workspace-review-drawer\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace-review-content\s*\{[^}]*overflow:\s*auto/s);
});

test("交付材料提供统一全屏入口且 Escape 先退出全屏", () => {
  assert.match(workspace, /materialsFullscreen/);
  assert.match(workspace, /全屏查看/);
  assert.match(workspace, /退出全屏/);
  assert.match(workspace,
    /if \(materialsFullscreen\) setMaterialsFullscreen\(false\)/);
  assert.match(css, /\.workspace-overlay\.materials-fullscreen \.ws-decision/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("待闭环检视通过常驻按钮提示，但不自动接管当前工作面", () => {
  // 入口卡与筛选条的数字统一走"等我确认"口径(annotationCategory + 反馈
  // needs_human),不再另算一套"待处理"。
  // 2026-09-02 二改:抽屉标题栏原来还挂第三份同一个数,它下面 40px 就是
  // 筛选条的"等我确认 N",打开前入口按钮上也有——同一屏三份,眼睛先去数
  // 数字。计数只留在能点的地方(入口按钮和筛选条),标题栏只留关闭。
  assert.match(workspace, /className=\{`ws-review-launch/);
  assert.match(workspace, /\$\{reviewCounts\.mine\} 等我确认/);
  assert.doesNotMatch(workspace, /\$\{reviewCounts\.mine\} 项等我确认/,
    "抽屉标题栏不再重复计数");
  assert.match(workspace, /onClick=\{\(\) => setReviewPanelOpen\(true\)\}/);
  assert.doesNotMatch(workspace, /openedReviewAttention|previousReviewActionCount/,
    "批注出现时只亮入口，不应自动弹出并抢走当前任务");
});

test("批注弹层与 Agent 决定卡互不接管，也绝不自动代选", () => {
  assert.match(workspace, /waiting && canOperate && \(/,
    "Grill、方案确认和 push 确认都必须持续渲染决定卡");
  assert.doesNotMatch(workspace, /finalDecisionDeferred|reviewTakesFocus/,
    "打开批注不能卸载或改写当前决定卡");
  assert.match(workspace, /aria-label="关闭批注与检视"/);
  assert.match(workspace, /if \(reviewPanelOpen\) setReviewPanelOpen\(false\)/,
    "Escape 应先关闭批注弹层，再退出整个工作台");
  assert.doesNotMatch(taskCard, /setPicked\(\(current\) =>[\s\S]{0,900}feedbackAnswers/,
    "意见未闭环只能阻止放行，不能替用户默认选择返工或确认推送");
});

test("旧代码锚点消失时在材料侧给出明确反馈", () => {
  assert.match(workspace, /check\?\.state === "gone"/);
  assert.match(workspace, /批注位置已变化/);
  assert.match(workspace, /已不在当前版本/);
  assert.match(css, /\.annotation-location-notice\s*\{/);
});

test("批注与检视是固定在右侧的侧滑抽屉:材料露出可点,定位不必先关窗", () => {
  // 原来是遮罩弹层,看意见时看不到材料,"回到那一行"要先关窗(用户定调
  // 这块是核心竞争力、易用性优先后改成抽屉)。第一版把抽屉挤进 .ws-body
  // 栅格右栏,中等宽度下正文切成上下堆叠时抽屉被当普通块塞到最下面、
  // 材料区头部被裁(用户截图实锤"看着都像 bug"),改成固定定位侧滑面板,
  // 任何宽度行为一致。
  assert.match(workspace, /className="workspace-review-drawer"/);
  assert.doesNotMatch(workspace, /has-review/, "抽屉不再进正文栅格");
  assert.doesNotMatch(workspace,
    /reviewPanelOpen && <div className="workspace-review-backdrop"/,
    "批注与检视不再是遮罩弹层");
  assert.match(workspace,
    /if \(window\.matchMedia\("\(max-width: 900px\)"\)\.matches\) \{\s*setReviewPanelOpen\(false\);/,
    "只有窄屏(抽屉占满整屏)定位时才关抽屉");
  // 2026-09-02 二改:抽屉原来 top/right/bottom 全是 0,四边贴死视口——
  // 用户实测截图"上下都顶到头了,都没显示全"。它还正好盖住任务头右侧的
  // "暂停/取消"(1512 宽下按钮在 x1152-1258),要暂停任务得先关面板。现在
  // 从任务头下面起步并留出边距,面板看得见边界,任务头照常能点。
  assert.match(css,
    /\.workspace-review-drawer\s*\{[^}]*position:\s*fixed[^}]*top:\s*calc\(var\(--ws-head-h[^}]*right:\s*10px[^}]*bottom:\s*10px[^}]*width:\s*min\(760px, calc\(100vw - 20px\)\)/s);
  assert.match(css, /\.workspace-review-drawer\s*\{[^}]*border-radius:\s*14px/s,
    "四边不再贴死视口,要有可见的面板边界");
  assert.match(workspace, /--ws-head-h/,
    "任务头高度由页面实测下发,不能在 CSS 里写死");
  assert.doesNotMatch(css, /\.ws-body\.has-review/);
  assert.match(css,
    /@media \(max-width: 900px\) \{[^@]*\.workspace-review-drawer \{[^}]*width:\s*100vw/s,
    "窄屏仍占满任务头以下整块");
  assert.doesNotMatch(workspace, /setWorkspaceView\("insights"\)/,
    "打开抽屉不能改掉交付材料、开发协作或执行现场的当前页签");
});

test("锚定原文收进批注头部,左栏整列让给批注正文", () => {
  // 用户实测:"针对 1. 缺失变量输出空串并记录 warn 日志;"这行完全没必要
  // 在左边。它原来是整块引言、单占左栏一行,760px 抽屉里两栏本就只有
  // 304 和 357,正文和 Agent 回应被挤成两条窄柱。它只是"指着哪儿"的补充,
  // 接在位置后面收一行即可,整段留在 title 里、点位置也能回到那一行。
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  const head = panel.indexOf('className="annot-item-head"');
  const anchorAt = panel.indexOf("annot-anchor", head);
  const progressAt = panel.indexOf("annot-progress", head);
  assert.ok(head >= 0 && anchorAt > head && anchorAt < progressAt,
    "锚定原文应在 annot-item-head 里、排在状态之前");
  assert.match(panel, /className="annot-anchor"\s*\n?\s*title=\{item\.anchor\}/,
    "截断后整段必须还在 title 里,不能丢");
  assert.doesNotMatch(panel, /<span>针对<\/span>/,
    "锚定原文接在位置后面,不需要引导词");

  const annotate = readFileSync(
    join(process.cwd(), "web/src/annotate.css"), "utf8");
  assert.match(annotate,
    /grid-template-areas:\s*"head head"\s*"route route"\s*"note response"\s*"foot foot"/s);
  assert.doesNotMatch(annotate, /grid-area:\s*anchor/,
    "anchor 那一行已经没有了");
  // 归属徽标原来没给区域,自动排版把它丢进末尾空着的 stale 行,"Agent 处理"
  // 于是落在页脚下面(实测 foot 底 940px、徽标 948px)。
  assert.match(annotate, /\.annot-route-badge \{\s*grid-area: route/,
    "归属徽标必须有明确区域,否则会被排到页脚后面");
});

test("检视意见原文和 Agent 回应是对称的两块,不是正文配卡片", () => {
  // 左边原来是一段裸文字,右边是带标题的绿色块,读起来像"正文旁边配了张
  // 卡片"而不是一问一答;而且没有一处说明左边那段到底是什么。
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(panel,
    /<div className="annot-note">\s*<strong>检视意见原文<\/strong>/,
    "意见块要明说自己是检视意见原文");
  const annotate = readFileSync(
    join(process.cwd(), "web/src/annotate.css"), "utf8");
  const note = annotate.slice(annotate.indexOf(".annot-note {"),
    annotate.indexOf(".annot-note > strong"));
  assert.match(note, /border-left:\s*3px solid var\(--accent\)/);
  assert.match(note, /background:\s*color-mix\(in srgb, var\(--accent\) 7%/);
  const response = annotate.slice(annotate.indexOf(".annot-response {"),
    annotate.indexOf(".annot-response.not_fixed"));
  assert.match(response, /border-left:\s*3px solid var\(--success\)/,
    "两块共用同一套块形,只靠颜色区分人和 Agent");
});

test("抽屉标题栏按自己的高度占位,副标题不被裁", () => {
  // 抽屉是竖向 flex,标题栏默认会被内容区压缩到 min-height:420px 宽下
  // 它要 85px 只拿到 64px,副标题有半行被裁在边框外。
  assert.match(css, /\.workspace-review-drawer > header \{[^}]*flex:\s*none/s);
  assert.match(css,
    /@media \(max-width: 900px\) \{[^@]*\.workspace-review-drawer > header p \{ display: none; \}/s,
    "窄屏抽屉占满整屏,副标题那句'左侧材料仍可圈选'不成立就别说");
});

test("抽屉打开时收起提问题浮钮,底部不再靠留白躲它", () => {
  // 浮钮挂在 .workspace-overlay(z-index 120)之外、自己 650,和抽屉的 950
  // 不在同一个栈里比,所以照样压在抽屉右下角。原先靠内容底部留 84px 空白
  // 躲开:空白本身就在浮钮底下,最后一条的操作还是点不到,只白白少一屏。
  assert.match(css,
    /body:has\(\.workspace-review-drawer\) \.wish-quick-trigger \{ display: none; \}/);
  assert.doesNotMatch(css,
    /\.workspace-review-drawer > \.workspace-review-content \{ padding: 12px 12px 84px; \}/,
    "浮钮已经收起,底部不该再留那段躲避用的死白");
  // macOS 悬浮滚动条不滚不出现,面板又比一屏长得多(实测 10 条 ≈ 2887px),
  // 不给常驻滚动槽和底部渐隐,看到的就是"内容被截断"。
  assert.match(css,
    /\.workspace-review-drawer > \.workspace-review-content \{[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /\.workspace-review-drawer::after \{[^}]*linear-gradient\(to top, var\(--page\)/s);
});

test("批注与检视顶部有处理归属筛选条,CodeHub 意见可转成工作台批注", () => {
  assert.match(workspace, /className="review-filter" role="tablist"/);
  assert.match(workspace, /\["mine", "等我确认"\]/);
  assert.match(workspace, /\["agent", "Agent 处理中"\]/);
  assert.match(workspace, /\["closed", "已闭环"\]/);
  assert.match(workspace, /filter=\{reviewFilter\}/, "批注面板吃同一个筛选档");
  assert.match(workspace, /onConvert=\{canContributeReview && canCreateAnnotation/,
    "转批注沿用批注创建权限");
  assert.match(workspace, /【转自 \$\{origin\}】/);
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(panel, /export function annotationCategory/);
  assert.match(panel, /const visibleItems = filter === "all" \? orderedItems/);
  assert.match(css, /\.review-filter\s*\{/);
  assert.match(css, /\.feedback-convert\s*\{/);
});

test("进度词表只在内核一份,前端不再自带阶段名;反馈按来源逐条展示", () => {
  // 原来前端有三套阶段字面量(协调中、持续检视、无内核兜底),与内核看板
  // 各说各话,老任务停在哪套显示哪套。现在一律吃任务 API 的 progress。
  assert.doesNotMatch(workspace,
    /\["配置与需求", "方案", "开发", "持续检视", "已合入"\]/);
  assert.doesNotMatch(workspace, /"已受理", "需求理解"/);
  assert.match(workspace, /current_phase: "尚未进入阶段"/);
  assert.match(workspace, /function FeedbackPanel/);
  assert.match(workspace, /FEEDBACK_SOURCE_LABEL/);
  assert.match(workspace, /item\.summary/,
    "界面必须展示反馈正文，不能只给数量");
  assert.match(workspace, /FEEDBACK_STATUS_LABEL/);
});

test("持续检视意见:进度条下不再有摘要条,进行中数写进入口卡,正文按来源列进批注与检视", () => {
  // 原来所有意见塞在进度条下横向滚动的小卡片里(9–11px、单行省略),MR
  // 检视人一段话被压成一行,用户实锤"排版太丑"。第二版换成一条摘要
  // (一排"MR 检视 3 2 进行中"胶囊 + 重复的入口按钮),用户再实锤"数字
  // 好丑、和批注与检视卡重叠"——整条撤掉,几条进行中并进入口卡副标题。
  assert.doesNotMatch(workspace, /FeedbackSummary|feedback-summary/);
  assert.doesNotMatch(css, /\.feedback-summary/);
  assert.match(workspace, /条检视意见进行中/);
  assert.match(workspace, /<small>\{feedbackDigest \|\| "批注、CodeHub 检视意见与机器检视"\}<\/small>/);
  assert.match(workspace, /function FeedbackList/);
  assert.match(workspace, /title="来自 CodeHub 的检视意见"/);
  assert.match(workspace, /item\.source === "mr_discussion"\)/);
  assert.match(workspace, /mrUrl=\{task\.delivery\?\.mr_url\}/,
    "CodeHub 意见列表要给回到 MR 的入口");
  assert.match(workspace, /title="来自流水线与机器门禁的告警"/);
  // 三节同一口径:来自 Cloud 工作台 / 来自 CodeHub / 来自流水线与机器门禁
  // (用户实锤:第一节只叫"批注"时读不出它就是 Cloud 平台上的检视意见)。
  const panelSource = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(panelSource, /<strong>来自 Cloud 工作台的检视意见<\/strong>/);
  assert.match(workspace, /item\.source !== "mr_discussion" && item\.source !== "workspace"/,
    "工作台批注已由批注卡片承载,不重复列");
  assert.match(workspace, /已回复，等检视人确认/);
  assert.match(workspace, /检视人 \$\{item\.author\}/);
  assert.match(workspace, /className="feedback-body"/);
  assert.match(css, /\.feedback-list\s*\{/);
  assert.match(css, /\.feedback-body\s*\{[^}]*white-space:\s*pre-wrap/,
    "意见正文原样换行,不再单行省略");
  assert.doesNotMatch(css, /\.feedback-groups\s*\{/,
    "横向卡片墙已删,不许悄悄回来");
});

test("批注与检视弹层里的批注面板默认展开", () => {
  // 弹层是人主动点开的,正文再折叠一层等于让人点两次(用户实锤)。
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(panel, /const \[open, setOpen\] = useState\(true\)/);
  assert.doesNotMatch(panel, /useState\(drafts\.length > 0/);
  // Agent 对批注的回应也是多行正文,换行要保住(用户实锤"只显示一行")。
  const annotateCss = readFileSync(
    join(process.cwd(), "web/src/annotate.css"), "utf8");
  assert.match(annotateCss,
    /\.annot-response p \{[^}]*white-space:\s*pre-wrap/);
});

test("执行中的任务默认打开执行现场", () => {
  assert.match(workspace,
    /\["queued", "running", "pausing", "verifying", "await_merge"\]/);
  assert.match(workspace, /\.includes\(task\.status\)\) return "execution"/);
});
