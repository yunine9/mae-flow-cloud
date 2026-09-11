import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const taskCard = readFileSync(
  join(process.cwd(), "web/src/TaskCard.tsx"), "utf8");
const studio = readFileSync(
  join(process.cwd(), "web/src/workspace-studio.css"), "utf8");
const stream = readFileSync(
  join(process.cwd(), "web/src/ConversationStream.tsx"), "utf8");

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

test("长检视内容在检视画布内自己滚动，不把整页撑高", () => {
  // 2026-09-05(740b6ff)起检视意见不再是固定定位抽屉,而是材料区右侧常驻
  // 的画布:和材料内容并排在 .ws-material-stage 这一行里,自己滚、不撑父级。
  assert.match(readFileSync(join(process.cwd(), "web/src/ResizableReviewPane.tsx"), "utf8"),
    /className="ws-review-canvas" id="ws-review-canvas"[\s\S]*?role="complementary"/);
  assert.match(studio, /\.ws-review-canvas \{[^}]*min-height: 0;[^}]*overflow: auto/);
  assert.match(studio, /\.ws-material-stage \{[^}]*min-height: 0;[^}]*overflow: hidden/);
  assert.doesNotMatch(workspace, /workspace-review-drawer|workspace-review-content/,
    "抽屉时代的类名不再出现在 TSX 里;它们的 CSS 已随之删除");
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
  assert.match(workspace, /reviewCounts\.mine \|\| reviewRecordCount/);
  const canvasHeader = workspace.slice(
    workspace.indexOf('<ResizableReviewPane open={reviewPanelOpen}>'),
    workspace.indexOf("{reviewWorkspaceContent}"),
  );
  assert.ok(canvasHeader.length > 0, "检视画布的标题栏要能定位到");
  assert.doesNotMatch(canvasHeader, /项等我确认|reviewCounts/,
    "画布标题栏不再重复计数");
  assert.match(workspace, /setReviewRevealRequest\(\(request\) => request \+ 1\)/);
  assert.doesNotMatch(workspace, /openedReviewAttention|previousReviewActionCount/,
    "批注出现时只亮入口，不应自动弹出并抢走当前任务");
});

test("批注弹层与 Agent 决定卡互不接管，也绝不自动代选", () => {
  // 2026-09-04 起闸门是 decides(责任人,或受邀参与人答非拍板卡)。
  // 2026-09-05 起决定卡钉在对话流顶部(ConversationStream.pinnedCard),
  // 工作台只负责按 decides 造卡;有 waiting 就一直有卡,和检视画布无关。
  assert.match(workspace, /currentCard=\{waiting \? \(decides \? \(/,
    "Grill、方案确认和 push 确认都必须持续渲染决定卡");
  assert.match(stream, /const pinnedCard = !!waiting && !!currentCard;/);
  assert.doesNotMatch(workspace, /finalDecisionDeferred|reviewTakesFocus/,
    "打开批注不能卸载或改写当前决定卡");
  assert.match(workspace, /aria-label="收起检视意见"/);
  assert.match(workspace, /if \(reviewPanelOpen\) setReviewPanelOpen\(false\)/,
    "Escape 应先关闭批注弹层，再退出整个工作台");
  assert.doesNotMatch(taskCard, /setPicked\(\(current\) =>[\s\S]{0,900}feedbackAnswers/,
    "意见未闭环只能阻止放行，不能替用户默认选择返工或确认推送");
});

test("旧代码锚点消失时在材料侧给出明确反馈", () => {
  assert.match(workspace, /check\?\.state === "gone"/);
  assert.match(workspace, /批注定位/);
  assert.match(workspace, /下面保留批注时原文和意见/);
  assert.match(workspace, /<AnnotationExcerpt item=\{locationExcerpt\}/);
  assert.match(css, /\.annotation-location-notice\s*\{/);
});

test("检视意见是材料区右侧的常驻画布:材料露出可点,定位不必先关窗", () => {
  // 形态史:遮罩弹层 → 挤进 .ws-body 栅格右栏(中等宽度被塞到最下面,
  // 用户截图实锤"看着都像 bug")→ 固定定位侧滑抽屉(2026-09-02)→
  // 2026-09-05 工作台重建(740b6ff)后落定为材料区内的并排画布:和材料
  // 内容同在 .ws-material-stage 一行,打开不盖任务头、不改当前页签,
  // 关掉只是 hidden——批注锚点还在,定位不必先关窗。
  const stage = workspace.slice(
    workspace.indexOf('<div className="ws-material-stage">'),
    workspace.indexOf('<div className="ws-material-content">'));
  assert.match(stage, /<ResizableReviewPane open=\{reviewPanelOpen\}>/,
    "画布是材料舞台的直接子级,靠 hidden 开关而不是条件卸载");
  assert.doesNotMatch(workspace, /has-review|workspace-review-drawer/,
    "不再进 .ws-body 栅格,也没有抽屉");
  assert.doesNotMatch(workspace,
    /reviewPanelOpen && <div className="workspace-review-backdrop"/,
    "检视意见不再是遮罩弹层");
  assert.match(studio, /\.ws-review-canvas\[hidden\] \{ display: none; \}/);
  assert.match(studio, /\.ws-review-canvas \{ order: 2; flex: 0 0 clamp\(340px, 40%, 420px\)/,
    "画布靠右、定宽区间,左侧材料照常可点可圈选");
  assert.doesNotMatch(css + studio, /\.workspace-review-drawer/,
    "抽屉 CSS 已删,不许悄悄回来");
  assert.doesNotMatch(workspace, /setWorkspaceView\("insights"\)/,
    "打开画布不能改掉交付材料、开发协作或执行现场的当前页签");
});

test("意见卡是三层对话:头一行位置+状态药丸,意见块与回复块各带说话人行", () => {
  // 2026-09-06 用户:"他的回复包括我的原文,我需要明确知道哪个是他的回复、哪个
  // 是我的原文,然后现在状态是什么——现在很混乱"。头一行只回答"指着哪儿 +
  // 现在什么状态";谁提的 / 去向 / 时间进"意见"块的说话人行;Agent 的回复自带
  // 说话人行(Agent 的回复 · 时间 · 结论);圈的原文是意见块的最后一行。
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  const head = panel.slice(panel.indexOf('<div className="annot-item-head">'),
    panel.indexOf("{editing ? ("));
  assert.match(head, /className="annot-where"/);
  assert.match(head, /className=\{`annot-progress \$\{progress\.tone\}`\}/);
  assert.doesNotMatch(head, /annot-route-badge|annot-thread|annot-anchor/,
    "头部只剩位置与状态;去向进说话人行,看处理记录进页脚,圈的原文进意见块");
  const note = panel.slice(panel.indexOf('<div className="annot-note">'),
    panel.indexOf("{item.response && ("));
  assert.match(note, /className="annot-speaker person"[\s\S]*?<b>\{isAuthor \? "你" : personName\(item\.author\)\}<\/b>/,
    "意见块的说话人行:作者本人看到\"你\",别人看到名字");
  assert.match(note, /提的意见 · \{relativeTime\(item\.created_at\)\}/);
  assert.doesNotMatch(note, /annot-route-badge/, "批注不再展示处理去向选择");
  assert.ok(note.indexOf("<p>{item.note") < note.indexOf("annot-anchor"), "圈的原文跟在意见正文后面");
  assert.match(note,
    /className=\{`annot-anchor\$\{item\.quote \? " has-quote" : ""\}`\}\s*\n?\s*title=\{item\.quote \?\? item\.anchor\}/,
    "截断后整段(或整块)必须还在 title 里,不能丢");
  assert.match(note, /<span>圈的原文<\/span>/);
  const response = panel.slice(panel.indexOf("{item.response && ("),
    panel.indexOf("{item.owner_reply && ("));
  assert.match(response, /className="annot-speaker agent"[\s\S]*?<b>Agent<\/b>/);
  assert.match(response, /的回复 · \{relativeTime\(item\.response\.responded_at\)\}/);
  assert.doesNotMatch(response, /Agent：已处理/, "结论不再拼在名字里,单独一枚小标");
  assert.match(response, /`依据 \$\{item\.response\.evidence\.join\("；"\)\}`/);
  assert.match(response, /\]\.join\(" · "\)/, "依据与提交并成一行");
  const foot = panel.slice(panel.indexOf('<div className="annot-item-foot">'),
    panel.indexOf('className="annot-owner-actions"'));
  assert.match(foot, /className="annot-thread"[\s\S]*?看处理记录/, "看处理记录在页脚");
  assert.doesNotMatch(foot, /批注作者/, "作者与时间已在说话人行,页脚不重复");

  const annotate = readFileSync(
    join(process.cwd(), "web/src/annotate.css"), "utf8");
  // 宽抽屉的两列网格:锚点已并进意见块,不再单独占一行、不再点名区域。
  assert.match(annotate,
    /grid-template-areas:\s*"head head"\s*"note response"\s*"foot foot"/s);
  assert.doesNotMatch(annotate, /grid-area:\s*(anchor|route)/);
  // 状态是实底药丸;人的块与 Agent 的块同一块形、左条分色;说话人头像 18px 圆
  assert.match(annotate, /annot-progress[^{]*\{[^}]*border-radius: 999px/);
  assert.match(annotate, /\.annot-speaker > i \{[^}]*border-radius: 50%/);
  assert.match(annotate, /\.annot-item \.annot-response \{ border-left-color: var\(--success\)/);
  assert.match(annotate, /\.annot-item \.annot-response\.outcome-needs_clarification \{ border-left-color: var\(--danger\)/);
  const studio = readFileSync(join(process.cwd(), "web/src/workspace-studio.css"), "utf8");
  assert.doesNotMatch(studio, /\.annot-item-head \{[^}]*flex-direction: column/);
});


test("拆分方案确认卡:标题点名、事实条代替散文、卡上只填执行人与单号", () => {
  // 用户实测截图"右侧很丑":两个泛称标题摞在一起(当前需要处理/需要你
  // 的决策)、300px 散文背景复述左边已经画出来的图、讨论参与人整块搬进
  // 卡里带着第二个主按钮、单元行四列挤在 635px 里职责被截成省略号,
  // 提交按钮在 1400px 之下还被"提问题"浮钮压着。
  const card = readFileSync(join(process.cwd(), "web/src/TaskCard.tsx"), "utf8");
  assert.match(card, /export function isChainReviewWaiting\(task: TaskSummary\)/);
  assert.match(card, /if \(isChainReviewWaiting\(task\)\) return "确认拆分方案";/);
  assert.match(card, /className="chain-decision-facts"/);
  assert.match(card, /chainStages\(task\.requirement_graph\)\.length/,
    "阶段数和左侧图共用同一个拓扑函数");
  assert.match(card, /确认并创建 \$\{task\.requirement_graph!\.repositories\.length\} 个模块任务/,
    "按钮要说清楚会按模块生成几个任务");
  assert.match(card, /模块拆分与依赖图尚未就绪/,
    "真实机读图未就绪时不能把候选仓拿来确认");
  assert.match(card, /确认分析结论并结束/,
    "全部候选仓无需修改时不能制造空任务");
  assert.match(card, /<details className="waiting-context-details">/);

  assert.match(workspace, /const chainReview = !!waiting && isChainReviewWaiting\(task\);/,
    "判据只有一份");
  const attachmentStart = workspace.indexOf("attachment={requirementAnalysisConfirmation ? undefined :");
  const attachmentEnd = workspace.indexOf('className="ws-attached-feedback"', attachmentStart);
  assert.ok(attachmentStart > 0 && attachmentEnd > attachmentStart);
  assert.doesNotMatch(workspace.slice(attachmentStart, attachmentEnd), /RequirementTeamPicker/,
    "讨论参与人不进确认卡");
  assert.match(workspace, /邀请他人检视/,
    "移除旧依赖图后，邀请检视仍可由任务头进入");
  assert.match(workspace, /<RepositoryAssigneePicker/,
    "模块负责人和单号仍在右侧确认卡填写");

  const picker = readFileSync(
    join(process.cwd(), "web/src/RepositoryAssigneePicker.tsx"), "utf8");
  assert.doesNotMatch(picker, /duplicateTicketOf|单号与「.*」重复/,
    "同仓单元已由平台串行，同一 AR 不应在分工卡上报重复");

  assert.match(css, /\.ws-decision \{ padding-bottom: 84px; \}/,
    "右栏底部让开提问题浮钮");
  assert.match(css, /\.options\.compact \.custom-entry \{ grid-column: 1 \/ -1;/,
    "逃生口选项降成通栏一行");
  assert.match(css, /\.ws-decision \.repository-assignee-list > label \{[^}]*grid-template-areas: "name name" "who ticket" "state state"/s);
});

test("检视画布标题栏按自己的高度占位,副标题不被裁", () => {
  // 抽屉时代它是竖向 flex,标题栏被内容区压缩到 min-height:420px 宽下要
  // 85px 只拿到 64px,副标题半行裁在边框外。画布是普通块级滚动容器
  // (overflow:auto,不是 flex 列),标题栏天然按内容占位;这里锁住"别再把
  // 画布改回 flex 列"。
  const canvasRule = /\.workspace-studio \.ws-review-canvas \{[^}]*\}/.exec(studio)?.[0] ?? "";
  assert.ok(canvasRule, "画布规则要在 workspace-studio.css 里");
  assert.doesNotMatch(canvasRule, /display:\s*flex|flex-direction/);
  assert.match(studio, /\.ws-review-canvas \.ws-view-intro \{ gap: 12px; margin-bottom: 12px; \}/);
});

test("工作台打开期间收起提问题浮钮,检视画布自己滚动", () => {
  // 浮钮挂在 .workspace-overlay 之外、z-index 650,会压在工作台右下角——
  // 抽屉时代只在抽屉开着时收起,原先还靠内容底部留 84px 死白躲它(空白
  // 本身就在浮钮底下,最后一条的操作照样点不到)。工作台重建后整个工作台
  // 打开期间都收起,画布(材料区右侧)的最后一条不再被它盖住。
  assert.match(studio, /body:has\(\.workspace-studio\) \.wish-quick-trigger \{ display: none; \}/);
  assert.match(studio, /\.ws-review-canvas \{[^}]*overflow: auto/, "画布自己滚,不靠底部留白躲浮钮");
  assert.doesNotMatch(css + studio, /padding: 12px 12px 84px/, "躲避浮钮的死白不许回来");
});

test("检视意见顶部有处理归属筛选条,CodeHub 意见可转成工作台批注", () => {
  assert.match(workspace, /className="review-filter" role="tablist"/);
  assert.match(workspace, /\["mine", "等我确认"\]/);
  assert.match(workspace, /\["agent", "Agent 处理中"\]/);
  assert.match(workspace, /\["closed", "已完成"\]/);
  assert.match(workspace, /filter=\{inline \? "all" : reviewFilter\}/, "批注面板吃同一个筛选档");
  assert.match(workspace, /onConvert=\{canContributeReview && canCreateAnnotation/,
    "转批注沿用批注创建权限");
  assert.match(workspace, /【转自 \$\{origin\}】/);
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  // 分档口径只有一处:服务端 feedbackPolicy 下发 bucket,面板照分。
  // 页面一旦自己按 status/sent_via 推,这条就该红(2026-09-04 重构:
  // 前后端各推一遍是本周 42 条检视类 fix 的共同根因)。
  assert.match(panel, /closureOf\(item\)\.bucket === filter/);
  assert.doesNotMatch(panel, /function annotationCategory/,
    "分档不许回到页面里");
  assert.match(panel, /const visibleItems = filter === "all" \? orderedItems/);
  assert.match(css, /\.review-filter\s*\{/);
  assert.match(css, /\.feedback-convert\s*\{/);
});

test("材料上的已有批注可以反向打开并定位到检视卡", () => {
  const annotatable = readFileSync(
    join(process.cwd(), "web/src/Annotatable.tsx"), "utf8");
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(annotatable, /const ids = hoveredAnnotations\.map\(\(item\) => item\.id\)/,
    "材料行把对应批注 id 交回工作台");
  assert.match(workspace, /setReviewFilter\("all"\)[\s\S]*setReviewPanelOpen\(true\)/,
    "反向定位先取消筛选并打开检视抽屉");
  assert.match(panel, /data-annotation-id=\{item\.id\}/);
  assert.match(panel, /matches\[0\]\.scrollIntoView/,
    "面板滚到第一张对应卡，并同时高亮同一行的其他卡");
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

test("持续检视意见:进度条下不再有摘要条,入口只留角标,正文按来源完整展示", () => {
  // 原来所有意见塞在进度条下横向滚动的小卡片里(9–11px、单行省略),MR
  // 检视人一段话被压成一行,用户实锤"排版太丑"。第二版换成一条摘要
  // (一排"MR 检视 3 2 进行中"胶囊 + 重复的入口按钮),用户再实锤"数字
  // 好丑、和检视意见卡重叠"——整条撤掉,几条进行中并进入口卡副标题。
  assert.doesNotMatch(workspace, /FeedbackSummary|feedback-summary/);
  assert.doesNotMatch(css, /\.feedback-summary/);
  assert.match(workspace, /className=\{`ws-review-launch/);
  assert.match(workspace, /<em>\{reviewCounts\.mine \|\| reviewRecordCount\}<\/em>/);
  assert.doesNotMatch(workspace, /feedbackDigest/,
    "入口不应再堆一行解释性文案");
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

test("检视意见弹层里的批注面板默认展开", () => {
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

test("任务状态更新只刷新当前摘要，不自动切走用户正在看的页面", () => {
  const policy = workspace.slice(
    workspace.indexOf("function defaultWorkspaceView"),
    workspace.indexOf("function sizeText"),
  );
  assert.match(policy, /return "focus"/);
  assert.doesNotMatch(policy, /return "execution"|return "materials"/);
});

test("仓间依赖图里的负责面路径是块级元素,超宽省略而不是横穿卡片", () => {
  // 行内元素不吃 overflow/text-overflow:nowrap 的路径从卡片里直接穿出去,
  // 压过阶段箭头压到下一张卡(实测溢出 274px/890px,用户截图实锤)。
  assert.match(css, /\.repo-scope-paths \{\s*display: block; min-width: 0; overflow: hidden;/);
});

test("需求确认阶段每轮 Agent 修改都能看对比,逐条回执落到意见上", () => {
  // 文件编辑 Agent 只改隔离副本并留下独立回执；宿主校验、留底之后
  // 才覆盖正本。模型回复不承担整篇正文传输。
  const service = readFileSync(join(process.cwd(), "src/taskService.ts"), "utf8");
  assert.match(service, /requirementReviewMission\(\{/);
  assert.match(service, /parseDocumentReviewReceipts\(rawReceipts, annotations\)/,
    "文档编辑 Agent 必须逐条回执");
  assert.doesNotMatch(service, /===END_REQUIREMENT===/,
    "不许恢复让模型在回复里搬运完整需求正文的脆弱协议");
  assert.match(service, /storeRequirementRevision\(task\.summary\.workspace, revisionId, before, diff\.text\)/,
    "改前全文和 diff 先落盘再覆盖正文");
  assert.match(service, /store\.respond\(receipt\.annotation_id, \{/);
  const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
  assert.match(server, /parts\[2\] === "requirement-revisions"/);
  assert.match(workspace, /className="requirement-revision-bar"/);
  assert.match(workspace, /<RequirementDiff text=\{revisionDiff\.text\} \/>/,
    "需求对比直接摊开,不套代码检视的并排画布");
  assert.match(css, /\.requirement-diff-row\.del \.requirement-diff-text \{ text-decoration: line-through/);
});

test("列表收起卡保留只有节点的阶段轨道——去词签不去进度条", () => {
  // 7f8ebb1 把收起卡的轨道整条隐藏,用户实测"当前进度"下面空了一截,
  // 以为进度条丢了。契约:收起时只藏词签与 Token 遥测,轨道本身必须留着。
  const css = readFileSync(new URL("../web/src/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(css,
    /\.task-card:not\(\.expanded\) \.task-summary \.task-phase-track,?\s*[^{]*\{ display: none; \}/);
  assert.match(css,
    /\.task-card:not\(\.expanded\) \.task-summary \.task-phase > span \{ display: none; \}/);
  assert.match(css,
    /\.task-card:not\(\.expanded\) \.task-summary \.token-usage \{ display: none; \}/);
});

test("开发协作:默认标签跟可用性走,占位文案与原因框一致,延后插话有回执", () => {
  // 用户 2026-09-02 实测三处:任务不在运行就默认落到不可用的开发助手;
  // 等人决定时占位写"主任务暂停时…"与原因框打架;等待/排队期 @ 引用发出
  // 后「捎过去的话」永远不更新。
  // 2026-09-05 起两个页签并成右栏输入框的两档(Composer),送达回执进会话流。
  const box = readFileSync(new URL("../web/src/Composer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(box,
    /useState<CollaborationMode>\(\s*steerOnly \|\| task\.status === "running" \? "steer" : "assistant"/,
    "默认档不许按状态硬猜");
  assert.match(box,
    /task\.status !== "running" && assistant\.availability\.available\s*\? "assistant" : "steer"/);
  assert.match(box, /modePicked\.current = true/, "人点过档位后不再替他换");
  assert.doesNotMatch(box, /: "主任务暂停时，请切到“开发助手”直接处理代码现场"\}/);
  assert.match(box, /steerDisabledReason\?\.title \?\? "主任务当前未运行"/);
  const stream = readFileSync(new URL("../web/src/ConversationStream.tsx", import.meta.url), "utf8");
  assert.match(stream, /item\.deferred === "decision" \? "随下一次决定送达"/);
  const service = readFileSync(new URL("../src/taskService.ts", import.meta.url), "utf8");
  assert.match(service, /this\.recordDeferredInterrupt\(task, delivered, "decision", receipt\)/);
  assert.match(service, /this\.recordDeferredInterrupt\(task, delivered, "mission", receipt\)/);
  // 借活会话的 emit 记账,不另开实例撞编号。
  assert.match(service, /task\.driver\.noteUserMessage\(text, \{ deferred, \.\.\.receipt \}\)/);
});

test("需求修订失败原因上页面;开发助手接管前列明边界", () => {
  const workspace = readFileSync(new URL("../web/src/TaskWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /task\.requirement_revision\?\.state === "failed" && \(/);
  assert.match(workspace, /className="requirement-revision-error" role="alert"/);
  const box = readFileSync(new URL("../web/src/Composer.tsx", import.meta.url), "utf8");
  assert.match(box, /className="assistant-bounds"/);
  assert.match(box, /Git 只读/);
  assert.match(box, /交回后由 Agent 接着做/);
});

test("架构页只展示独立 Archify 图，意见回到 Story；Story PlantUML 可原地全屏", () => {
  const css = readFileSync(new URL("../web/src/style.css", import.meta.url), "utf8");
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.requirement-source,\n\.workspace-overlay\.materials-fullscreen \.ws-doc > \.requirement-graph,[\s\S]{0,400}?width: min\(1600px, 100%\);/);
  const workspace = readFileSync(new URL("../web/src/TaskWorkspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /<StoryArchitecture/);
  assert.match(workspace, /const architectureStory = task\.parent_task_id[\s\S]{0,220}?story\\\.md\$[\s\S]{0,220}?purpose === "overall_story"/,
    "主任务与子任务都必须有稳定的架构 Story 来源");
  assert.match(workspace, /hasRequirementGraph \|\| hasArchitectureStory/,
    "子任务有模块 Story 时也必须显示正式架构图页签");
  assert.match(workspace, /onOpenStory=\{\(\) => \{\s*openMaterial\("doc"\); if \(architectureStoryName\) setActive\(architectureStoryName\)/,
    "架构页返回当前任务自己的 Story");
  assert.doesNotMatch(workspace, /<RequirementGraph\b/,
    "用户要求架构页只保留 Story 的架构展示，不再叠加任务拓扑图");
  assert.match(workspace, /setActive\(OVERALL_STORY_ARTIFACT\)/,
    "阅读与反馈返回唯一全局 Story");
  const architecture = readFileSync(new URL("../web/src/StoryArchitecture.tsx", import.meta.url), "utf8");
  assert.match(architecture, /onClick=\{onOpenStory\}>阅读完整 Story/);
  assert.match(architecture, /onClick=\{onOpenStory\}>打开 Story 提意见/);
  assert.match(architecture, /availableViews\.map/,
    "架构页只为实际存在的图片生成视角页签");
  assert.match(architecture, /className="story-diagram-tabs" role="tablist"/,
    "具体图片必须由图名页签承载");
  const card = readFileSync(new URL("../web/src/TaskCard.tsx", import.meta.url), "utf8");
  assert.match(card, /reworksChainChoice && \(\s*<small className="chain-rework-hint">/);
  // 2026-09-04 用户实锤:全屏看文档时右栏藏了,要开批注得先退全屏。当时
  // 的解法是全屏下往工具条加一个入口 + ⌥/Alt+R。2026-09-05 工作台重建后
  // 入口本来就常驻材料工具条(ws-review-launch),画布和材料内容同在
  // .ws-material-stage 里并排,全屏与否都不需要"让位"补丁和量高变量。
  assert.match(workspace,
    /className=\{`ws-review-launch\$\{reviewPanelOpen \? " on" : ""\}`\}/,
    "检视意见入口常驻材料工具条");
  assert.doesNotMatch(workspace, /materialsFullscreen && <button[^>]*ws-review-launch/,
    "入口不再只在全屏下出现");
  assert.match(workspace, /event\.code !== "KeyR"/, "快捷键按 code 认,Mac 上 ⌥R 的 key 是 ®");
  assert.match(workspace, /isEditableTarget\(event\.target\)\) return;/, "输入框里不抢快捷键");
  assert.match(workspace, /setReviewPanelOpen\(\(open\) => !open\)/);
  const studioCss = readFileSync(new URL("../web/src/workspace-studio.css", import.meta.url), "utf8");
  assert.match(studioCss,
    /\.ws-material-stage \{ display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; \}/,
    "材料舞台是一行 flex:画布开着时材料内容自己收窄,不靠 padding 让位");
  assert.doesNotMatch(css + studioCss,
    /materials-fullscreen:has\(\.workspace-review-drawer\)|--ws-pane-head-h/,
    "抽屉时代的让位补丁与工具条高度变量已随抽屉一起删除");
  assert.doesNotMatch(workspace, /--ws-pane-head-h|--ws-body-top/,
    "只喂抽屉的两个量高副作用一起删了,别留只写不读的变量");
});

test("任务记忆兼容契约:取消批注去向选择，保留历史记忆列表和接口", () => {
  // docs/knowledge-memory-design.md §4.1/§9:圈选是唯一的人工入口;可见但不可管。
  const annotatable = readFileSync(join(process.cwd(), "web/src/Annotatable.tsx"), "utf-8");
  assert.doesNotMatch(annotatable, /label: "记为记忆"|不发给任何人/, "统一记下，不提供记忆去向");
  const panel = readFileSync(join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf-8");
  assert.doesNotMatch(panel, /memory: "记忆"/, "不展示旧去向标签");
  // 状态词已经收敛到服务端唯一判定处(feedbackPolicy),这里按结论断言。
  const policy = readFileSync(
    join(process.cwd(), "src/feedbackPolicy.ts"), "utf-8");
  assert.match(policy, /annotationRoute\(item\) === "memory"\) \{\s*return \{ tone: "done", text: "已记为记忆"/,
    "记忆条目直接是闭环态,没有送出/回执/确认三站");
  assert.match(panel, /check\.state !== "hit" && routeOf\(item\) !== "memory"/,
    "记忆是快照,不参与重锚定提示");
  const footprint = readFileSync(join(process.cwd(), "web/src/KnowledgeFootprint.tsx"), "utf-8");
  assert.match(footprint, /className="knowledge-memories"/);
  assert.match(footprint, /这单记下的/);
  assert.match(footprint, /withdrawTaskMemory\(taskId, record\.id\)/, "只读 + 撤回,没有编辑");
  assert.doesNotMatch(footprint, /editMemory|updateMemory/, "记忆没有编辑面");
  const workspace = readFileSync(join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf-8");
  // 2026-09-03 第二期(1553e0d)把任务页的沉淀入口连同导航条数一起砍掉:
  // 记忆只在"这单用到的知识"里只读可见,导航不再自带计数。
  assert.doesNotMatch(workspace, /memories_recorded/, "导航入口不再带条数");
  const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf-8");
  assert.match(server, /parts\[2\] === "memories"/);
  assert.match(server, /parts\[4\] === "withdraw"/);
  assert.doesNotMatch(server, /parts\[2\] === "memories"[\s\S]{0,1200}method === "(PATCH|PUT|DELETE)"/,
    "服务端没有改写或删除记忆的路由");
  const memory = readFileSync(join(process.cwd(), "src/taskMemory.ts"), "utf-8");
  assert.match(memory, /MEMORY_BODY_LIMIT = 2000/);
  assert.match(memory, /appendFileSync\(this\.indexPath/, "索引只追加");
});

test("任务记忆第二期契约:sidecar 可选、工具挂主会话与开发助手、首改目录钩子、这单用到的只读", () => {
  const service = readFileSync(join(process.cwd(), "src/taskService.ts"), "utf-8");
  // 主会话:记忆工具 + 拆分提议工具一起挂,首改目录提醒同处;开发助手只挂
  // 记忆工具(它不是主任务,不能提议拆分);Build-Fix 不挂(不是跟人协作的会话)。
  assert.match(service, /extraTools: \[\.\.\.\(this\.memoryTools\(task\) \?\? \[\]\), \.\.\.this\.splitTools\(task\), \.\.\.createTaskHostTools\(this\.taskHostRuntime\(task, epoch\)\)\],\s*onFileMutationIntent: \(path\) => this\.onMemoryFileIntent\(task, path\)/,
    "主会话同时挂检索工具、拆分提议与首改目录提醒");
  assert.equal((service.match(/extraTools: this\.memoryTools\(task\)/g) ?? []).length, 1,
    "开发助手只挂记忆工具");
  assert.match(service, /this\.maybePushPhaseMemories\(task, progress\.current_phase\)/,
    "阶段切换推送挂在进度读取处");
  assert.match(service, /via: "memory_push"/, "推送不算人的插话");
  const driver = readFileSync(join(process.cwd(), "src/sessionDriver.ts"), "utf-8");
  assert.match(driver, /onFileMutationIntent\?: \(path: string, tool: string\) => void/);
  const tools = readFileSync(join(process.cwd(), "src/memoryTools.ts"), "utf-8");
  assert.match(tools, /name: "corpus_search"/);
  assert.doesNotMatch(tools, /repo: Type\./, "repo 由宿主固定,Agent 传不了");
  const serve = readFileSync(join(process.cwd(), "src/serve.ts"), "utf-8");
  assert.match(serve, /flag\("--memsearch"\)/);
  const footprint = readFileSync(join(process.cwd(), "web/src/KnowledgeFootprint.tsx"), "utf-8");
  assert.match(footprint, /这单用到的/);
  assert.match(footprint, /listTaskMemoryUsage\(taskId\)/);
  const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf-8");
  assert.match(server, /parts\[3\] === "usage"/);
});
