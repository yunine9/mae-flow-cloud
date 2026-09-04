# 前端工作台重构交接（2026-09-05，Claude → Codex）

> 读者：接手下一轮前端重构的 Agent 与 liaoxiang。分支 `codex/frontend-workbench-rebuild`，
> 本文对应 HEAD `e138c2c`。基线文档 `docs/frontend-experience-baseline.md`（v4）是设计
> 规则的唯一权威，本文只讲"做到哪、为什么、用户要什么、坑在哪"。

## 1. 用户的预期（按原话，按时间顺序）

1. 大胆、完整的视觉重构，作为**长期前端基线**；"充分发挥你的审美，不要被历史的审美禁锢"。
2. 服务"挑剔的工程用户"：几秒内看清**发生了什么 / 要不要我介入 / 下一步 / 证据在哪**。
3. Agent 输出分层：**结论 → 证据 → 原始日志**。
4. 一个功能都不能丢；所有状态、按钮、权限都能用夹具库模拟（`npm run ui:preview`）。
5. 第二轮反馈："工作台还是很丑；很多批注的框、展开部分都被淹没了；很多功能不直观、过于隐藏。"
6. 第三轮反馈："进度条再往上提；左侧 tab 点进去里面还能切换，说明功能重复；打包下载这类按钮没归拢。"
   接着："左侧这些 tab 平铺在这，都是些啥，要再次重构。"
   再接着："**参考类似我们定位的业界优秀实践的前端界面，彻底重构**；现在力度远远不够，就是微调。"
7. 第四轮反馈（两栏版）："**越搞越丑，左边都是啥啊**。"
8. 决定让 Codex 接手。

**结论：用户至今没有满意过任何一版。** 每一轮我都在上一版骨架上调整，他判成"微调"。
接手者请把当前状态当作"可运行的起点 + 一堆已验证的约束"，不要当作"接近完成"。
他最初的批评之一就是"CSS 是在没有视觉原型的情况下写出来的"——**先出一张能看的图
（哪怕是 HTML 静态原型），让他点头，再落 CSS**，可能比再改一轮 CSS 更有效。

## 2. 我做了什么（四个提交）

| 提交 | 内容 | 关键文件 |
|---|---|---|
| `74a435e` | 视觉语言定稿 + 全站换肤：`tokens.css` 单一令牌源（暖中性画布、炭黑深色、墨色主动作、琥珀只给"需要人"、发丝线代替卡片），删除旧主题补丁块 | `web/src/tokens.css`、`style.css`、`task-workspace.css` |
| `8488db5` | 一级区块统一为"面板"（surface 底 + 发丝边 + 12px 圆角 + surface-2 题头）；深色表面亮度台阶拉开；批注卡与 CodeHub 意见卡在工作台作用域内拍平；当时还加了左导航三区（后来撤掉） | `task-workspace.css`、`annotate.css` 末段、`tokens.css` |
| `efad81c` | 工作台按 Devin / Codex / Jules / Claude Code 网页版会话页改成两栏：左"对话与决定"，右"工作区"页签阅读器；删除左导航、三视图页签、证据预览、"继续查看"；进度并入 56px 任务头；活动面板题头即折叠开关；按钮四档归拢 | `TaskWorkspace.tsx`（渲染骨架）、`task-workspace.css` |
| `e138c2c` | 左栏决定卡按"标题 → Agent 的话 → 问题与选项 → 提醒 → 会带上的批注 → 通栏提交 → 依据灰带"重排（CSS order，组件 DOM 不动）；去掉重复标题与角标 | `task-workspace.css` |

未动的：业务逻辑、API、夹具库、`TaskCard.tsx` 里的 `WaitingCard` DOM（只改了一处
英文 kicker 为中文）。`scripts/ui-workbench-scenarios.ts` 16 个场景与测试原样。

## 3. 现在的工作台长什么样（v4）

```
┌ ‹ UI0005 标题 · ● 等你决定 · 等你 2h   ●启动─○澄清需求─…─○已合入 1/7   [暂停][取消] ┐ 56px
├──────────────────────┬───────────────────────────────────────────────────────────┤
│ 左栏 .ws-side(canvas)│ 右栏 .ws-evidence(surface)                                 │
│ 状态行               │ 页签 [需求原文][过程文档 2][模块与依赖][工作区变更 1] | [活动]  ⌕ ⛶ ✎2 │
│ 决定卡 .ws-decision  │ 阅读器 .ws-doc / 活动面板 .ws-execution-view                │
│  或 失败/验证/合入   │ 批注检查器 .workspace-review-drawer 停靠右缘(≥1100)          │
│ ─────────────────── │                                                            │
│ ✎ 补充给 Agent(底部) │                                                            │
└──────────────────────┴───────────────────────────────────────────────────────────┘
```

- 左栏宽 `--ws-side-w: clamp(360px,30vw,440px)`；<1000px 上下堆叠；全屏阅读隐藏左栏。
- `workspaceView` 状态仍是 `focus | materials | execution`：`focus/materials` 右栏显示材料，
  `execution` 显示活动；`defaultWorkspaceView` 恒返回 `"focus"`（测试钉死）。
- 所有工作台样式锁在 `.task-workspace-v2` 下（`task-workspace.css` ≈1460 行）；
  遗留全局样式在 `style.css`（≈1.17 万行），工作台里靠作用域覆盖。

## 4. 验证流程与环境坑（照做能省半天）

- 预览：`npm run ui:preview`（端口 8838，夹具目录 `.ui-fixtures`，服务是前台进程，
  终端一关就没）。账号 `dev`(责任人)/`reviewer`/`observer`/`admin`，口令 `mae-flow-demo`。
  任务 task-1…task-16 对应 16 个场景（等待决定 task-5、推送前检视 task-8、跨仓 task-7、
  运行中 task-2、失败 task-14、完成 task-15…）。`.claude/launch.json` 里有 `ui-preview`。
- 前端构建：`cd web && npm run build`（= tsc -b + vite），这是 TSX 的类型闸门。
  根目录 `npm run typecheck` 只查宿主 TS。
- 测试：`npm test` **只能单进程跑，且必须从仓库根目录跑**（cwd 在 web/ 下会报
  "Missing script: test"）。全量基线：1442 通过 / 11 显式 skip / 1 项既有失败
  （`orderFacts` "UT生成方式"，与前端无关）。工作台相关契约测试：
  `tests/decisionContextLayout.test.ts`、`reviewWorkspaceLayout.test.ts`、
  `workspaceExecutionPanel.test.ts`、`uiWorkbenchScenarios.test.ts`、`usabilityTweaks.test.ts`、
  `workspaceUiLogic.test.ts`。
- Claude 内置 Browser 面板里 `document.hidden` 恒为 true，前端不轮询；注入
  `visibilityState=visible` 才拉数据；rAF 不投递。Codex 若用别的浏览器不受影响。
- **五档宽度必看**：1440（明/暗）、1280、1000、800、390。用户在自己的浏览器里看，
  未说明分辨率。

## 5. 测试钉死的契约（改结构前先看）

- `TaskWorkspace.tsx`：`className="workspace-review-drawer" role="complementary"`、
  `<details className="ws-focus-collaboration"`（SteerBox 在 CrossRepositorySync 之前，
  文案"需要纠偏时再展开，不打断正常执行"）、`className="ws-primary-scroll ws-execution-view"`、
  `<TaskTimeline taskId={task.id} />`、`<ExecutionPanel task={task} />`（**不许** `defaultOpen`：
  原始事件默认收起）、`<strong>原始事件</strong>`、`["focus", "当前"]/["materials", "产物"]/
  ["execution", "活动"]` 三个字面量、`ws-review-launch` 且 `onClick={() => setReviewPanelOpen(true)}`、
  `materialsFullscreen && <button type="button" className={\`materials-review-toggle`、
  `--ws-head-h`/`--ws-pane-head-h` 由实测写变量、不许出现字符串 `has-review`、
  `showDetailedStep={false} status={task.status}`、`defaultWorkspaceView` 返回 `"focus"`。
- `style.css`（不是 task-workspace.css）钉了若干旧规则：`.workspace-review-drawer { position: fixed … }`、
  `.ws-decision { padding-bottom: 84px; }`、`.workspace-overlay.materials-fullscreen .ws-decision`、
  `materials-fullscreen:has(.workspace-review-drawer) .ws-evidence { padding-right: calc(min(760px …`
  等——它们在 `task-workspace.css` 里被覆盖，但不能删。
- `annotate.css`：`.annot-note {` 段里要有 `border-left: 3px solid var(--accent)` 与
  `color-mix(in srgb, var(--accent) 7%`；`.annot-response {` 段里要有 `border-left: 3px solid var(--success)`；
  `.workspace-review-notes .annot-item:has(.annot-response) { … grid-template-columns:` 要存在；
  `.annot-route-badge { grid-area: route`。工作台内的平面化写在文件末段作用域覆盖里。
- 导航切片测试从 `aria-label="任务工作台视图"` 到 `<section className="workspace-review-drawer"`
  之间必须有 `ws-review-launch`，不能有"邀请检视"。

## 6. 已知欠账 / 下一轮候选

- **用户对左栏仍不满意**（"左边都是啥"）。`WaitingCard`（`TaskCard.tsx`）的 DOM 是按数据
  结构长的，我只用 CSS order 重排；真正的解法可能是重写决定卡组件：一个问题就是一张
  "Agent 提问"消息 + 选项 + 一个按钮，依据折叠。单问题时的 "01" 序号也该去掉。
- 右栏没有"会话流"：Devin/Jules 的核心是一条时间线（Agent 说了什么、问了什么、人答了什么）。
  我们的数据源分散在 timeline、steer-log、annotations、waiting/decisions 里，没有聚合成一条
  可读的叙事——这是产品层的空缺，不是 CSS 能补的。
- GitDiff 全屏仍是遗留的"树 | 详情"分栏，没选文件时右侧空白；`RequirementGraph` 仍是自带的
  嵌套卡。两者只做了配色收敛。
- 检查器停靠时右栏只剩 ~600px，工具条按容器宽度缩成图标；1181–1360px 只隐藏未到阶段的名字。
- Button / Tabs / Drawer / Panel 仍是共享类名与作用域覆盖，不是显式组件；`style.css` 1.17 万行
  遗留没有清理；bundle > 500KB 警告未处理。
- 团队总览、团队资产、许愿墙、帮助页只换了皮，信息架构没动。
- 移动端（390）只保证不溢出、能操作，没有专门设计。

## 7. 我的判断（供参考，不是结论）

四轮都失败在同一件事上：我拿着同一批信息换排版，而用户想要的是"一眼像 Devin/Jules 那种
产品"的整体气质。建议接手者：①先选一个具体参照（比如 Codex 任务页或 Jules 会话页）
把它的**版式尺寸**量出来；②用 16 个夹具里最复杂的 task-8（推送前检视）和最简单的
task-5 各做一张静态原型给用户看；③过了再改代码，并且允许重写 `WaitingCard` 而不是
只在外面套 CSS。
