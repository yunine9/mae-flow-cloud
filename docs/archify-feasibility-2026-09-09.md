# Archify 对全局 Story 4+1 的适配评估

日期：2026-09-09。结论：可作为架构概览的可选展示增强，不适合作为完整 4+1 的唯一渲染器。已完成本地固定版本接入，真实模型端到端实战进行中（见文末）。

## 初次评估的证据范围（实施前）

通过网页读取官方 README、路线图、架构/时序 Schema、CLI 入口、package.json 与许可；核对本仓 Story 的 PlantUML 要求及现有渲染实现。官方 main 自报开发版 `2.17.0-dev.1`，本次未固定提交，后续试点须锁定版本。

本地克隆因代理不可连接失败，取消代理后 DNS 解析也失败；浏览器示例打开超时。因此本次是官方源码与文档层面的可行性评估，没有完成生成、截图、中文排版、缩放、导出或 iframe 集成实测。官方宣称的功能与本项目实测结果不能混用。

## 功能适配

| 需求 | 判断及依据 |
| --- | --- |
| 系统/模块概览 | 适合试点。Architecture 表达组件、连接和边界；HTML 阅读器提供聚焦、搜索和导航。 |
| UML 类图 | 不适合原生承载。五种 Schema 中没有 class 模式；Architecture 没有类属性、方法、可见性、多重性或继承/组合关系的专用结构。卡片文字可说明概念，但不能替代这些语义。 |
| 时序图 | 支持参与者、消息、返回和激活；Schema 的 segments 是起止范围加标签，未见标准嵌套 alt/loop/par 片段结构。简单链路可用，复杂 UML 时序表达不能假定等价。 |
| 部署视图 | 可表达服务、存储、区域和安全边界的概览；不等于完整 UML 部署图或实际环境验证。 |
| 开发/场景视图 | 可做组件关系或流程概览；未见专门 UML 包图、用例图模型。需要按具体图意评估，不能用五种图类型替代 4+1 五种关注点。 |
| 中文、主题、导出 | 官方文档提供 zh-CN 界面、主题与 HTML/SVG/PNG 等导出；中文内容由作者提供。本次未实测长中文类名及方法签名。 |
| 稳定 ID 与意见定位 | 节点、关系 ID 及深链接是可复用基础，但不是平台批注系统；仍需接入 Story 版本、意见权限、锚点与宿主通信。 |
| PlantUML 同源 | 文档/CLI 的主路径是 typed JSON IR，未发现可直接消费既有 PlantUML 的支持。不能当作 PlantUML 的主题或替换皮肤。 |

Archify 的五类是 Architecture、Workflow、Sequence、Data Flow、Lifecycle。[Schema 文档](https://github.com/tt-a1i/archify/blob/main/archify/schemas/README.md)

类图缺口判断依据 [Architecture Schema](https://github.com/tt-a1i/archify/blob/main/archify/schemas/architecture.schema.json)；时序限制判断依据 [Sequence Schema](https://github.com/tt-a1i/archify/blob/main/archify/schemas/sequence.schema.json)。上述“适合/不适合”是结合本项目需求作出的工程判断。

## 接入成本

官方主要提供 Node.js 渲染/校验流程，由 JSON 生成独立 HTML/SVG；它不是拿来即可传入 PlantUML 的 React 图组件。MIT 许可允许相应使用和修改，分发时须保留规定的许可信息。[README](https://github.com/tt-a1i/archify/blob/main/README.md)、[LICENSE](https://github.com/tt-a1i/archify/blob/main/LICENSE)

布局有显式坐标、网格与路由控制，部分布局决策由生成 Agent 作出。项目明确不以通用自动布局和自动 Mermaid 解析为目标。这会增加复杂图生成、修订和布局修复的工作量。[路线图](https://github.com/tt-a1i/archify/blob/main/ROADMAP.md)

若接入独立 HTML，需单独解决隔离展示、资源交付、全屏、尺寸、下载及点击节点回到 Story 的协议；直接采用 iframe 不能默认获得宿主的批注能力。只展示导出的 SVG 则会失去其脚本交互。运行时离线能力、可选更新检查关闭及实际资源请求应在试点中核实。

本仓 `src/plantumlRender.ts` 已用 PlantUML JAR 生成 SVG，`web/src/PlantUml.tsx` 以图片显示；Story 生成规则要求 PlantUML。现有路径适合继续作为正式设计图基础。官方 PlantUML 已提供类、字段/方法及多种关系表达。[类图文档](https://plantuml.com/class-diagram)

## 建议

1. 第一版保留 Story 中 PlantUML 为正式图源，在现有查看器上补全屏、缩放、清晰导出及统一样式。
2. 如需要更强的汇报效果，仅选系统/模块概览试点 Archify；类图及复杂时序图继续使用适合的渲染器。
3. Story 的设计事实保持一份。可采用明确范围的确定性投影生成概览，或让特定概览本身使用 Archify 图源并作为 Story 附件管理；不要让 Agent 分别维护语义相同的 PlantUML 与 Archify 两份图。
4. 试点须固定版本，以真实中文模块图完成离线渲染、布局、内嵌/全屏、SVG/PNG 导出和版本/锚点集成测试，再决定是否正式引入。

不建议为了统一视觉而扩展 Archify 去实现 UML 类图和完整时序语法；这会变成维护新渲染器，超出当前展示增强的合理范围。

## 评估后的用户决定

用户确认采用独立展示入口，仅展示 Archify 支持且能够准确表达的图；Story 内保留完整的 4+1，包括类图等 Archify 不支持的内容。独立展示与 Story 章节及版本关联，相关设计更新后同步派生展示，不维护第二套设计。

该决定确定产品分工；后续实施和验证结果以以下记录为准。


## 固定版本实施与已完成验证

2026-09-09 后续实施已绕过失效代理取得官方源码，固定上游提交 `10722002bb8777ecb639d93c49586fae4adf3ae4`（2.17.0-dev.1）。
仓内 `vendor/archify/UPSTREAM.json` 记录来源，保留 MIT 及第三方许可；assets、renderers、schemas 与精选示例采用上游原文件。
运行直接调用对应类型的上游 Node 渲染器，无 npm 安装和 CLI 更新检查。Story 中 `archify` 围栏使用原生 JSON，完整设计和类图仍留在同一份 Story。

- 独立“架构视图”页签按 Story 原文 SHA-256 读取图列表、生成交互 HTML；版本变化使旧请求失效。
- 没有图源、未闭合 JSON、类型不支持、校验或渲染失败均给出提示，不改变任务状态。
- 图源不允许外部品牌抓取和仓库取证，生成内容在无同源权限的 iframe 中展示，CSP 禁止联网。
- 五种类型均已调用真实渲染器完成中文生成；专项模块/API测试5项通过，既有gate 125项通过。
- 实际 Chrome iframe 已检查中文展示、125%缩放、中文节点搜索、主题切换；SVG/PNG实际下载成功。
- 以上浏览器专项使用手写示例，不能替代模型端到端证据。GLM 5.3 Flash 已通过真实问答和工具调用，完整业务任务仍在进行。

实战现场与截图索引：`.pilot/story-architecture-glm-20260909/evidence/INDEX.md`。保留失败、修复及成功阶段，不覆盖截图。

## 实战发现与后续调整

真实 GLM 的第一版架构图因端点方向和标签遮挡被上游布局校验拒绝；同一 Story 的时序图正常。这证实 JSON 合法和官方示例通过都不能替代实际业务图验证。平台现在向 Agent 工作区提供固定版本离线渲染器及完整资源，要求提交前逐图试渲染、按诊断修订 Story；无法验证时如实说明，不增加 hook 门禁。

按用户最新确认，架构页只展示 Story 架构图，移除旧“模块拆分与依赖”图。完整 4+1 与类图仍在 Story；阅读和批注从“阅读完整 Story”进入，任务分工由右侧确认卡和后续子任务列表承载。Archify 节点暂不直接承载批注。渲染失败时提供返回 Story 反馈入口，原始诊断折叠保留。

Story 正文只表达业务设计，图标题用“模块架构”“订单同步时序”等名称；“Archify 投影”“供平台独立展示”“与正文同步更新”是生成约定，不应混入评审正文。

“演示”已在宿主接入层连接浏览器原生全屏；Esc、退出按钮和浏览器退出动作同步恢复演示状态。全屏不可用或拒绝时铺满页面。保持 iframe 无同源权限，仅授权 fullscreen；跨窗口消息仅接受当前图的窗口。真实 Story 架构图、时序图及拒绝回退已实测，截图036—038保留。

Story 阅读器将 Archify JSON 收入可展开图源块，原文与批注行号保留。查看架构图按钮按代码块行号跳到相邻架构页并选中对应图。分工确认卡前置具体模块，按依赖阶段排列，负责人/单号和前置模块同卡可见；完整职责与验收可展开，不再仅显示数量让用户另找。
