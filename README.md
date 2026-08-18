# mae-flow-cloud

Mae-Flow 云端服务:Pi(pi-mono coding agent)**进程内**集成 + Mae-Flow 内核宿主适配。

设计文档在内核仓:
- [云端 MVP 设计](../mae-flow/docs/superpowers/specs/2026-08-14-mae-flow-cloud-mvp-design.md)
- [宿主适配层详设](../mae-flow/docs/superpowers/specs/2026-08-14-cloud-host-adapter-design.md)

## 三条铁的边界

1. **内核唯一权威**。流程规则、门禁契约、证据判定只在
   [mae-flow](../mae-flow) 内核仓(Python)。本仓不复刻一行判定逻辑:
   TS 写现场,`harness/verify_transcript.py` 用内核契约裁决。
   内核定位:`MAE_FLOW_HOME` 环境变量,缺省 `../mae-flow`。
2. **transcript JSONL 是语言中立契约**。TS 写出的每个字节必须被内核
   `parse_transcript` 与四个质量契约原样认出——这是跨语言接缝,
   也是"证据链换输入源而格式零漂移"的落点。
3. **语言按亲和选**(用户拍板):Pi 是 TypeScript,SDK 支持进程内嵌入,
   服务层用 TS——`tool_call` 钩子即同步拦截,自定义工具的未 resolve
   Promise 即人工节点挂起,子 Agent 是同进程再开一个 AgentSession。
   Python 版曾走「pi --mode rpc 子进程 + HTTP 环回桥」路线并全链验证过
   (内核仓历史 2add07b),进程内形态让那两层整体消失。

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

本机挂了代理(Clash 等)时,curl 环回接口记得 `--noproxy '*'`;
服务进程自身已强制环回直连,浏览器访问不受影响。

## 接真模型(GLM-5.1)

把任务 agent 目录的 `models.json` 里 `maeflow` provider 的 `baseUrl`
换成真网关(OpenAI/Anthropic 兼容任一),剧本假模型退场,其余零改动。
注意:环回地址永远直连(`sessionDriver.ensureLoopbackDirect`),
内网代理会把 127.0.0.1 的请求劫走(实测 502)。

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

## 内网能力模拟件(用户原则:外部完全就绪才碰内网)

| 内网能力 | 模拟件 | 真件就绪时 |
|---|---|---|
| GLM-5.1 网关 | scriptedModel(剧本)/ bigmodel 浅探 | 换 models.json baseUrl |
| 小鲁班通知 | notifier.FakeLubanServer | 换 endpoint 与鉴权 |
| Git 服务端(MR) | gitPlatform.FakeGitPlatform(裸仓+HTTP) | 换 baseUrl 与鉴权 |
| 权威流水线 | 同上(trigger/status,结果绑 SHA) | 换 baseUrl 与 Job 配置 |

语义(投递失败不改流程、MR 幂等、旧绿灯不背书新代码、验证中→等待合入)
是真假件共同的契约,写在各自测试里。

## 已知边界(诚实清单)

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
  且留痕、收口抛异常时任务 failed 写明原因;**假件裁不了的**:内网那台
  机器上到底是哪条旁路先抛的——要等更新后的 `crash.log` 回来才知道。

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

- **流水线证据口第一期(2026-08-17)**:云端"编译/UT 推迟给流水线"的
  承诺有了兑现侧——流水线终态时宿主把平台事实(sha/status/来源)喂给
  内核 `pipeline record`,内核绑工作区 HEAD 裁决(PASS/RED/STALE,
  旧绿灯不背书新代码)写进 `.mae-flow.json` 的 `quality.pipeline`,
  任务侧 `delivery.attested` 是镜像戳;内核调不动记"未裁决"留痕不拦
  收口。**边界**:第一期是物证不是门禁(登记不推动流程步骤);裁决
  只证"流水线成功且绑本 SHA",**不证流水线里跑了哪些 job**——流水线
  含编译/UT/CodeCheck stage 仍是部署时的人工确认项(上线自查第 0 条);
  三个 deferred 内存标记与证据口的逐项核销(待核销清单)是第二期。

- **MR 闭环升级(2026-08-17,对照内网既有框架,docs/mr-loop-adaptation.md)**:
  失败先分类再派单——九项合并门禁进契约(`GET /mr/gates`,可选端点,
  平台不支持=旧语义一字不变),检视>冲突>CI 只派最高优先级一路;
  重试只数 CI(检视/冲突触发清零);检视闭环(拉讨论→专职会话逐条
  回复→宿主发布并标已解决);冲突修复(宿主 merge 造真实冲突标记,
  agent 在真冲突上解);等人门禁(审批/投票/WIP)挂起等待不空转,
  说清卡在哪并通知归属人;MR merged=完成、closed=失败请人工;失败
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

- **仓库地图进开场白(2026-08-16,路线图 #4)**:内核模式下每次会话
  启动现画一张按引用扇入排序的文件+符号地图(src/repoMap.ts),垫在
  环境事实之后、修复使命之前——大仓里模型不必全仓乱 grep 找入口。
  零依赖正则近似(不引 tree-sitter:原生构建在内网 WSL 是负担),
  三道预算帽(1500 文件/200KB 单文件/3 秒)+ 输出 12000 字符帽,
  超了在地图尾部明说截断;任何一步炸了返回空地图,任务照跑
  (地图是加餐不是主食)。**已在内核仓(500 文件,Python 为主)真跑过**
  并因此改了三处:通用词按文档频率剔除、测试文件降权 0.3、Java 方法
  正则的 `[^;]*` 跨行 bug(原来一个类只抽得出第一个方法)。1.4 秒出图,
  前排是真入口。**仍未在内网巨型 Java 仓上量过**:几万文件时 3 秒
  预算够不够、Java 正则的漏/误报率、地图对真实修复轮次的影响,
  都要进场后看;
- **知识块按触发词注入(2026-08-16,路线图 #4 另一半)**:交付仓的
  `.mae-flow/knowledge/*.md` 带 triggers,命中才进开场白(无 triggers=
  常驻);匹配语料=需求原文+本轮流水线失败详情,红灯日志里的关键词
  会召唤出对应那条规矩。知识在仓不在平台——平台不做知识库、不做配置
  面,换个仓就是换套知识。端到端实锤在 delivery.test.ts(命中的进、
  没命中的不进)。**没有真实团队知识喂过**:触发词该多细、常驻块会不会
  被写成大杂烩,要进场用起来才知道;
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
- **内核发现收敛(2026-08-16)**:`MAE_FLOW_HOME > ../mae-flow 活内核
  > 仓内 kernel/ 快照`这条链原先在 serve、pilot、六个测试文件里各写
  一遍,测试那几份还手写 `cwd()/../mae-flow`——在 git worktree 里
  当场翻车:内核起不来、门禁拦死剧本会话,17 个用例轮询耗尽超时,
  报错却长得像业务判定错。现统一走 src/kernelDiscovery.ts,
  收编快照后"部署机 clone 下来能跑测试"才真的成立;
- **管理页运行时设置已落地(2026-08-16)**:运行参数(并发/修复轮/轮询)、
  通知端点与鉴权头(带测试按钮)、模型网关三张卡,存 `<data>/settings.json`
  (600,读坏 fail-open 回部署值),压过部署值,生效边界如实标注。密钥
  只写不读(界面/API 只见 ••••末4位)——这套掩码存储是后面 Git token
  等一切密钥的模板。后端契约与消费点已测(tests/settings.test.ts 7 项 +
  delivery.test.ts 设置压部署值),serve 真入口 curl 冒烟已过(掩码/
  测试按钮如实报错/校验 400/文件 600);**前端页面只过了构建与类型
  检查,没在浏览器里点过**,进内网前应人工过一遍三张卡;
- **集成产品形态 + 界面优先配置(2026-08-17,用户拍板"cloud 应该是
  独立的集成产品"/"参数不该是启动项")**:内核快照收编进 kernel/
  (sync-kernel.sh 维护;serve 发现顺序 MAE_FLOW_HOME > ../mae-flow >
  kernel/,开发机永远用活内核,快照只在部署形态生效)——一个 clone=
  完整产品。启动项收缩到 --data/--port+管理员密码:平台地址、默认
  交付仓、免编译开关进管理页「交付与形态」卡热改(生效于下一次交付
  动作/新会话);模型网关本就在界面。仅存的重启点:从无到有开内核
  模式(boot 时读设置判定)。演示判定改三态(--models > 管理页配过
  模型 > 才算演示),堵住"最小启动每次重启清空数据目录"的雷。
  **收编快照的新鲜度靠纪律**:发布前跑 sync-kernel.sh,忘了就是旧
  内核上线——VENDORED 文件记着来源 SHA 供对账;
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
- **不隔离部署的边界(2026-08-16,WSL 单人实战为显式选择)**:不配
  `--isolate-image` 时任务 bash 直接跑在宿主——这是诚实形态不是降级
  (红线管的是"配了容器起不来必须 failed")。三个真实差异:agent 与
  服务同用户,auth.json(全体用户的 Git 令牌明文)/settings.json/
  adapter.json 理论上对它可读;工作区是约定不是物理墙,越界写没有
  强制拦截;无资源上限。免编译形态收窄了风险面(本机不跑构建,agent
  正当活动只有工作区读写+git),单人自用+单任务+人盯着可接受;
  **多人共用的正式部署前容器隔离必须升回必选**——那时 auth.json 里
  躺着全组人的令牌,"agent 可读密钥文件"不再是尾部风险;
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
- **修复环升级:默认不限轮+分诊使命+诊断出口(2026-08-16,用户拍板
  "不该有最大轮数限制"+"一次修全再提交")**:repairRounds 从默认 2 降级
  为可配手刹(不配=修到绿为止);收敛靠同 SHA 不二修 + "原地打转必须
  换思路/出诊断"(第 2 轮起使命带上一轮失败对比)。修复使命=分诊台:
  列全类别(编译/告警/UT/覆盖率/CodeCheck)、按类派专职子 agent、
  一次提交收尾一次 push(每次 push 烧一条流水线)。不可修的(外部平台
  配置等)不硬改:会话收口发言当诊断,带进任务详情/loop.diagnosis/
  小鲁班停机通知(独立幂等键,主动喊人)。**"无进展即转向"是提示词
  纪律不是机器门禁**——模型持续产出无效新提交时仍会烧轮,兜底是
  手刹可配 + 环账页面可见 + 资源侧外部限额,进内网观察首批真实案例;
- **下单表单任务级可配已落地(2026-08-16)**:交付代码仓(留空=部署仓;
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
- **免编译形态可选(2026-08-15,用户拍板"先不编译了,直接上流水线")**:
  serve 加 `--verify-via-pipeline` 后本机不做编译/UT,每次会话开场注入
  环境事实,流水线是唯一裁判,红灯走修复环;慢的代价由机器扛,不占人的
  时间。代价要如实:错误发现得更晚,一轮往返=一次流水线+一次修复会话;
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
  没有机器证明**;机器把关依赖的是:UTRUN 一类命令令牌(Bash 钩子仍在)、
  CodeCheck 重扫零信任自述、以及交付点流水线结果绑 SHA。ASKUSER 人工闸
  不放开;本地 CLI 行为一字不变。流水线证据口(内核读平台 API)尚未建成,
  建成前 verify_ut 的"真跑过"只有工作区实物(surefire 报告)可查;
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
- **本机已无 JDK/mvn(2026-08-14 run7 实测:which mvn 不存在,
  java 仅剩 macOS 空壳 stub)——早前"本机直接编译已过"的记录失效**,
  宿主直接编译不可用,编译一律走容器;Linux 容器内验证已过
  (2026-08-14,Colima arm64 + maven:3.8-eclipse-temurin-8,
  compile/test 退出码 0、4 UT 全过);x86_64 形态见下条;
- 任务级恢复已实现(tests/recovery.test.ts):进程可死任务不死——
  重启后 recover() 重建索引,决定走重建会话续跑;pi 侧会话仍是
  inMemory,重建会话不带旧对话上下文,以内核 current 为锚(设计如此);
- x86_64 Linux 容器验证同样已过(2026-08-14,Colima --arch x86_64
  QEMU 模拟,同镜像 compile/test 退出码 0、4 UT 全过);内网目标
  镜像里仍需按部署手册做最终重验;部署准备件见 docs/deploy-intranet.md;
- PostgreSQL 投影已接线(projection.ts + serve --pg,主 spec §11):
  摘要/事件副本/外部动作台账三张表,恢复时以现场文件为源重放;
  纯旁路 fail-open——阶段真相仍只在工作区 .mae-flow.json,
  语义测试 tests/projection.test.ts(临时真 PG 集群当裁判);
- 任务容器隔离已落地(docs/container-isolation-design.md):
  `--isolate-image <镜像>` 后 bash 命令进任务专属容器执行,
  文件工具/门禁/内核 dispatch 留宿主,工作区同路径挂载三方同视;
  容器起不来任务如实 failed 不静默降级;隔离证据有测试
  (宿主 Darwin、容器内 uname=Linux);资源限额/uid 映射待做;
- 正式 React 前端已起头并接上部署形态(web/:Vite+React+TS,
  类型化 API 层,功能与演示页对齐——列表/发起/审批卡/SSE 过程
  记录/现场面板链接;`web/dist` 存在时 serve 自动托管,--web 可
  显式指定,没构建时零构建演示页兜底;穿越防护有测试)。
