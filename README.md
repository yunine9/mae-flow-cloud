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

probe 现场留档在 `.probe/`,serve 的任务现场在 `.tasks/<task-id>/`
(transcript/events/waiting/子 Agent transcript),每个文件都能直接打开看。

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

- 完整需求路径已在真模型上走通(2026-08-14 run3,GLM@bigmodel,
  fieldtest-java):startup→Grill→Spec→Story→编码→质量链→领域归档,
  12 张审批卡全程代答,收口于 delivery_review(模型提前收嘴,催办
  机制由此加入);push→MR→流水线段真模型未走过(run6/run7 在更长
  预算下推进中),交付判定由 delivery.test.ts 假件覆盖:三条路
  (已推+绿/红/未推)+ 异步流水线收敛(running→轮询带预算收敛,
  重启续轮,预算耗尽留痕请人工不卡死);
- 现场归档在 .pilot/archive/run3-REQ2026081402-glm-delivery
  (含两张"证据缺口风险卡"——并行派发丢返回登记的实锤,已修:
  pretooluse 随带 tool_use_id,见 tests/kernelHost.test.ts);
- fieldtest-java 直接编译验证已过(2026-08-14 本机 macOS:干净副本
  mvn compile / mvn test / 双副本并发 clean compile 全部退出码 0,
  仓库可标 direct);Linux 容器内同套验证已过(2026-08-14,Colima
  arm64 Linux + maven:3.8-eclipse-temurin-8,compile/test 退出码 0、
  4 UT 全过);x86_64 形态见下条;
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
