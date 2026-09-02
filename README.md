# mae-flow-cloud

Mae-Flow 云端服务:Pi(pi-mono coding agent)**进程内**集成 + Mae-Flow 内核宿主适配。

设计文档在内核仓:
- [云端 MVP 设计](../mae-flow/docs/superpowers/specs/2026-08-14-mae-flow-cloud-mvp-design.md)
- [宿主适配层详设](../mae-flow/docs/superpowers/specs/2026-08-14-cloud-host-adapter-design.md)
- [问题流 v2:我的问题会话](docs/issue-flow.md)

## 问题流(问题单处理,与需求内核分离)

问题单处理是与需求开发不同的范式(动态研究,不是固定流水线),由
`src/issueFlow/` 独立承载——不进内核、不依赖 taskService,可用
`--issue-only` 单独起服(见 `docs/issue-flow.md`)。拉日志/换库用
every-skill 的两个 Go 工具(`assets/ops-tools/`):宿主以**环境变量**
注入共用密码(`FETCH_LOGS_PASSWORD`/`BUILD_DEPLOY_PASSWORD`)后执行。
浏览器草稿不保存网管口令，vault 以 AES-GCM 加密落盘；为让 Agent
操作页面、抓日志和换库，口令会以明文进入该问题会话的 AI 上下文；
它不会出现在会话列表、状态摘要或事件流中。只能使用脱敏演示/现场专用口令，
不能填写个人复用或生产口令。fetch-logs 产物以真实文件落会话工作区
供 Agent grep，build-deploy 以「部署完成」哨兵判定成功。真二进制冒烟在
`tests/issueFlowService.test.ts`。

## 三条铁的边界

1. **内核唯一权威**。流程规则、门禁契约、证据判定只在
   [mae-flow](../mae-flow) 内核仓(Python)。本仓不复刻一行判定逻辑:
   TS 写现场,`harness/verify_transcript.py` 用内核契约裁决。
   内核定位:`MAE_FLOW_HOME` 环境变量 > 随 Cloud 发布的 `kernel/` >
   快照缺席时回退 `../mae-flow`。
2. **transcript JSONL 是语言中立契约**。TS 写出的每个字节必须被内核
   `parse_transcript` 与四个质量契约原样认出——这是跨语言接缝,
   也是"证据链换输入源而格式零漂移"的落点。
3. **语言按亲和选**(用户拍板):Pi 是 TypeScript,SDK 支持进程内嵌入,
   服务层用 TS——`tool_call` 钩子即同步拦截,自定义工具的未 resolve
   Promise 即人工节点挂起,子 Agent 是同进程再开一个 AgentSession。
   Python 版曾走「pi --mode rpc 子进程 + HTTP 环回桥」路线并全链验证过
   (内核仓历史 2add07b),进程内形态让那两层整体消失。

## 平台默认方案与有限定制

Mae-Flow 的阶段、退出条件、真实证据、人工决定和 Git/交付权限仍由内核
唯一裁决；平台另外为每个阶段提供版本化 Playbook，解释“为什么这样安排、
默认会做什么、完成时应得到什么、有哪些能力可按需使用”。Cloud 只消费内核
`execution-plan --json` 的结构化结果，不在 TypeScript 再维护一套阶段判断。

执行补充按“团队 → 代码仓 → 本任务”叠加，只能调整关注点、先后顺序和协作
方式。除此之外，管理员与任务发起人还可按阶段启用 Playbook 明确列出的可选
动作、把现有 Skill/知识/工具设为本阶段优先，并填写阶段补充。定制只允许“加”
不能“减”：必做动作与必用能力不能取消，浏览器自报不存在的 ID 会被服务端
拒绝。团队选择成为新任务默认，任务发起人只能继续增加，不能取消团队默认。

团队约定在管理员设置中维护；代码仓可在 `.mae-flow-defaults.json` 使用「执行
补充」；本任务的全局补充和阶段定制都在发起页填写。它们会在任务创建/首次
clone 时固定为 `.mae-flow-work/execution-profile.json`，`current` 只把当前阶段
的有效定制交给 Agent；恢复和从头重跑沿用原快照。配置缺失、目录升级导致旧的
可选项失效或仓库文件损坏时，不阻塞任务，退回平台默认并明确提示。业务模块
知识与工程知识继续作为索引化资源按需读取，不被混成一条执行指令，也不会把
正文整包注入上下文。

任务页的“执行方案与现场”会展示平台默认、叠加来源、输出/证据和不可覆盖的
底线。“反馈这套安排”会把方案 ID、阶段和版本快照带入许愿墙，继续使用
待接纳/已接纳/已闭环/未接纳的现有状态。反馈不会直接改写生产默认；维护者
核验后发布新的 Playbook 版本并通过内核自检，平台才会采用，避免众筹意见绕过
质量底线。

## 结构

```
src/
  auth.ts             本地账号:scrypt 加盐哈希 + HttpOnly 会话 + 角色权限
  semanticEvents.ts   十种语义事件 + 追加式事件日志(eventId 幂等锚)
  transcriptStore.ts  语义事件 → transcript 同形 JSONL(含子 Agent 布局)
  gateService.ts      同步裁决点:路由 + 深层契约端口(=内核 CLI)+ fail-open
  humanGate.ts        WAITING_FOR_HUMAN:同 call_id 幂等、先到决定生效
  sessionDriver.ts    进程内会话驱动(拦截/挂起/子会话/登记归属规则)
  kernelHost.ts       内核宿主:合成 Hook 载荷喂 dispatch.py,深层门禁/证据全走内核
  developerAssistant.ts / developerAssistantHandoff.ts
                      开发助手旁路会话 + 与内核步骤/revision/工作区的交还协议
  taskService.ts      任务编排:工作区/受限并发队列/状态由 outcome 驱动;host 模式=克隆仓库+内核 bootstrap
  server.ts           任务 API:REST + SSE(决定冲突=409 任务状态已变化)
  webPage.ts          零构建演示页:列表/发起/审批卡直接点(说人话)
  projection.ts       PostgreSQL 投影(§11):摘要/事件副本/外部动作台账,纯旁路 fail-open
  containerRuntime.ts 任务容器(隔离设计):bash 进容器执行,工作区同路径挂载
  serve.ts            启动入口(演示=内置剧本假模型;--models 接真网关)
  scriptedModel.ts    剧本假模型(Anthropic Messages SSE)——无 LLM 对拍电源
  probe.ts            阶段 0 演练入口
harness/
  verify_transcript.py  内核裁判:唯一权威的证据判定
tests/
  core.test.ts        不变式单测
  server.test.ts      任务 API 端到端(等待人工/409 冲突/决定生效/SSE 镜像)
```

## 跑起来

```bash
npm install
npm test          # 不变式单测 + 任务 API 端到端(真 pi 会话)
npm run probe     # 整链演练:进程内 pi + 剧本假模型,内核裁判验收九项事实
npm run serve     # http://127.0.0.1:8787 浏览器走完 发任务→看进度→点审批
```

演示模式默认登录为 `admin / mae-flow-demo`。管理员登录后可在“账号管理”
创建开发账号；开发账号默认进入“我的工作”，仍可查看团队全部任务，但只能
审批或重跑分配给自己的任务。管理员默认进入“团队总览”，可操作所有任务。

正式模式首次启动必须用环境变量引导管理员，密码不会以明文落盘：

```bash
MAE_FLOW_ADMIN_USER=admin \
MAE_FLOW_ADMIN_PASSWORD='<至少 10 个字符的初始密码>' \
npm run serve -- --models /etc/mae-flow-cloud/models.json
```

账号保存在数据目录的 `auth.json`（scrypt 加盐哈希、文件权限 `0600`）；
登录会话保存在进程内、有效期 8 小时，服务重启后需重新登录。

probe 现场留档在 `.probe/`,serve 的任务现场在 `.tasks/<task-id>/`
(transcript/events/waiting/子 Agent transcript),每个文件都能直接打开看。
试跑现场一键对拍:`python3 harness/run-report.py .pilot/<label>`
(审批卡/子 Agent 配对/质量台账/阶段轨迹读成 markdown,只读)。

问题定位一键采集:任务一进 failed / 交付停摆,服务自动把全部可定位
事实(任务状态、内核现场、Git/容器事实、事件尾部、人审账、服务日志
切片)汇成一个 markdown 落到 `<任务目录>/diagnostics/`;页面出事区域
有「导出诊断包」链接,命令行 `curl -O <服务>/tasks/<任务号>/diagnostics`
也能现采。不脱敏(包给自己人看),但 `.runtime` 下的明文令牌文件
靠白名单采集从结构上排除——诊断包生来要被转发,令牌进包迟早外流。

真模型试跑器也能注入可重复的流水线故障，不用等线上偶发红灯才验证
修复回程。例如下面会让首轮 CodeCheck 红、修复后第二轮绿，并在首次
交付清单里放一个明确排除的本地日志，专门检查修复 Agent 是否夹带：

```bash
npm run pilot -- --models .local/models.json --provider glm --model glm-5.1 \
  --repo ../mae-flow-fieldtest-java --isolate-image mae-flow-task-builder:dev \
  --lane '已定位问题修复' --push-confirm --seed-excluded build.log \
  --pipeline-statuses failed,success \
  --pipeline-failure-dimension CODECHECK \
  --pipeline-failure-file notify-common/src/main/java/example/TextUtil.java \
  --pipeline-failure-line 22 --pipeline-failure-rule ARCH-UTIL-02 \
  --pipeline-log 'CODECHECK FAILED: example/TextUtil.java:22 ARCH-UTIL-02'
```

模糊现场用 `--pipeline-no-details` 注入“只有总体红灯/URL、没有文件行号”
的真实坏形状；`--poll-timeout-s` 与 `--poll-interval-s` 只缩短试跑取证
预算，不改变生产默认。试跑会继续穿过普通 `verifying`，只有到
`await_merge`、终态，或明确的 `waiting_human/halted` 才收口；
`--show-luban` 可把通知正文一并列入审计（包括手机端 `/mfc` 激活提示）。

有界工作流定制也可直接交给真模型演练：`--customize-playbook` 指定方案，
`--customize-activities` 与 `--customize-resources` 只接受目录 ID，
`--customize-instructions` 提供该阶段的低优先级补充。例如：

```bash
npm run pilot -- --models .local/models.json --provider glm --model glm-5.1 \
  --repo ../mae-flow-fieldtest-java --isolate-image mae-flow-task-builder:dev \
  --lane '已定位问题修复' --push-confirm --pipeline-statuses success \
  --customize-playbook platform.construction \
  --customize-activities environment-warmup,impact-scan,boundary-test-matrix \
  --customize-resources selected-skills,knowledge-index \
  --customize-instructions '修改前先跑真实构建拉齐依赖；不确定时明确说明。'
```

本机挂了代理(Clash 等)时,curl 环回接口记得 `--noproxy '*'`;
服务进程自身已强制环回直连,浏览器访问不受影响。

## 接真模型(GLM-5.1 + 图片理解)

把任务 agent 目录的 `models.json` 里 `maeflow` provider 的 `baseUrl`
换成真网关(OpenAI/Anthropic 兼容任一),剧本假模型退场,其余零改动。
注意:环回地址永远直连(`sessionDriver.ensureLoopbackDirect`),
内网代理会把 127.0.0.1 的请求劫走(实测 502)。

图片理解是独立原子能力：在同一份 `models.json` 中增加一个明确声明
`"input": ["text", "image"]` 的多模态模型，并用
`--vision-provider <provider> --vision-model glm-5.3-flash` 绑定角色；也可
直接在管理员「服务设置 → 图片识别」中填写并点击「测试识图能力」。主
Agent 只在调用 `InspectImage` 时使用它，不会整段切换模型或把图片字节
写入任务记录。

## 内核纵向闭环(阶段 1,已通)

深层门禁与证据登记**直接复用旧插件适配器**:云端把语义事件合成为
Hook 载荷(sessionstart/userprompt/pretooluse/posttooluse)喂给内核的
`hooks/dispatch.py`——exit 2 = 打回,文案原样进模型视野;内核零改动。
任务创建 = 克隆仓库 → 内核 bootstrap(捕获需求原话、铺转发壳)→
首条 prompt 带内核自己的开工引导 → Agent 跑 `init/current` 推进流程。
集成测试(tests/kernel.test.ts)在 fieldtest-java 上验证:init 真实
初始化、current 出步骤指令、伪造 `.mae-flow.json` 被内核当场打回。
所有 dispatch 调用串行化(posttool 写状态,与下一条 pretool 交错
就是并发写状态——旧世界由宿主天然串行,这里用 promise 链保住)。

开发工作台里的“开发助手”不挂 KernelHost，普通检索、构建和测试命令不会
被流程步骤误拦；但它也不是第二套流程。服务端每次都读取当前内核步骤，只有
`allow_source_edit=true` 且非审批、非 tests-only、非 host-wait 的窗口才
允许启动。启动时冻结内核 step/revision 与工作区内容指纹，结束时生成变更
文件和真实工具结果摘要；交还前再次核对内核锚点。审批卡已经生成、内核锚点
变化、Git HEAD 被间接改写或现场无法核对时一律保持暂停，不把旧现场硬塞回
主任务。正常交还由重建主会话先执行 `current`，再在原步骤承接修改；摘要仅
是上下文，不是批准或质量证据。

## 内网能力模拟件(用户原则:外部完全就绪才碰内网)

| 内网能力 | 模拟件 | 真件就绪时 |
|---|---|---|
| GLM-5.1 网关 | scriptedModel(剧本)/ bigmodel 浅探 | 换 models.json baseUrl |
| 小鲁班通知 | notifier.FakeLubanServer | 换 endpoint 与鉴权 |
| Git 服务端(MR) | gitPlatform.FakeGitPlatform(裸仓+HTTP) | 换 baseUrl 与鉴权 |
| 权威流水线 | 同上(trigger/status,结果绑 SHA) | 换 baseUrl 与 Job 配置 |

语义(投递失败不改流程、MR 幂等、旧绿灯不背书新代码、验证中→等待合入)
是真假件共同的契约,写在各自测试里。

小鲁班插件的手机审批入口也已收敛为纯文本适配层：配置权限 0600 的
`--luban-plugin-token-file` 只会准备 Cloud 回调端点，插件或内网桥带固定
Token 向同一服务端口的 `POST /integrations/luban/plugin` 发请求。完成真实
小鲁班入站联调后，再显式加 `--luban-plugin-replies`；在此之前通知不会谎称
“直接回复 1”可用。每条小鲁班消息都会明确提示：手机端必须先输入 `/mfc`
激活 Mae-Flow 插件，未激活时普通回复不会进入 Cloud。唯一待办会返回完整
详情；开启该能力后的通知会建立带 waiting 版本的短期上下文，因此账号只有
一项待办时，激活插件后即可回复选项序号、确认语句或具体修改意见。多项待办
必须先选任务或携带通知里的审批码；“详情/选择/通过/退回”仍作为无会话上下文
时的兼容指令。短期会话只负责定位卡片，每次提交仍核对当前 waiting 版本；
多题卡按当前题逐题收集，全部答完后才把结构化答案一次
提交，避免纯文本答案错配或只提交第一题。选项不合适时可回复
`自由回复：答案或修改要求`，原话会随决定保留；无法唯一理解的自然语言不
猜、不提交，会明确提示如何消歧。全是选项题时也可用 `1/2/1` 一次答完。
真实插件的字段与原生验签由部署桥翻译，Cloud 不复制审批状态机。完整契约
见 `docs/luban-mobile-approval-handoff.md`；内网 Agent 可直接按其中的
部署、字段映射、联调与验收清单执行。

通知正文可按部署自定义(三个模板键,`{占位符}` 按类别白名单,配错
拒绝启动;激活提示与手机审批指令不随模板走)。词汇表与用法见
`docs/luban-notification-templates.md`。

## 已知边界(诚实清单)

- **2026-09-02 持续检视宿主收据链的死锁排查——内核修六处、Cloud 同步契约**
  (用户拍板:"重点看 agent 卡死、内核卡死、cloud 和内核摩擦;内核过于
  严格完全可以放松,目标是完成任务,不是跟看犯人一样管 agent")。
  ①**内核侧**(mae-flow@092fad5,随 `kernel/` 快照进来)实测复现并修掉
  六条"一次失败=永久失败、无命令可救":权威收据原来逐字封整份
  `delivery_loop`、意见正文和 payload,写盘不限体积、读回限 32 KiB——
  一轮 12 条 350 字的 MR 检视(内核允许单条 4000 字)就越线,此后反馈、
  流水线登记乃至 **MR 合入后的 close** 全报"收据过大",而制造死锁的那条
  命令自己报成功,现改封摘要;凭据路径不解引用,`<data>` 经过一层软链
  (macOS `/var`、容器挂载)就一条宿主命令都过不去;一份权限被动过/写坏
  的历史收据 `SystemExit` 掀掉整条命令(原来的 `except SystemExit:
  raise` 是空操作),现历史台账体检 fail-soft、鉴权仍 fail-closed;先存
  状态后落收据的窗口改为先暂存后原子改名;"开链前先要有链"把首条宿主
  动作挡在门外、老 PASS 拿不出流水线收据就永远关不掉,现"有链才查链";
  收据只按任务号归属改按"任务号+realpath(工作区)"。
  ②**Cloud 侧**:收据契约在 `src/kernelDelivery.ts` 里有一份 TypeScript
  镜像(`kernelHostLifecycleProjection` / `trustedKernelHostProjection` /
  `trustedKernelHostActiveBatch`),它绑的是旧契约——投影 schema、payload
  存法、收据文件名归属、活动批次比对方式四处都对不上新内核,直接换快照
  会让三个 fail-closed 门恒假(`syncFeedbackStoreFromKernel` 直接 throw、
  终态证明永远不成立)。本次把镜像逐字段对齐到 `host_receipts.py` 的
  `host_projection`(schema /2)。**这份契约现在有两份实现,一边改另一边
  必须同步,否则整条持续检视链静默锁死——这是长期隐患,该收敛成单一
  来源。** Cloud 侧的宿主绑定与凭据签发已由持续检视终审独立落地,本次
  未改。
  **已验**:真内核+真 git+真 RSA 端到端回归(量大检视整轮走通并在合入后
  收口、软链信任根下可用、绑定由宿主写在工作区之外、流水线登记无凭据
  被拒/摘要不符被拒/配套凭据放行)、Cloud 全量、双 TypeScript、Web 生产
  构建、probe 九项事实、内核全量自测与基线逐一对拍。
  **未验**:真模型真容器下几十轮反馈的累积表现;收据至今**不做清理**,
  只增不减,扫描成本随任务寿命线性增长(现每份恒定几百字节,未实测过
  上千份时的耗时)。
- **2026-09-01 定向知识提取 + 插话 @ 引用首版**(用户拍板:"自己造
  skill 知识并且支持随时引用,防止开局忘选了"):
  ①提取:Skill 提交面板新增「从参考代码仓提取草稿」——填参考仓+一句话
  意图(可加路径提示),平台用发起人自己的 git 凭据做**只读克隆**
  (pushurl 毒化,不是提示词嘱咐),起一次性会话(10 分钟硬预算,单飞,
  容器隔离与任务同纪律)按内置提取纪律(internal-skills/,不进货架)
  产出 SKILL.md 草稿回填编辑框;草稿先过密钥扫描(命中整份作废),
  人工修订后走既有提交/审核闸。②引用:「补充给主任务」新增 @ 选择器
  (团队 Skill+业务知识资产,一次最多 4 项),前端只传结构化标识,服务端
  解析并在**发送时固定版本**、整份正文注入(48k 字预算,超限如实报错
  不截断);三态送达:running 直送 steer、queued 并入使命、等人决定时
  压进决定 continuation(持久化,重启不丢)随下一次决定送达;中途引用
  写入知识足迹(loaded,观测旁路)。**已验**:剧本模型端到端(提取产
  草稿/克隆失败分类/敏感值作废/格式补交两次后如实失败/重启中断如实
  报)、@ 引用三态送达与版本固定、双端 typecheck、Web 生产构建。
  **未验**:真模型提取质量、真浏览器操作链;提取会话超时/格式重试
  参数未经真仓调参;等待态引用只随"下一次"决定送达,决定卡本身没有
  @ 入口。
- **2026-09-01 持续检视闭环已落地**(设计与拍板:
  `docs/continuous-review-loop-design.md`):MR 创建、push 和流水线变绿都不再
  结束任务；同一任务、分支和 MR 会持续接收工作台批注、Build-Fix、流水线、
  MR 检视、冲突、负责面裁决和 push 确认返工，逐批修复并由各自权威来源核验，
  只有 MR 合入或用户主动停止才进入终态。Mae-Flow 源码位于专属分支
  `cloud/workflow-customization`，Cloud 发布件由 `harness/sync-kernel.sh` 回灌并在
  `kernel/VENDORED` 记录来源；服务启动会探测能力，缺失时拒绝新契约开单，
  不静默退回旧的 `end → init`。默认修复预算为 **20 轮**，耗尽沿用停摆通知
  请人处理。**已验**：真实内核命令契约、旧 `end`/错误重开迁移、四类单 writer
  竞态、同一 MR 两轮不同来源反馈后合入、Issue Flow 建 MR 后流水线反馈、假平台
  E2E、Cloud 全量、双 TypeScript、Web 生产构建、内核全量自测与 probe。
  终审又补齐了宿主命令的工作区外私钥签名、逐条回执反代填、MR 评论编辑版本化、
  FeedbackStore 坏账停摆/缺账重建，以及“MR 已合入但本地多出未推送提交”的留痕
  收口；二次审计继续把所有权威投影改为工作区外持久收据背书，并覆盖迁移回滚、
  close 后 Cloud 落盘中断恢复、索引结果补写、单任务坏账隔离和 discussion 拉取
  故障重试；最终信任根审计又把“是否启用持续检视”固化为工作区外路径绑定，收据
  覆盖完整生命周期与精确活动批次，并让无末尾换行的完整坏账也 fail-closed。这些
  接缝均有事故回归，不再依赖提示词、可写状态或总体回复猜测。
  **未验**：真浏览器、真模型、内网 CodeHub/流水线；Issue Flow 的前置流程没有
  Mae-Flow 内核，本批在其既有单 writer 上复用同一反馈索引与闭环词汇，是否把
  Issue Flow 的交付后半段也迁入 Mae-Flow 内核留待后续拍板。
- **2026-09-01 单仓拆分(交付单元)首版**(方案 docs/
  delivery-unit-split-design.md,用户逐轮检视拍板):需求图节点从"仓"
  泛化为交付单元(仓+文件面 scope),单仓下单可勾"大需求先分析拆分";
  同仓单元确认时按拓扑序补隐式串行边(第一版同仓一律串行,跨仓照旧
  并行),子任务带机械生成的单元任务书与负责文件面;交付门禁按路径段
  闭合前缀校验提交清单,越界停摆举卡由主责任人放行(记豁免)或打回
  (派窄使命撤出);同(仓,责任人,单号)撞分支在确认前拒绝。已验:
  端到端剧本(真会话写产物→撞单号挡下→分单号确认→串行拆单)、门禁
  放行/打回/邻居目录(src/filterX)不吞、任务书上下游含隐式边,全量
  测试+双端 typecheck 绿。真实 GLM 单仓三单元严格串行、单仓直干及多仓
  两子任务并行均已跑到浏览器 MR 合入和父任务自动 completed；真浏览器
  外部账号点击越界放行为 403 且点名主责任人（根因总表「第五轮续测」）。
  **如实挂账**:①返工新增文件沿用上一轮交付白名单，当前需人再次勾选；
  ②跨仓并行子任务不会自动接收兄弟任务后发的共享契约修订，仍需 owner
  在最终检视兜底；③拆分不合理的返工走确认卡"需要修改"+批注循环，未
  单独建"重拆"入口；④专注审阅弹层尚未把后台 DOM 从可访问树 inert。
  **2026-09-01 追加(消掉"父单号"概念,用户拍板)**:勾"先分析
  拆分"的需求下单不填单号,单号在拆分确认卡逐单元收(创建豁免与
  确认强校验对称,产物目录按任务 id 命名);确认卡对缺单号的节点
  直接给输入框,不再只读卡死。免单号路径有专属端到端覆盖。
- **2026-08-30 第二轮复验修复(P0 完整性链 + 人审可用性)**(codex 真
  Linux 容器 + GLM 整链复验揪出 3 个 P0,记录在 docs/
  rootcause-e2e-20260830.md「第二轮 E2E 复验」一节):已修
  MFC-033/034/035/036/037/038/039/040。要点:①定格基线必须是 HEAD
  祖先,Build-Fix 前机械重放净改动回基线(树逐字节一致),推送前复核
  只停不改写;②假平台冲突门禁与 merge 同用真实祖先事实,浏览器 409
  给人话页;③merged 必须核对平台源提交==本任务验证过的 delivery.sha,
  不符停摆点名两个 SHA。**如实挂账**:①内网真平台的门禁契约若不返回
  sha 字段,MFC-038 的核对自动退化为旧行为(留痕不拦),接内网适配时
  必须补该字段;②MFC-034 修法基于代码级根因(分栏把手压行中心)与
  纯逻辑穿透测试,真浏览器手感须由下一轮 E2E 实点确认(本仓无浏览器
  测试基建,零依赖纪律不为此拉 jsdom);③交付白名单"勾选/返工/CTA
  三处拆散"的整卡合并是专门交互轮的活,本轮未动;④MFC-037 的
  「await_merge 无法插话上报合入失败」未加新入口——门禁说真话后监控
  自动派修,取消路径照旧,若真平台出现门禁绿但 merge 仍 409 的缝隙,
  仍需人工。

  本轮新增修复 MFC-051/052/053/054：重复子单号卡死、scope 重叠/任务书
  不闭合、403 不点名主责任人、429 原始 JSON；续测修复 MFC-055/056/057/
  058/059：重复询问已确认事实、贡献 diff 混入目标分支、最终返工阶段不可
  编辑、重试误唤醒 Agent、假平台忽略多仓 repo。两个父任务均已完整收口。
- **2026-08-30 双轮挑剔实测修复轮**(codex Linux + CC macOS 两轮真模型
  E2E,根因总表 docs/rootcause-e2e-20260830.md):已修 MFC-001/002/003/
  004/005/006/009/010/011/012/013/016(宿主)/018.1/019/020/021/022/023/
  024/025/028/029/031 与 007/008 的标题/窄屏部分。**尚未修、如实挂账**:
  ①MFC-030 交付文件树仍会把未提交的工作区文件(如 Agent 自己重定向出的
  build.log)列进 all_paths 可勾选——勾了会指示 Agent 补提交,语义
  合法但易勾错,展示分组待做;②MFC-014 Issue Flow 凭据边界只做了静态
  审计,按交接文档建议须先做动态 secret boundary 验证再动层;
  ③MFC-015 容器起后未对拍 Memory/NanoCpus/User;④MFC-016 内核仍写
  无时区裸时间戳(宿主已按 UTC 解,长期解法在内核仓);⑤MFC-017 容器
  内桌面通知无效(小鲁班通道不受影响);⑥MFC-026/027 单号预检与
  Spec 双确认要动内核流程,另批;⑦MFC-007 问题一:Agent 自设检视卡
  仍无原生增量入口,只有 cloud_push_confirm 卡有"这次修改"。
  修复验证口径:typecheck 双配置 + 全量测试 + 内核 selftest 全绿;
  真容器/真模型整链由下一轮 E2E 复验(测试建议见根因总表末尾)。

- **2026-08-30 检视闭环与协作止血轮**(第三方视角三路审计后用户拍板
  "全部修改+充分测试"):①检视答复台账跨批继承——检视人解决部分/
  新增意见不再把已答复的讨论重新派单重复回复(曾被探针测试实锤,
  每次集合变化白烧一只修复会话还对检视人复读),新批只派未答复的
  意见,停环文案点名未答复 id;回复文件解析容错同行格式(`[id] 正文`),
  按 reviews/discussions.json 名单裁定头行防误切。②completeReview
  给发起人回执通知(修复完成提醒批注作者的 notifyReviewReady 先前
  已有)。③批注死锁开管理员旁路:作者不在场时 admin 可在批注面板
  代确认/代删,
  台账 op.by 与 verified_by 留痕;"谁的意见谁裁决"仍是默认规则。
  ④决策与跳闸记操作人:decide 落 waiting.json 的 decided_by,
  prepush skip/stop/retry 与任务 retry 带 actor,user_skipped 收据
  含 skipped_by。⑤编译失败后人工跳过的交付,MR 标题机械打
  「未经本地编译验证,X跳过」——判据是 skipped_by,清单整理的
  user_skipped 不打标(那是 prepush 通过后的机械调整)。⑥月光模式
  认不出明确"通过"类选项时整卡退回等人,不再兜底选第一项(选项
  顺序一变就可能替人选中反向分支)。⑦push 确认卡指引改用界面真实
  名称「交付材料 → 工作区变更」(原文案指向不存在的入口名)。
  **同日第二批(易用性/协作)已落**:⑧同(单号,归属人,仓)在途重复
  下单直接 409 指路旧单(撞分支名+MR 互相污染的根;终态旧单和内部
  拆单/原位重跑豁免);⑨"等待你去合入"进个人待办收件箱(await_merge
  曾被归进绿色完成堆,MR 躺到过期);⑩下单成功当场打开新任务工作台
  (原来 201 响应被丢弃,零反馈);⑪"发起新任务"被配置挡住时弹窗
  照开、缺项清单可见,只禁提交;⑫清空草稿连执行补充/交付方式/基线/
  修复轮/工作流选择一起清(上一单的指示曾悄悄带进下一单);⑬深链到
  已删除任务明说并回列表;⑭收件箱超 3 条可展开、零任务空态改指路
  下单;⑮流水线状态串翻人话(注记直出,原文进悬停)、UT→单元测试、
  SHA 加释义、"原始 SSE 事件流"→"实时执行日志"、面板链接文案与
  新标签页行为一致;⑯403 文案点名责任人。
  **仍列第二批不动**:检视人**串内追问**系统看不见(适配层
  mr_discussions 契约只拍平 notes[0],id/正文都不变化——需适配层拼
  接追问 + 云端批次身份掺正文两侧同改;临时口径写进使用说明:
  **追问请开新讨论或直接点解决**)、同仓并发共享可写构建缓存
  (buildSlots 先调大)、团队设置无留痕/回滚、skill 提交审核两头
  无通知、流水线仍无可点链接(平台侧没有 URL 字段,需适配层供数)、
  手机端 diff 双栏无单栏降级。
- **2026-08-29 重启/重部署韧性审计与修复轮**(铺开使用前;逐阶段
  恢复矩阵与运维手册见 docs/restart-recovery.md):已修七处"重启即
  伤人"——①预算耗尽/拒陈灯注记的 verifying 任务重启后续轮而不是
  重建 MR + 同 SHA 重触发流水线(recover 前缀匹配 + tryDeliver 增
  running 岔路 + 续轮时复位人工求助注记);②issue 容器补 ownership
  标签并入清扫白名单(修前 kill -9 遗留容器永久漏网;修前创建的存量
  无标签,要按手册人工清一次);③起服清扫 .runtime/*/operation-*
  明文凭据现场(15 分钟年龄闸,给 detached git 留收尾窗)+ skill
  暂存目录;④资产库发布不再被崩溃孤儿 vN 焊死(提交点没前进的 vN
  可证明未发布,回收重写并留痕;故障测试同轮改钉新语义)+ 构造时
  回收写入残骸 tmp;⑤登录会话哈希落盘(auth.json.sessions,0600,
  存 sha256 不存原始令牌),重启不再全员踢回登录页;⑥通知投递结果
  随 task.json 落盘,"没送到"红旗活过重启(补发仍要人工);⑦恢复
  队列按任务号数值排序,task-10 不再插 task-2 的队。**不修的如实
  记**:在途通知丢失不自动补发;PG 投影缺数据等下次重启重放;
  浏览器半填表单会丢;await_merge 监控预算烧完只有重启这一条重武装
  路(重部署场景恰好自愈)。
- **2026-08-29(后续)v1 执行偏好整体退役并入 v2**(用户拍板"趁无
  存量窗口统一"):`execution-profile.json` 文件、任务摘要三字段、
  团队/任务阶段勾选定制(stage_customizations)、pilot
  `--customize-playbook` 全部退场。改嫁去向:任务补充说明/团队执行
  约定/仓库执行约定编译为 `workflow_profile.supplements`(没选工作流
  的任务产出 supplement-only 档,按平台默认执行、只叠建议,呈现如实
  说 bounded/platform_default);阶段结构定制唯一入口=工作流资产库。
  设置路由对老客户端传来的 stage_customizations 显式 400 指路,不
  静默吞。**代价如实记**:阶段级"勾选可选动作"这种轻量中间形态没
  有了,要么写文字建议、要么建完整工作流;若内网试用反馈这层缺口
  真实存在,再评估在资产库里补"从阶段勾选生成工作流"的快捷路径。
  内核侧同轮 mae-flow@2df944e(kernel/ 快照已收编)。
- **2026-08-29 工作流定制端到端审计修复轮**(审计报告见
  docs/workflow-customization-readiness.md):5 个 P0 全清——①内核
  stderr 告警与 profile_invalid 诊断上浮为任务级 `execution_plan_alerts`,
  执行现场标红对拍,"界面展示定格、Agent 实跑默认"不再静默;②门禁
  两侧补保 workflow-profile.json;③panel 阶段词表对齐 playbooks 并加
  一致性断言,云端词表任务不再提供必然误导的阶段弹层;④内核定制分支
  已合 main 并推送,kernel/ 快照来源回到 main;⑤资产库"最终方案/依赖"
  两视图明示"本地预览,非编译产物"(编译真品只在任务创建时产生,
  库级预览伪造编译结果反而更失真)。P1:stage.id 失配降级留痕、CLI
  病档不崩、选择器带 id 直达详情、冲突本机暂存一键恢复;列表页直答
  适用范围。**边界如实记**:prepush/预热/修复前置会话不消费工作流
  定制(现状如此,是缺口还是边界待拍板);set-default 设默认方案未
  实现(未拍板不建);**双 profile 分工**——v1
  `execution-profile.json` 是有界建议层(层叠文字补充,不改结构),
  v2 `workflow-profile.json` 是结构化定格(final_snapshot 即唯一有序
  方案),内核同时消费、互不覆盖,v1 退役计划待拍板;内核内
  "步骤→阶段"仍有两份(panel PHASES 与 playbook.phase),暂以词表
  一致性测试钉死,单一来源化留待内核侧重构。
- **2026-08-28 流水线信息链对齐 toolkit(内网对比报告驱动,分三层)**:
  修复环"时好时坏"的头号根因是**陈灯**——MR 头上无有效流水线时平台挂
  旧分支的灯,而适配层返回里连 sha 都没有,宿主想核验都没材料。现在:
  ①宿主机械核验(selectTerminalRun):run 回显 `sha`/`is_valid`,绑错
  SHA 或 is_valid=false 一律拒收并写明"已拒陈灯",继续等;②适配层
  `pipeline_status`/`pipeline_artifacts` 支持 **candidates 降级链**
  (首成功赢,全败聚合上报)与 **contract 直通**(命令输出即宿主契约);
  checks 扩展 stage/tool/details(缺陷:规则/文件/行号/描述),修复
  使命注入结构化失败明细;③**取数脚本进仓=内网现用版的收编**
  (deploy/adapter-tools/pipeline-status.sh / pipeline-artifacts.sh:
  按 sha 直查 pipelines+quality CLI+reviewtips+MCP SSE 构建日志,
  逻辑零改动,只加 sha/pipeline_id 回显、checks 的 tool/details、
  地址环境变量化)——勘误×3:上一版把桥脚本当"/etc 配置产物"不进仓
  导致 artifacts 链空转一个月;我按报告猜写的三个脚本(标准
  streamable-HTTP MCP)与内网真实形态(自定义 SSE 客户端)不符,已删;
  **收编件曾被误称"实测稳定版"——它来自修复环不稳的这一侧,其
  `codehub-y/api/v4` 取数路来路未证(2026-08-28 用户点破)。toolkit
  源码仲裁已回:稳定系统主路=MCP 网关 actual_head_pipeline(带
  is_valid),CLI 降级,REST 只建 MR 一处(v3);v4 是 CodeHub 的
  GitLab 兼容层,toolkit 从没走过。已按仲裁重排:新增
  pipeline-status-mcp.py(主路,streamable-HTTP 客户端
  mcp_http_client.py 带 --list-tools 自描述对拍)做第一候选,现用
  v4 脚本降为第二候选,裸 REST 第三;SSE 日志客户端 mcp_sse_client.py
  原文收编(个人路径/真实 MR 已泛化)**;④SuperChecker 类**不可修工具前置分诊**(serve
  `--unfixable-tools`,全体命中且有 tool 证据才不派修复,拿不准照常派;
  内网工具→维度映射表里 SuperChecker 归 CODECHECK,名单可直接用)。
  边界如实记:mcp_sse_client.py 已收编进仓，内网部署只需
  额外提供可刷新的 mcp-token;
  收编脚本的三处增量(回显/tool/details)未在真网关跑过,内网
  --selftest 对拍是硬前置;覆盖率差分与 AI Review Tips 暂未接(增益项)。
  **⑤(同日后续)artifacts 通路整体重写为 toolkit「PipelineLog
  编排器」忠实移植**(用户带回 7 系统全景图后拍板"照抄"):
  pipeline_log.py 里 8 个 Strategy 原名原序、落盘文件名照抄、三条
  降级链(构建日志 SSE→build 网关 zip→有界日志窗口;CodeCheck codeccp
  MCP→reviewtips→defect/list),新接结构化构建错误
  (get_build_error_info)、构建阶段(get_record_fullstages)、
  覆盖率差分(CodeCovDiffCoverageTool)、**行云** AI Review(纯
  REST;此前误写"星云",用户已正名)——上一段"覆盖率与 AI Review
  暂未接"就此翻案;mcp_http_client.py 加五网关注册表。首次内网对拍
  已完成:五网关 tools/list 钉死 CodeHub request 嵌套、Build 必填
  group_id 与 CodeCov jobId;真红灯 MR 的 artifacts 首验按正确口径是
  8 个 Strategy 中 6 路有材料:mergeable-state 因旧顶层参数失败，
  coverage 的 `No data found` 也只算缺证据，不能冒充成功；quality 由
  CLI、build log 由 SSE 降级兜住。现已按真实 schema 共用
  mcp_tool_contracts.py 修正 status/artifacts 两条链，并修正宿主把完整
  MR URL 交给 artifacts（status 仍使用 MR iid）。构建材料全空不再记
  ok；长日志另存错误上下文，结构化错误优先装箱，总包限制 6MiB 并用
  omission 清单明说省略项。但**修正后的真网关复验仍是硬前置**;
  build MCP zip/日志窗口未被本次 SSE 成功现场实际踩到,
  pipeline-status MCP 主候选也需单独真跑。summary 的 guessed_args 保留
  为后续新增工具的诚实账,本次已确认调用不再列入。离线烟测只证明
  fail-open,不冒充取数验证。toolkit 的 FSM/Monitor/Scheduler 不移植
  (流程权威在内核);review/conflict 两条策略路由未照抄,待拍板。
  **⑥取证缺口兜底已落地**：宿主按 COMPILE / UT / CODECHECK 逐维
  对齐具体报错，不再以“附件包非空”冒充三维都有口粮。全缺时有限重试，
  到预算后不派 Agent、不扣修复轮并明确等人；部分缺失时只修已有证据的
  维度，同时小鲁班求助。工作台自动生成《流水线证据缺口》材料，用户把
  平台原文作为批注回灌后，同一 SHA 自动恢复分诊；等待期间平台若晚到
  证据也会自动续跑。通知失败只影响提醒，不改变任务真相。

- **2026-08-28 待提交清单审核松绑(用户点破"拿 SHA 当令箭")**:
  审计结论:交付确认里 SHA 只有两处是真令箭——流水线结果绑 SHA
  (防陈灯)与 user_skipped 绑 HEAD(旧拍板不背书新代码),保持不动;
  其余三处是拿 HEAD 当"清单"的替身,已改:①push 确认卡的 call_id
  从 HEAD 前 12 位改为**交付文件集合的指纹**——人在看卡时流水线修复
  推进 commit(清单没变)不再作废重发,通知不轰炸;②重新举卡时正文
  **增量优先**("较上次确认:新增 X;其余 N 个一致"),配合 .gitignore
  随单交付的新惯例,补一个文件只需扫一行;③勾选提交撞上现场变化不再
  整单打回——消失路径=已与基线一致本就无可交付,自动移出留痕,全部
  消失才报冲突;④任务级/个人默认均缺省但用户提交过清单时,push 复核
  不一致改为重新举卡而非把任务判 failed(死胡同改出路)。契约钉在
  pushConfirmation.test.ts。界面侧勾选条文案同步瘦身。**边界**:确认卡
  正文里的"基线起 N 个文件"在等待期间不随 HEAD 刷新(diff 以检视材料
  实时为准,正文已注明);检视面视觉/布局的整轮重做仍欠着。

- **2026-08-29 工作台阶段布局审查轮(用户判"整个界面都不好")**:
  审查结论:病根是**平均主义**——每个面板把所有已知事实近似等权
  陈列,"此刻该做什么/为什么停了"没有独占层级。已改(7f8ebb1 +
  36048bc):检视面词级 diff 高亮/文件树"将推送 vs 仅本地"分组/
  长决策背景折叠;列表收起卡隐藏阶段轨道与 Token 遥测、failed/
  verifying 加一行真话;工作台右栏按阶段给重点(failed 原因置顶,
  verifying 点名等待项);决策卡标题类型化、step id 不示人、报错贴
  按钮加 role=alert;交付阻止诊断出 meta 进 alert;批注引用两行
  截断。**边界**:两条审查发现有意未做——"耗时与卡点"与决策卡的
  当前卡点重复(改动涉及 cost-focus 结构,收益低)、团队 signal
  红条与 pill 双重强调(视觉噪声轻);验证全部是构建+测试+服务
  烟测,**没有人眼看过渲染效果**,视觉细节(间距/配色)待用户过目
  再定,不宜继续盲调。

- **2026-08-28 "困死 Agent"专项排查批(四路审计驱动)**:
  ①**勘误**:此前"prepush 门禁放行构建产物 rm -rf(白名单)"在生产里
  **从未生效**——`serve.ts` 一直把演示桩 `demoContract`("rm -rf"裸子串
  一律拒)接在生产兜底位,白名单放行后被它照拒,死循环还收口成
  code_failure 冤枉代码;单测只测了白名单函数没测接线链,绿灯是假绿。
  现已摘除(危险命令真裁决在内核 gate 与 prepush 安全层)。②预热/
  prepush 的 `.mae-flow-work` 目录由宿主预建(此前使命让写 build-notes、
  闸却拦 mkdir,无出路);安全层拒绝文案不再自称"推送前编译会话"。
  ③无出路 deny 文案批量修正:gateService fail-closed 不再说"请稍后
  重试"(违反"绝无无预算干等"),越界拒绝写明工作区边界与解析失败
  情形;kernelHost 基础设施拒绝明说"停止重试、如实收口"。④内核同批
  (8f08755):修复窗口允许多笔提交/同 SHA 重复登记不吞在途修复/构建
  产物出账授权集合;safety_kernel 阶段级源码闸残骸拆除;交付清单闸
  指路改指 manifest set。边界如实记:文案改动无行为断言的仅靠人审;
  修复窗口新语义未经真实 RED 多轮修复实战(内网首撞时验)。
  ⑤**产物脏账根治(同日追加,承接 89acafd)**:PASS 不再要求工作区
  干净(push 只传 HEAD),产物留在工作区不删——与增量编译建设(ccache/
  持久缓存)对齐,"每轮删 target/ 下轮全量"的自相矛盾终结;PASS 收据
  对残留文件只提示不拦截(.gitignore 规则由 Agent 随单补,不"提请
  用户"——平台上用户操作不了仓库文件)。**机器兜底退场的代价如实记**:
  业务改动漏提交不再有 dirty 检查拦,防线=使命嘱咐+收据提示+推送
  确认人眼;内核 build.md 已同步勘误(2c1b0f2)。

- **环境预热编译(2026-08-26 新增,真模型未验)**:现场就绪即在编码
  容器里另起专职会话编译基线——验环境、焐按仓缓存、把构建入口沉淀到
  `.mae-flow-work/build-notes.md`;收据绑起跑 SHA(基线红=环境/上游的
  锅,与本单增量切开),观测旁路 fail-open,结果不构成任何交付证据。
  边界如实记:①与主 Agent 共享容器 CPU 限额,重型仓预热可能拖慢开场
  探索(未做独立限核);②共享工作区未加锁,靠"预热窗口=需求澄清期、
  没人动代码"的时序事实兜底,收据不承诺工作区全程未变;③只编译不跑
  UT;④仅注入 runner 的单测裁过(收据/幂等/fail-open),真模型+真容器
  整链尚未跑过——下次 pilot 顺带验。前端在工作台执行现场有实时预热
  面板(SSE),列表页只在基线红时亮牌。
  同批补的两个实战修正:预热/prepush 会话对 `.mae-flow-work/`
  `build-notes.md` 精确豁免读写(其余内核现场照拦,组合走私有测试钉);
  **推送前验证失败停机后,人可显式拍板跳过本地验证直推流水线裁决**
  (POST /tasks/:id/prepush/skip,仅 blocked/environment_error 可跳,
  绑拍板时刻 HEAD,新提交即失效;这是 fail-closed 停下后的人工出路,
  不是自动降级——权威裁决始终在绑 SHA 流水线)。

- **2026-08-27 推送前编译的人工控制三件套(内网实锤驱动)**:部署重启
  杀掉在途编译轮后,现场停在 preparing、「重跑续推」又按 verifying
  在途拒绝,人对着僵尸现场没有任何出路(实测)。现在气泡浮层里有:
  **重跑**(POST /tasks/:id/prepush/retry,真在跑时服务端拒绝并明说
  "正在进行"——这句拒绝兼作活性探针)、**停止并直推流水线**
  (POST /tasks/:id/prepush/stop,用户拍板的合并语义:中止本轮、
  如实落停机账后立刻绑 HEAD 跳过续跑,编译与 UT 交流水线裁决;
  停止瞬间恰好通过的按通过继续,暂停中的只停不推;中止对竞态反复
  补刀直到收口,attempt 预算兜底不会无限等)、跳过(同上)。另:编译槽位排队真相写进 prepush.message(原来只在任务
  detail,气泡里一动不动的"准备"被当成卡死);「UT生成方式」镜像进
  任务台账并在知识足迹展示——等于"仓内既有写法"即未指向团队 Skill,
  skill 不被读是正确行为,这句话现在界面上明说(内网曾对着 task.json
  排查无果);货架有 Skill 但命名未命中 UT 模式时 serve 日志点名提醒。
  边界:停止/重跑尚未在真容器整链演练,下次 pilot 顺带验。

- **2026-08-25 编排瘦身的云端适配(run8b 实测整链通过)**:内核编码段
  44→21 步后,cloud 侧同步清理了死步骤引用(build_review/verify_*/
  rf_* 等)、tests_only 可用性分支、EXPECTED_STEPS 相关提示词;开场
  「Cloud 执行契约」从"禁止编码会话编译"改为"容器内自由编译自测,
  本地结果不构成交付证据"。run8b(glm-5.1+真容器,REQ2026082601)
  实测:文档段 9 张卡照旧,build 期模型自由跑 `mvn test` 零拦截,
  一次提交收口,prepush 第 1 轮过,MR+流水线三维核销到 await_merge。
  过程中的 16 次工具报错全是护栏按设计工作(commit 规范、单 Bash 单
  commit、上一单现场文件保护),模型均自愈,无卡死。
  **顺手逮住并修掉**:容器透传环境白名单漏了 `MAE_FLOW_HOST`,容器内
  内核 current 按"本地宿主"渲染,云端确认类步骤的 `--auto` 路径失效
  (run8b 里领域归档又弹了人工卡)。已把宿主身份注入任务容器环境并
  加回归测试;run9(REQ2026082602)复验通过:归档/清单零人工卡
  (9→7 张),且预置 java-autout 宿主 skill 后,知识足迹记录到模型在
  build 步 `read` 了 SKILL.md,写出的测试严格按 skill 的三段式命名
  ——skill 消费链路(此前 autout 未被消费的问题)由 build.md 的
  「写测试前先读 UT生成方式 指向的 skill」锚定修复。run9 还顺带
  验证了 `--resume` 任务级恢复:超时停在 verifying 后续跑,直达
  await_merge,流水线三维核销。

- **"serve 反复挂、一点错误输出都没有"的真凶(2026-08-18,内网实战)**:
  死法不是内存也不是端口,是**没人接的 Promise rejection**——Node 从 15
  起默认因此终止进程(本机 v24.17 实测:`void Promise.reject(...)` 直接
  exit 1)。而本仓到处是 `void 某个异步旁路()` 的即发即忘(通知、投影、
  流水线轮询、合入监控、容器清理、内核登记),其中最要命的一条是
  `decide` 那头的 `void this.settle(...)`:人点"通过"→模型跑一轮→链上
  任何一处抛异常→整台服务连着所有在跑的任务一起没,后台跑时 stderr 还
  丢了,现场只剩"进程不见了"。三处一起补:①`settle` 整条链进 try,抛了
  **任务如实 failed 并写明原因**(进程级兜底只保证不死,不保证不哑——
  异常被吞、任务永远转圈更难查);②旁路统一走 `bypass()`/`kernelBypass()`
  记账,不再裸 `void`;③内核 hook 子进程的 `stdin` 补 `error` 监听——
  EPIPE 是**流上的 error 事件**,不经过 Promise,catch 拦不住,没监听器
  就是 uncaughtException。**假件能裁的**:投影全线拒绝服务时任务照常收口
  且留痕、收口抛异常时任务 failed 写明原因。

  **勘误(同日,内网 crash.log 回来了)**:上一段"裁不了的"已经有了
  答案,而且答案难堪——**先抛的是修复本身**。第一版 guardProcess 的
  record 在 stderr 断管(后台起服,日志读端先退)时 console.error 抛
  EPIPE → 又进 uncaughtException → 又 record → 无限递归吃死事件循环:
  进程还在、CPU 0%、API 全部超时、crash.log 同一毫秒成对的
  "write EPIPE",栈指向 record 自己。教训写成代码三层:stdout/stderr
  装 error 监听在源头吞断管(muzzleBrokenPipes,装在第一行输出之前)、
  record 先落盘后上屏、重入保险断递归。真子进程用例复现该现场
  (serveBrokenPipe.test):掐断两条输出管道后登录/下单/答卡/收口全程
  HTTP 正常应答。**兜底代码必须在它所防御的故障下被测过才算兜底**——
  第一版没有,于是它成了事故本体。
  顺带逮住的第二道假门:演示形态(serve 自起假小鲁班)也索要个人通知
  令牌,可假件收什么都行,那个令牌谁也不消费——内网 agent 端到端验证
  在这儿被"先配令牌"挡住。现在判定跟着生效端点走:假件不索,管理页
  切真端点后要求立刻恢复。

- **上下文撑爆的自愈(2026-08-18,内网实战逼出来的)**:网关窗口比 pi
  估计的小时会吐硬报错(实测 `input too long ... max input length is
  169984`),原来当场判任务失败。现在:判据命中(见
  `looksLikeContextOverflow`,只认超限文案,其余错误一概不认)→ 按内核
  现场压缩一次 → 原样重发(该轮零活动,不会重做已完成的事)→ **只补救
  一次**,压不动/再爆就如实失败,并在详情里说清"多半是单轮输入过大"。
  治本在部署侧:models.json 声明 `contextWindow`(部署手册有实测数字),
  pi 会提前压缩不撞墙,serve 启动会检查并提醒。**假件能裁的只有**:判据
  取舍、自愈被触发、压不动时诚实失败、补救不空转;**"压缩成功后重试
  收口"要真模型的大会话才成立,假件裁不了**(pi 对小会话一律拒压),
  等真模型试跑现场验。

- **Cloud 固有执行契约(2026-08-21 收口;2026-08-25 编排瘦身勘误:
  编码会话不再被禁止编译——内核编码段收敛为宽 build 步,agent 可在
  隔离容器里自由编译/跑 UT 自查,但本地结果不构成任何交付证据,真验收
  仍是下述 Build-Fix + 绑 SHA 流水线 + MR 检视三道)**:每个执行仓的
  `.mae-flow-order.json` 都显式写入 `execution_contract`
  （`schema=mae-flow-execution/1`、`host=cloud`）：最终编译/UT
  运行/CodeCheck=`pipeline`，UT 编写=`agent`，并记录本次真正可用的
  `UT生成方式`。历史 CLI 旗子
  `--verify-via-pipeline` 仅兼容旧启动脚本，已弃用且不改变语义。
  **Cloud 在每个新 HEAD 由宿主 push 前另起一个 Build-Fix Agent**：它在
  一次性任务构建容器运行仓库真实的编译与 UT 命令，失败时可直接修复并本地
  commit，直至通过或明确报告代码/环境故障；它不挂 Mae-Flow Hooks，
  不推进或回退内核流程，也不持有 Git 凭据、不自行 push、不跑
  CodeCheck。PASS 收据绑定修复后的最终 SHA 与 clean worktree；纯网络
  推送失败重试同一 SHA 时复用收据，HEAD 或工作区变化就必须重验。
  Build-Fix 收敛后才展示最终人工代码检视；人确认的是一份可直接 push 的
  代码，而不是会被后续本地构建再次改写的半成品。它是 push 前的快速反馈
  与流量闸门，不冒充最终质量裁判。这里**不按第一次 push / 后续 push
  分叉**，只看本轮修改来源：普通开发按用户的人工确认设置执行；人工检视
  意见触发的修改一定回到意见作者逐条复检，全部闭环后责任人才可确认 push；
  纯 Build-Fix 或流水线修复若没有改变已确认文件集合则自动续推。责任人的
  “继续提交”和关闭确认开关都不能代替意见作者签字；Agent 修完会由小鲁班
  直接通知各意见作者（含 `/mfc` 激活提示）。
  推送后内核仍停在
  `external_verify` 宿主等待点，不催 Agent 在本机继续；宿主触发权威
  流水线，把绑定 SHA 的总体结果和可选 `COMPILE / UT / CODECHECK`
  checks 喂给内核 `pipeline record`。执行契约已经声明权威流水线覆盖
  三项，因此精确 SHA 的总体 success 可以聚合核销；逐项 checks 是诊断
  增强，若明确出现 failed/pending 则优先采用，不会被总体绿灯掩盖。
  STALE 或登记失败仍 fail-closed 留在 `verifying`，但不会催 Agent 补
  宿主证据；`delivery.waiting_on` 明说缺口，`delivery.attested` 镜像内核裁决。
  流水线红灯与人工检视意见统一成为当前代码 Agent 的修复输入，不再并行
  启动第二个写代码的 Agent。修复产出新 HEAD 后再次经过 Build-Fix，再由
  宿主更新同一个 MR；MR 合入或用户明确停止前持续监听，绿灯也不等于结束。

- **MR 闭环升级(2026-08-17,对照内网既有框架,docs/mr-loop-adaptation.md)**:
  失败先分类再派单——九项合并门禁进契约(`GET /mr/gates`,可选端点,
  平台不支持=旧语义一字不变),检视>冲突>CI 只派最高优先级一路;
  重试只数 CI(检视/冲突触发清零);检视闭环(拉讨论→专职会话逐条
  回复→宿主发布并标已解决);冲突修复(宿主 merge 造真实冲突标记,
  agent 在真冲突上解);等人门禁(审批/投票/WIP)挂起等待不空转,
  说清卡在哪并通知归属人;MR merged=完成、closed=等待重开或人工停止;失败
  材料落盘工作区外 pipeline/ 双通道喂修复会话;同 SHA 不再重复触发
  流水线(修复无新提交时直接按上次结果裁,省一条流水线)。五条端到
  端用例(tests/mrLoop.test.ts)+旧 delivery 16 项全绿。
- **能力核对报告已消化(2026-08-17,报告原文由内网模型按
  docs/mr-loop-capability-audit.md 真调产出)**:九项门禁拼写与分类
  假设全部证实(平铺布尔+reason,适配层加 bools 模式);检视回复改为
  **默认不代点已解决**(报告 D3:resolve 归检视人;已回复未确认=
  挂"等检视人确认"继续监控,不算修不动;`--resolve-discussions`
  显式开代点);MR 建单先查后建(幂等语义 CLI/REST 不统一,查询兜底);
  MCP 定为**桥方案**(streamable HTTP,几十行脚本,只为完整日志下载
  服务)。**仍未在真平台上验证的三件事**(报告实测受阻,试点必验,
  清单在 docs/mr-loop-adaptation.md §11):①oauth2 token push(被
  代理 504 挡住);②MCP access token 供给(CLI token 打日志网关 401);
  ③SuperChecker 不可修的真实样例(现行为:烧一个诊断会话后诚实停机);

- **业务/工程知识与 Skill 消费足迹(2026-08-28)**:业务模块知识与团队
  工程知识按任务固定版本，开局只把标题、摘要、适用条件和只读路径放入
  统一轻量索引，正文必须由 Agent 按需 Read；仓库扫描只发现固定目录下的
  Skill，其他仓库文件不进入平台知识通路。Cloud 记录主 Agent、子 Agent、
  开发助手和推送前验证在什么内核阶段看到了、读取或检索了哪项托管知识/
  Skill，任务详情「执行现场」可回看。这份足迹只用于发现知识缺口、低利用
  材料和高价值 Skill，不参与步骤、审批或完成裁决；索引或足迹写入失败都
  明确告警但不阻塞任务;
- **团队知识飞轮(2026-08-24)**:团队总览新增只读「团队知识效能」，把每单
  足迹按仓库、类型与路径聚合，明确区分“被提供、已加载、主动读取/检索”，
  并关联交付、修复与人工关注信号。页面给出高频知识、选而未用、使用后仍
  频繁修复、返工任务缺少知识覆盖等建议；小样本不强行下结论，相关性不
  冒充因果。聚合走独立低频接口，不扩大任务心跳，也不会自动改仓库、推进
  流程或形成新的审批门禁;
- **定位先于修改(2026-08-16,路线图 #2)**:修复使命在分诊之后、动手
  之前插一步——落到具体文件/函数并写明依据(日志哪行、堆栈哪帧、
  覆盖率报告哪个类)。**这是提示词纪律不是机器门禁**:模型糊弄着写个
  假依据系统也拦不住,真实效果要看内网首批修复轮的实际表现;
- **npm run typecheck 立起来了(2026-08-16)**:零构建(tsx 直跑)一直
  没有类型关,写错字段名静默变 undefined——实测吃过亏(task.delivery
  实为 task.summary.delivery,靠端到端断言才逮住)。全仓 61 个报错
  (全是 Response.json() 返 unknown 的老账)用 src/jsonBody.ts 的
  readJson 收敛到 0。**开着 strictNullChecks 但没全 strict**:先把门
  立起来,别让完美挡住可用;**没接进 CI/preflight**,目前靠人自觉跑;
- **内核发现收敛(2026-08-16,08-28 修正优先级)**:`MAE_FLOW_HOME >
  仓内 kernel/ 快照 > ../mae-flow 兜底`这条链原先在 serve、pilot、
  六个测试文件里各写
  一遍,测试那几份还手写 `cwd()/../mae-flow`——在 git worktree 里
  当场翻车:内核起不来、门禁拦死剧本会话,17 个用例轮询耗尽超时,
  报错却长得像业务判定错。现统一走 src/kernelDiscovery.ts,
  收编快照后"部署机 clone 下来能跑测试"才真的成立;
- **管理页服务设置已落地(2026-08-16,08-19 收口)**:模型网关与运行参数
  两张设置卡,存 `<data>/settings.json`
  (600,读坏 fail-open 回部署值),压过部署值,生效边界如实标注。密钥
  只写不读(界面/API 只见 ••••末4位)——这套掩码存储是后面 Git token
  等一切密钥的模板。运行参数直接展示服务实际默认值；模型网关只填
  地址、API Key、模型名称，不要求管理员理解 models.json。小鲁班端点
  属于部署基础设施，不在管理页配置；成员只配自己的通知 Token;
- **集成产品形态 + 界面优先配置(2026-08-17,用户拍板"cloud 应该是
  独立的集成产品"/"参数不该是启动项")**:内核快照收编进 kernel/
  (sync-kernel.sh 维护;serve 发现顺序 MAE_FLOW_HOME > kernel/ >
  ../mae-flow，需要联调活内核时显式设置环境变量)——一个 clone=
  完整产品。MR/流水线服务与验证形态由部署固定注入，管理员只在服务
  设置页看自检结果，不感知内部地址；代码仓始终由每个任务明确填写，不设服务级
  默认仓；模型网关本就在界面。正式部署用 --kernel-mode 开内核模式。
  演示判定改三态(--models > 管理页配过
  模型 > 才算演示),堵住"最小启动每次重启清空数据目录"的雷。
  **收编快照的新鲜度已经进入上线自检**:发布前跑 sync-kernel.sh；
  preflight 会核对 VENDORED 来源 SHA 与兄弟内核 HEAD，并强制用仓内
  kernel/ 跑 probe。开发测试不能再替旧部署快照“考绿”;
- **交付方式下单预选 + 月光模式(2026-08-16 拍板,08-18 按内网实战
  改口径)**:交付方式不再让 agent 来问——下单就选,**选项现读内核
  `flow/flow.json`**(完整开发/已定位问题修复/局部修改/处理评审意见);
  内核仍举卡(流程规则归内核),宿主拿预选答案自动交卷,对不上就
  fail-open 回真等人。原来这里自造过一套"快速/慢速车道",假件也照
  自造的问法写,于是用例只证明了宿主自言自语:真跑里预答永远命中
  不了,用户被重复问一遍交付方式(内网 run 实测逮住)。
  月光模式=每用户免审批开关(默认关,工作台随时切):开着时本人任务
  的卡一律代答直行(答复写明预授权+复盘要求),开启即清在等的卡,
  关掉恢复审批。代答走 decide 同一条通路,台账完整。**ASKUSER 人工闸
  本体未动**:这是用户显式预授权的代答,不是放开内核闸门;
- **统一任务容器已成为正式部署硬边界(2026-08-21)**:内核模式未配
  `--isolate-image` 会在启动期直接拒绝，不再允许普通编码、修复或推送前
  构建悄悄回落宿主。Cloud/Pi 控制面、个人 Git 凭据、clone/push、MR、
  通知留在可信宿主；主 Agent、Task 子 Agent、流水线/检视修复及独立
  prepush Agent 的所有 Bash 都进入任务容器。文件 Read/Edit/Write 仍由
  宿主执行，但受任务工作区 realpath/软链边界和 fail-closed Gate 约束。
  纯会话演示与测试仍可不配镜像，它们不属于多人生产形态;
- **多人生产加固四项(2026-08-22,容器化终审提出,已补三项半)**:
  - **实例互斥已闭合**:实例身份就是 `sha256(realpath(dataDir))`,起服
    按它清扫"本实例"的遗留容器。以前两个 serve 指同一个 `--data`,后起
    的会把先起那个**正在跑的编译/prepush 容器全杀掉**,两边还共写同一
    套 task.json。现在 dataDir 上有独占锁(`instance.lock`,pid+主机名),
    活着就拒绝启动并报出占用者 pid;进程被 kill -9 留下的陈旧锁由下一个
    实例接管(抢占走 rename+回读验明,不 unlink,避免并发抢占互删);
    跨机共享同一个 dataDir 判不了对端死活,一律拒绝而不是猜。
    真件裁判:两个 serve 真起、真 SIGTERM、真 kill -9 各验过一遍。
  - **Linux 容器 uid 已闭合**:工作区是 bind mount,容器里写出来的文件
    在宿主上就是容器 uid 的。镜像默认 builder 是 10001,和服务账号对不
    上时宿主接手 git add/commit 直接 EACCES——**炸在 Agent 干完活之后**,
    最贵的位置。现在 Linux 上不配 `--isolate-user` 就按服务进程自己的
    uid:gid 跑；服务由 root 守护时必须显式给非 root 数字 uid:gid，Cloud
    在容器启动前只修正实际挂载的代码工作区和分仓缓存属主，不把 root
    兜进容器；宿主 Write/Edit 与内核原子写状态也即时交还对应文件，不靠
    `umask 0000` 开放整个数据目录。
    macOS/Windows 保持镜像默认——那边 Docker 在 VM 边界做 uid 映射,
    套本机 uid 反而撞上 VM 里不存在的用户。**这条本机验不了真故障**
    (Colima 是 VM),判据按 platform 参数化进了单测。
  - **等人期间释放容器已闭合**:一张审批卡挂一晚上,8g 内存和 pids 名额
    就占一晚上,10~20 人共用一台机器时会把后面排队的单堵死。现在真等人
    时停容器、会话原样留着(pi 停在工具调用里),答复到达后第一条 Bash
    重新开同一套挂载/限额/label。自动交卷不做"停了再开"的无用功。
    释放属旁路只记不抛;**重开失败必须抛成这条 Bash 的执行失败,绝不
    回落宿主**。代价如实:丢 HOME 与 `/tmp` 两个 tmpfs,以及上一轮遗留
    的后台进程——后者本就活不过会话。
  - **凭据边界补了一半**:带个人令牌的 clone 与仓内 Skill 只读发现,
    以前**没走** push/ls-remote 那套加固沙箱。宿主的 credential helper
    是"问什么答什么"的(不看 git 传进来的 host),部署机 `~/.gitconfig`
    或 `/etc/gitconfig` 里一条 `url.<别处>.insteadOf` 就能把 clone 改道
    到另一台主机,**用户的个人 CodeHub 令牌跟着递过去**。现在这两条
    路径与 push 共用 `prepareHostGitSandbox`(空 HOME/全局/系统配置、
    关 ext 传输与仓库 hooks、拒交互 askpass、清 `GIT_*`)。真 git 当
    裁判,并配了负例守卫证明不加固时改道确实发生。
    **没补的那一半**:无个人令牌时仍沿用部署账号自己的 git 配置(那是
    管理员本人的配置,且没有用户令牌可泄,是有意保留);helper 本身仍
    不校验 git 请求的 host,只是现在没有配置来源能让它被改道问到。
- **上线自查里两件"以为测过其实没测"的事(2026-08-22)**:
  - `harness/restart-drill.sh`(清单第 6 项的可执行版)自建立起没动过,
    而服务后来陆续加了**管理员密码强制注入**、**登录会话**、
    **管理员不许下单(角色分离)** 三道门——脚本三处都撞上,也就是说
    "杀进程重启恢复"这一项**从来没真跑成功过**。三处已补齐(演练照真
    流程走:管理员登录 → 建开发者账号 → 开发者下单),现在真 kill -9
    真 HTTP 全绿,顺带成了实例锁陈旧接管的真件裁判。
  - `tests/isolation.test.ts` / `tests/isolationConcurrency.test.ts` 三条真
    容器用例一直因缺 `MFC_REAL_BUILD_IMAGE` 而 skip,skip 得诚实,但夹具
    早已过期:它们造的是**真实服务永远不会产生的配置**(不给 cacheRoot)。
    统一构建镜像的 entrypoint 会校验 `/cache/*` 可写,不给缓存挂载就退 73。
    夹具已按真形态补上;`src/pilot.ts` 也漏了同一个字段,同批修掉——
    否则 `npm run pilot -- --isolate-image` 一起手就是容器起不来。
    教训:**长期 skip 的用例会静默腐烂,解开时要先怀疑夹具而不是产品**。
- **测试自己在漏进程(2026-08-22 逮住,已修)**:需要真 HTTP 的用例用
  `node_modules/.bin/tsx` 起 serve,而那是个包装脚本,自己再 spawn 一个 node。
  **SIGTERM 它转发,SIGKILL 转发不了**——包装进程当场死,真正在监听端口的
  node 变孤儿活下去。`serveBrokenPipe` 收尾固定 SIGKILL,于是**每跑一次漏
  一个**。清场时本机逮到 **57 个**孤儿 serve,最老的活了 2 天 12 小时,
  合计约 3GB。已统一走 `tests/support/serveProcess.ts`(`node --import tsx`
  直起,被 kill 的就是本体);修后全量跑完 `serve.ts` 孤儿为 0。
  两个附带发现:
  - 同批还捡到一个**活了 6 天**的孤儿 test runner(某次
    `--test-name-pattern` 单测调试留下的),说明漏的不只是 serve,
    手工起的调试进程一样会留;
  - 清场那次的全量跑**在 delivery.test.ts 上挂了 8 小时没动**。
    最可能是我的清场脚本按模式匹配时把那次跑用的 serve 一起杀了,
    但**没有实锤,原因存疑**;重跑一次 363 用例 61 秒跑完、0 失败、
    0 孤儿。记在这里是因为"没查实的偶发"不该被当成已解决。
  教训:`harness/restart-drill.sh` 早就踩过同一个坑并写进注释了,测试这边
  没跟上——**一处踩坑要横向扫一遍同类调用点**,不然它换个地方接着漏。
- **三处易用性缺陷(2026-08-22 用户实际使用中提出,已修)**:
  - **执行心流"很多省略"是字面属实的**:模型说明被砍到 160 字(它解释
    "为什么这么改"通常三五百字,一刀下去只剩开场白),连续多段说明合并后
    **只留最后一条**、中间的话直接吞掉,命令段抬头是内容为零的
    "执行 N 条命令"。改为:说明保留 400 字且一条一段,命令抬头给真命令。
    抬头噪声是拿 `.pilot/e2e-container-2` 的 520 条真事件对拍出来的——
    光剥 `cd 长路径 &&` 前缀还不够,`python3 "/绝对路径/mae-flow.py" done`
    这种内核调用会让连着七八段抬头长得一模一样,现在折成 `mae-flow done`;
    `AskUserQuestion` 与 `human_decision` 同一件事记两遍,已去重。
    人自己捎的话以前**完全不进心流**,现在自成一段,看得出它落在哪两个
    动作之间。
  - **SSE 流把人往回翻的动作按死**:两个面板都无条件
    `scrollTo(scrollHeight)`,人滚上去看东西,下一条事件到达就把他拽回来
    (用户原话:"我想停在某一处看下,就给我刷到最下面了")。判据抽成
    `web/src/follow.ts` 的纯函数并有用例——离底 40px 内才跟随,否则原地
    不动只报积压条数,什么时候回到最新由人点一下决定,不搞定时自动恢复。
  - **「顺便说一句」只报"已读取"、不给下文**,于是提问永远没有答案
    (用户原话:"有时我是问了个问题…我看不到 agent 的回复")。现在附上
    你说完之后它说的话。**口径上的诚实**:字段叫 `said` 不叫 `reply`,
    文案是"你说完之后它说的"——steer 在回合间隙送达,模型可能先把手头
    那段话说完,宿主**证明不了哪一段是在答你**,只能给时间顺序。
    宿主催办的 `user_message` 不带 `via=interrupt`,不算人捎的话,有守卫用例。
- **任务级 Token 可观测(2026-08-23)**:统一采集 Pi 主 Agent、子 Agent
  与推送前验证 Agent 在 `message_end` 返回的提供方真实 `usage`。任务列表、
  交付历史展示累计 `↑输入 / ↓输出`，工作台同时展示最近 60 秒双向吞吐；
  累计值随 `task.json` 跨重启保留。网关不返回 usage 时不展示，绝不拿
  字符数或 SSE 字节数伪造精确 Token；统计写失败也不影响任务流程。
- **现场保留期落地(2026-08-22,用户拍板两周/可配置/按任务算)**:此前
  **一条回收策略都没有**——不是策略宽松,是压根没有。每个任务把整个仓克隆
  进自己的现场,只涨不消;10-20 人用下去磁盘按周算。现在终态任务过保留期
  自动回收(`--workspace-retention-days`,默认 14,`0`=永不回收,管理页可
  运行时改)。口径按用户原话定死:"**可以清除编译环境啥的,但是交付历史
  数据啥的不要清除**"——删的只有代码克隆(多仓时还有 `repositories/`)
  和 pi 会话临时目录;task.json(交付账本在里面)、事件账本、transcript
  含子 Agent 证据、prepush 各轮收据、流水线事实与日志、批注与检视意见
  全部保留,有逐项点名的用例钉死。三个刻意的设计:
  - **用"留什么"白名单而不是"删什么"黑名单**:克隆目录名是按仓库地址
    算出来的(`basename(source)` 去 `.git`),不是固定的 `origin`,多仓
    还不止一个——黑名单天生点不全名,以后新增目录还得记得回来补;
  - **只碰真终态**(completed/failed/canceled)。`await_merge`/`verifying`
    还等着人合入或等着流水线,不碰。**已知缺口**:MR 一直没人合的单会
    永远停在 `await_merge`,也就永远不回收;正常合入的单会转 completed,
    两周后照常回收。要清就手动取消(canceled 可回收);
  - **回收 = 台账封存,恢复时不再重新裁决这单**。克隆连同 `.mae-flow.json`
    一起没了,再对账必然读不到证据 → 收好口的单被翻成验证中 → tryDeliver
    真的 git push,把两周前早已合入、分支早删的老单凭空复活。这是
    "老单不被新尺子重新量"那个坑的另一种成因(尺子是我们自己弄丢的),
    用例先在没有这道闸的代码上验证为红(实测状态翻成 `failed`)。
- **仓库构建缓存也有生命周期(2026-08-28)**:它不属于某一张任务，同仓
  后续任务会继续复用，所以删除任务不立即连坐删除；但现在会登记最后使用
  时间，默认 30 天未用自动回收，并以 100GB 总量上限做 LRU 止涨。两项均
  可在管理页热改(`0` 分别表示不按时间清理/不限容量)，管理员也可一键清理
  全部未占用缓存。运行中及仍可能继续执行的任务有租约保护，统计和递归删除
  全走异步 I/O，避免缓存大时拖住 Node HTTP 事件循环。
- **prepush 的"UT 真跑了没有"只靠嘱咐,没有闸(2026-08-22 查实,用户拍板
  维持现状)**。已经硬的两条:`status=passed` 时 `unit_test=skipped` 会被
  解析层直接拒收;上报的命令必须在最后一次改动/提交之后真实成功执行过。
  **没堵的一条**:宿主只核对"上报的命令跑过没有",不核对"那条命令是不是
  在跑测试"。实测构造(`tests/` 未覆盖,是拿脚本直接喂 `verifyPrePushEvidence`
  验的):只跑一次 `mvn compile`,把 compile 与 unit_test 两栏都填
  `mvn compile`(或把 UT 栏填成 `mvn`,靠包含匹配去撞)→ **判 PASS**。
  后一种是 2026-08-22 把精确相等改成包含匹配之后放大的。
  提过用"命令里有没有 test/verify/check 标记"来拦,用户判定不加——
  那是启发式,会误伤 UT 入口不含这些词的仓。现在这条写进了 prepush 使命
  提示词(明说不许拿编译命令顶 UT 栏),**靠模型自觉,不是靠宿主拦**。
  能接受的理由仍是这道闸的定位:push 前的快速反馈与流量闸门,不冒充最终
  质量裁判;真裁判是绑提交 SHA 的流水线,UT 在那里还要再跑一遍。
- **回收把真现场删了一次(2026-08-22 我自己踩的,已修并留证)**:
  拿 `.pilot/e2e-container-2` 拷一份到临时目录验回收,结果删掉的是**原件**
  的 `origin/` 和 `pi-agent/`。成因:`summary.workspace` 是任务创建时写进
  task.json 的**绝对路径**,而 `recover()` 是按 `dataDir/task-N` 扫目录认
  任务的——现场被拷走/搬走后两者就分叉了,而删除动作照着老路径下手。
  读侧按老路径读只是读不到,**删侧按老路径删是真没了**。
  已加 fail-closed 边界闸(`withinDataDir`,realpath 比对而非字符串前缀,
  软链接绕不过去),越界一律拒绝、一个字节不删;真场景重跑已验证拦住。
  损失如实记:那次整链试跑的克隆与会话临时目录没了,**台账与证据全在**
  (events.jsonl、transcript 含子 Agent、prepush 各轮收据、pipeline-facts、
  task.json),内核阶段真相被回收流程本身留档为
  `kernel-state.reclaimed.json`(`current=end`)。该现场 task.json 的
  status 曾被我的实验脚本写成 completed,已改回真实结果 `await_merge`。
  教训:**给删除动作写用例之前,先给它写边界**——夹具永远在自己造的
  临时目录里,照不出"路径来自持久化字段"这类真形态问题。
- **整链首次真的跑通了(2026-08-22,现场 .pilot/e2e-container-2)**:内核完整
  流程 + 容器 + prepush + 交付,这四件事凑在一起以前**一次都没跑过**。这次
  用真 GLM + 真 Docker + 真 Maven 五模块仓跑完:需求澄清(模型自己问出 7 条,
  含 `+86`/座机误伤、mask 与 truncate 顺序)→ Spec/Story → 容器内编码 →
  提交 → **prepush 在独立构建容器跑真 Maven(18 tests 全绿)** → PASS 收据
  绑 SHA → 宿主 push → MR → 流水线三项绑 SHA 全绿 → `current=end` →
  `await_merge`。假件只有平台那一端。收据里带完整容器事实存根(container_id、
  image_digest、只读根、pids、user、挂载点),事后可审计。
- **prepush PASS 闸曾经"基本过不去"(2026-08-22 整链试跑逮住,已修)**:
  `verifyPrePushEvidence` 用**整条 bash 命令原文精确相等**核对证据,而使命
  要求模型上报"与实际 Bash 调用完全一致"的命令。现实里模型发的是
  `cd /很长的路径 && mvn test; echo TEST_EXIT=$?`,上报的是 `mvn test`——
  永远对不上。实测后果:模型真跑了、真绿了、还自己修好一个真编译错误
  (测试类缺 `ChannelHandler` 导入),却被判"没有真实成功执行"、任务 failed、
  不 push。**而失败措辞读起来像在指控模型作弊**,人得去翻 bash 日志才看得出
  是冤枉。已改成包含匹配(空白归一化),并把"跑过但只在改动之前"和"压根没跑"
  分成两句话。**松了多少如实说**:上报 `mvn test` 实跑 `mvn test -DskipTests`
  现在混得过去;接受它是因为这道闸的定位是 push 前的流量闸门而非最终裁判
  (真裁判是绑 SHA 的流水线),而一道永远过不去的闸比稍松的闸有害得多。
  "退出成功"和"发生在最后一次修改/提交之后"两条硬约束没动。
  **为什么以前没发现**:codex 的真模型冒烟里工作区就是 cwd,模型不需要 `cd`,
  命令原文恰好等于 `npm test`——夹具恰好绕开了唯一会踩的形态。
- **试跑器漏配 prepush(同日,同一文件第二次)**:`src/pilot.ts` 压根没写
  `prepush: { enabled: true }`(serve 里是 `host ? {...} : undefined`),
  于是首轮整链试跑**一次 mvn 都没跑过**却照样收口 `await_merge`,少了一环
  完全看不出来。判据只能落在"bash 日志里有没有 mvn 真实输出",不能看状态。
  连同早先的 `cacheRoot` 漏配,**今天四次撞上同一个模式:夹具与真形态不一致,
  测试全绿但证明不了东西**。凡是"试跑器/夹具"和 serve 不同形的地方都要当
  缺陷看。
- **并发实战演练已脚本化(2026-08-22,harness/concurrency-drill.ts)**:
  真 GLM + 真 Docker + 真 TaskService,三单并发,判据全落在宿主能自己
  核实的事实上(容器名、`docker ps` 残留、工作区产物、容器内 `uname`/
  `id -u`),不信模型自述。连跑两遍各 16/16;其中第三单被要求先举卡,
  用来真跑"审批期释放容器→代答→原地重开"(日志里能看到同名容器换了
  新 id)。并发峰值 3。
- **软链接 TOCTOU:识别了,本仓修不了(2026-08-22)**:文件工具的工作区
  边界在 `gateService.realTarget()`——它从目标往上找最近的已存在祖先做
  realpath 再拼未存在的部分,**仓内软链跳仓外是拦得住的**。残余是判完
  到宿主文件工具真正执行之间的时间窗:Agent 可以在这中间把目录换成软链。
  根治要在文件工具里用 `O_NOFOLLOW` 打开,那是 pi 的代码,不在本仓。
  当前形态下的实际风险面很窄(要精确卡这个窗口),但**它没被关掉**;
- **CodeHub 适配层骨架已就位(2026-08-16,src/platformAdapter.ts)**:
  `npm run adapter -- --config adapter.json`,进内网只填 codehubcli
  命令模板(argv 占位符+json/regex/const 抽取+状态映射表),代码零改动。
  纪律内置:未映射状态 502 拒绝猜、CLI 超时预算、非零退出带 stderr
  上浮、令牌不落日志、配置坏拒启。宿主平台请求带任务归属人身份头
  (x-mfc-git-token/user,percent 编码,只走头不走体——体进投影台账),
  适配层 {token} 优先个人、回落服务账号 → MR 发起人=本人。测试用真
  子进程假 CLI(tests/platformAdapter.test.ts 4 项 + delivery.test.ts
  身份头消费证明)。**真 codehubcli 的输出形状没见过**,命令模板、
  抽取路径、状态映射都要进场当天对着真输出填;
- **修复环升级:默认 20 轮兜底+分诊使命+诊断出口(2026-09-01 修订)**:
  repairRounds 默认 20，任务级可覆盖，0 表示关闭自动修复；收敛靠同 SHA
  不二修 + "原地打转必须
  换思路/出诊断"(第 2 轮起使命带上一轮失败对比)。修复使命=分诊台:
  列全类别(编译/告警/UT/覆盖率/CodeCheck)、按类派专职子 agent、
  一次提交收尾一次 push(每次 push 烧一条流水线)。不可修的(外部平台
  配置等)不硬改:会话收口发言当诊断,带进任务详情/loop.diagnosis/
  小鲁班停机通知(独立幂等键,主动喊人)。**"无进展即转向"是提示词
  纪律不是机器门禁**——模型持续产出无效新提交时仍会烧轮,兜底是
  20 轮预算 + 环账页面可见 + 明确停摆通知,进内网观察首批真实案例;
- **下单表单任务级可配已落地(2026-08-16,08-19 收口)**:交付代码仓必填;
  URL 带账号密码当场打回——鉴权走个人令牌;MR/流水线请求带 repo 字段
  给适配层,单仓假件忽略无害)、模型选择(数据源 /launch-options,
  清单来自当前生效 models.json,>1 个才显示下拉)、修复轮预算(0=本单
  关修复环),覆盖链=任务>设置>部署,下单即校验;都记在 task.json,
  重启续跑不漂移(tests/launchForm.test.ts 5 项 + delivery.test.ts
  任务级压部署值)。**多仓路由未在真平台验证**(假件单仓);
- **个人 Git 令牌已落地(2026-08-16)**:每用户 PAT,「我的工作」页只写
  不读;任务启动时经 credential helper 注入(先清继承的 helper 列表——
  git 对全列表广播 store,macOS 钥匙串实测存走过令牌;明文只在 0600
  文件,不进 .git/config/远端 URL);缺凭据 GIT_TERMINAL_PROMPT=0 快败
  不挂死。消费证明用真件:带 Basic 鉴权的 dumb-HTTP git 服务器
  (tests/gitToken.test.ts,3 项)。commit 署名(平台用户名/邮箱)随凭据
  写进克隆的 user.name/user.email——令牌管推送鉴权,commit 归属认的
  是 email,两码事都落了。**push 侧未在真平台验证**(dumb 协议只读),
  进内网首跑要看三个都是本人:推送身份、commit 归属头像、MR 发起人;
  CodeHub token 是否同时当 push 凭据也要实测(类比 GitHub PAT 是同
  一个;若平台分俩,令牌表单加一格即可,机制不变);
- **push 前容器编译+UT 已接回(2026-08-21)**:普通编码会话保持轻量，不
  编译、不持有推送凭据；宿主在每个新 HEAD push 前启动独立 Cloud-native
  Agent，在一次性加固构建容器中执行仓库真实编译与 UT，并可自动修复、
  commit。普通编码容器会先确认销毁，再启动 prepush attempt，二者不会
  同时写同一工作区；暂停/取消会销毁整个容器进程树，恢复使用新 attempt。
  该会话刻意不挂 Mae-Flow Hooks，避免把快速修复重新塞进内核阶段门禁。
  它不跑 CodeCheck，也不替代最终流水线和 `external_verify`；本地 PASS
  收据只对最终 SHA + clean worktree 有效，同 SHA 的网络 push 重试可复用，
  并记录实际镜像 digest、容器资源/网络/只读根和挂载目的地供审计。
  命令发现顺序固定为**仓库真实构建配置与脚本 > 相关 Skill 的辅助说明 >
  内网默认经验**；Skill 由 Agent 按任务相关性自行决定是否读取，不能覆盖
  安全边界，也不把“Java/JS/C++”直接硬编码成某条命令。当前内网首批三类业务
  仓均以 Maven 为主要入口，统一构建镜像基线为 JDK 21；Java 分开跑 compile、
  test 和必要的定向 test，JS 按需准备 `website` 依赖但不无脑 clean，C++
  保留仓库声明的 DT 参数并优先增量、定向编译/测试/覆盖。具体 profile、
  模块与私服参数只能从本仓材料取得，不能凭经验臆造。缺工具、私服/证书/
  网络/权限失败归环境故障；不得靠关闭 SSL、写全局配置或输出 token 造绿灯;
- **业务仓 Skill 可按单选择(2026-08-21)**:下单页在仓库/基线之后显式
  读取 `.agents/skills`、`.pi/skills`、`.claude/skills`、`.cac/skills` 的标准
  `SKILL.md`，多仓按仓分组，默认不选。服务端令牌校验后只把选中的精确
  文件以只读快照交给 Pi；Pi 根据 description 自主判断何时读取，未选项
  完全不可见，Skill 不增加权限、不成为内核门禁或质量通过证据;
- **CodeCheck 云端不做本地扫描(2026-08-16,用户拍板"lightcheck 保留,
  codecheck 依赖流水线")**:CodeCheck 是内网 npm 件,云端装不上,原来
  每次扫描空撞安装(30 分钟冷却)+ TOOL_ERROR 噪声(task-1 实锤)。
  内核在 cloud 宿主下 codecheck-scan 如实记 PIPELINE 状态、
  review_codecheck 放行并注明"交由流水线核对";lightcheck 照常。
  **内网部署前须确认流水线含静态检查 stage**,否则这块无人兜底;
- **云端放开了子 Agent 台账门禁(2026-08-15,用户拍板)**:pi 宿主取不到
  内核格式的子会话执行台账,UT/COMPILE/REVIEWER/STORY/GRILL 的生命周期
  证据在 `MAE_FLOW_HOST=cloud` 下不再拦 done,CodeCheck 修复轮的"合法
  令牌"同族放开(内核 `host_env.worker_agent_ledger_gates`,测试
  `test_cloud_worker_ledger.py`)。**这意味着"某个子 Agent 真跑过"在云端
  没有机器证明**;Cloud 不再以本地命令令牌或模型报告代替质量结果，机器
  把关只认订单里的执行契约与交付点绑定 SHA 的流水线事实。ASKUSER 人工闸
  不放开;本地 CLI 行为一字不变;
- **完整交付链已在真模型上全程走通(2026-08-14 run7,GLM@bigmodel,
  fieldtest-java,容器隔离)**:需求→Grill→Spec→Story→编码→质量链→
  交付检视→push→MR→流水线,内核 current=end,任务收口 await_merge,
  MR 与流水线结果绑 SHA,远端分支 4 个规范提交(含 verify_ut 逮住
  的正则宽度回归的修复);全程 5 次断点续跑接力(超时/环境事故
  各断各续,进度零丢失),现场 .pilot/archive/ 归档;交付判定三条
  路+异步收敛仍由 delivery.test.ts 假件长期看护;
- 现场归档在 .pilot/archive/run3-REQ2026081402-glm-delivery
  (含两张"证据缺口风险卡"——并行派发丢返回登记的实锤,已修:
  pretooluse 随带 tool_use_id,见 tests/kernelHost.test.ts);
- **统一构建镜像现在是部署前置**:宿主只需 Docker；目标仓声明的
  JS/Java/C++ 编译与 UT 命令统一在 `deploy/build-image/` 生成的非 root
  镜像中执行（Node/npm、JDK 21/Maven、GCC/G++/binutils/bison/flex、
  ccache、CMake/Ninja、Git、Python）。
  当前内网业务仓的落地基线是 JDK 21，且 Java/JS/C++ 均由 Maven 作为
  主要编排入口；这只是部署工具链经验，不覆盖仓库脚本与 Skill 的明确说明。
  缓存按仓库哈希隔离挂载，内部 Maven/npm 镜像与 CA 由部署只读注入；
  缺工具、镜像、权限或依赖会明确标为环境故障并停止 push，不回退宿主;
- **预推送先验环境检查**:专项 Agent 启动前，Cloud 会按当前仓识别结果
  本地核对 passwd HOME、Maven 实际 JDK 21、JVM cacerts、显式 settings、
  构建缓存和 C++ 同级 SDK/父子拓扑。失败直接落为 environment_error，
  不消耗模型去 curl 盲找仓库；Host Git 的可执行 helper 已移到数据目录下
  0700 私有运行区，因此宿主 `/tmp` 可保持 noexec;
- 任务级恢复已实现(tests/recovery.test.ts):进程可死任务不死——
  重启后 recover() 重建索引,决定走重建会话续跑;pi 侧会话仍是
  inMemory,重建会话不带旧对话上下文,以内核 current 为锚(设计如此);
- x86_64 Linux 构建容器的历史实验同样曾验证通过(2026-08-14)，仅保留
  为迁移记录，不作为内网部署前置或 Cloud 质量证据;
- PostgreSQL 投影已接线(projection.ts + serve --pg,主 spec §11):
  摘要/事件副本/外部动作台账三张表,恢复时以现场文件为源重放;
  纯旁路 fail-open——阶段真相仍只在工作区 .mae-flow.json,
  语义测试 tests/projection.test.ts(临时真 PG 集群当裁判);
- 任务容器隔离已落地(docs/container-isolation-design.md):
  `--isolate-image <镜像>` 后所有任务 bash 命令进任务专属容器执行,
  文件工具/门禁/内核 dispatch 留宿主,工作区同路径挂载三方同视;
  默认只读根、cap-drop ALL、no-new-privileges、PID/CPU/内存限制、HOME 与
  `/tmp` tmpfs、精确 safe.directory、环境变量白名单；镜像/Daemon/inspect/
  清理任一失败均 fail-closed。CodeCheck 仍只在权威流水线执行。
  **内网侧一步都还没走**——欠什么、按什么顺序补、周一先做哪一件,
  见 docs/intranet-container-rollout.md;
- 正式 React 前端已起头并接上部署形态(web/:Vite+React+TS,
  类型化 API 层,功能与演示页对齐——列表/发起/审批卡/SSE 过程
  记录/现场面板链接;`web/dist` 存在时 serve 自动托管,--web 可
  显式指定,没构建时零构建演示页兜底;穿越防护有测试)。
