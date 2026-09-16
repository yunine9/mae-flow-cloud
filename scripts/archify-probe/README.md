# Archify 本地生成实验

实验入口，不修改生产提示词、任务状态或 vendor 渲染器。使用配置中真实模型 API，产生费用；不要提交模型凭据。

```bash
npm install --prefix .local/archify-probe --no-audit --no-fund elkjs@0.12.0
node --import tsx scripts/archify-probe/run.ts
node --import tsx scripts/archify-probe/view.ts
python3 -m http.server 8846 --bind 127.0.0.1 --directory .local/archify-probe
```

访问 http://127.0.0.1:8846 。默认读取 `.local/models.json` 的 glm provider 第一个模型及 `docs/overall-story.md`。可用 ARCHIFY_MODELS、ARCHIFY_PROVIDER、ARCHIFY_MODEL、ARCHIFY_INPUT、ARCHIFY_PROBE_OUT 覆盖。输出目录需要上述本地 elkjs 安装。

一次调用原生 Archify 提示词，三次独立调用结构化内容提示词，共四个并发模型请求。该实验不是生产 Agent 完整工具会话的基准，也不是严格串行延迟 A/B。保留全部模型原文、JSON、图源、渲染错误及耗时，不向模型自动重试。原生提示词提供实际 schema 和示例；结构化内容采用 ELK 布局，再交给未修改的 Archify 渲染器。尚未保证任意拓扑的稳定性。

修改编译器后可以运行 `node --import tsx scripts/archify-probe/run.ts rerender`，仅重放已保存输出，不调用模型。原始 results.json 保留首轮结果；rerender-results.json 记录后续布局结果，不能把后续成功冒充首次成功。

预览的模块详情由模型输出提供，包括可核对的原文引用；渲染成功不代表内容通过人工设计审查。预览中的验收内容是设计要求，不是已执行的测试结果。

补充命令：`run.ts fast` 另发三次模型请求，要求字段精炼以减少重复内容；`stress.ts` 不调用模型，验证长链、菱形、循环和扇出汇合四种构造图。渲染重放按顺序执行，避免实验自身触发宿主同时只允许两份渲染的忙碌返回。

预览保留总览，并按所选模块展示其直接协作方；这是显式标注的局部视图，全部模块及关系仍可切回查看。长职责、接口、验收、依据按需展开，不再铺成长文卡墙。样式适配只作用于实验 HTML，不改 vendor。该实验只验证 architecture 类型，不覆盖其他四种图型。

## 放入真实本地工作台

```bash
node --import tsx scripts/archify-probe/seed-service.ts
MAE_FLOW_UI_FIXTURE_MODE=1 node --import tsx src/serve.ts --data .local/archify-service-preview --port 8850
```

登录 `http://127.0.0.1:8850/work/task-1`（dev / mae-flow-demo），打开“架构图”。这是实际服务与正式前端，任务为明确标注的本地样本；不启动开发 Agent。使用生成过的 `fast-1.json` 和原始输入创建任务材料，宿主真实读取、核验并渲染。总览与模块局部图使用现有图标签切换，每个局部图只保留当前模块的两条简短说明。实验页的右侧联动尚未接入正式组件。目录已存在时拒绝覆盖；不要对其他服务数据目录运行。不要将这个本地演示账号部署到生产。

模块 `type` 由语义生成阶段按实际职责给出，转换器保留它，使用 Archify 原生类型色和同语义图例；缺失类型标注“类型待明确”，不再全当后端。现有 fast-1 原始 GLM 输出没有类型，因此使用 moduleRoles.ts 中依据文档核对的样本分类，保留原始输出不改写。文档/模板为资料依赖，文件版本存储归入持久存储；不把意见回传臆断成消息队列。

更新已经启动的隔离样本图源：`node --import tsx scripts/archify-probe/seed-service.ts --refresh-architecture`。只覆盖该固定本地 fixture 的架构产物，保留账号和任务状态。
