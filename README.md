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

- 完整需求路径(Grill/Spec/Story/编码/质量链)未在真模型上走过——
  剧本假模型只能验证管道,阶段 1 收口要接 GLM-5.1 在 fieldtest-java
  跑一单真需求;流程实际只推进到 config_confirm,后续步骤云端没跑过;
- fieldtest-java 直接编译验证已过(2026-08-14 本机 macOS:干净副本
  mvn compile / mvn test / 双副本并发 clean compile 全部退出码 0,
  仓库可标 direct);Linux 容器内同套验证仍待做(试点服务器形态);
- pi 会话恢复走 `SessionManager.inMemory()`,任务级恢复(§11)靠
  事件日志与 Git 锚点,pi 侧持久化会话未启用;
- Web/API/编排/PostgreSQL 投影(阶段 1+)未动。
