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

- **管理页运行时设置已落地(2026-08-16)**:运行参数(并发/修复轮/轮询)、
  通知端点与鉴权头(带测试按钮)、模型网关三张卡,存 `<data>/settings.json`
  (600,读坏 fail-open 回部署值),压过部署值,生效边界如实标注。密钥
  只写不读(界面/API 只见 ••••末4位)——这套掩码存储是后面 Git token
  等一切密钥的模板。后端契约与消费点已测(tests/settings.test.ts 7 项 +
  delivery.test.ts 设置压部署值),serve 真入口 curl 冒烟已过(掩码/
  测试按钮如实报错/校验 400/文件 600);**前端页面只过了构建与类型
  检查,没在浏览器里点过**,进内网前应人工过一遍三张卡;
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
