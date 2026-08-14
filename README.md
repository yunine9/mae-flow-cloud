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
  scriptedModel.ts    剧本假模型(Anthropic Messages SSE)——无 LLM 对拍电源
  probe.ts            阶段 0 演练入口
harness/
  verify_transcript.py  内核裁判:唯一权威的证据判定
tests/
  core.test.ts        不变式单测(整链行为由 probe + 裁判验收)
```

## 跑起来

```bash
npm install
npm test          # 不变式单测
npm run probe     # 整链演练:进程内 pi + 剧本假模型,内核裁判验收九项事实
```

probe 现场留档在 `.probe/`(transcript/events/waiting/子 Agent transcript),
每个文件都能直接打开看。

## 接真模型(GLM-5.1)

把任务 agent 目录的 `models.json` 里 `maeflow` provider 的 `baseUrl`
换成真网关(OpenAI/Anthropic 兼容任一),剧本假模型退场,其余零改动。
注意:环回地址永远直连(`sessionDriver.ensureLoopbackDirect`),
内网代理会把 127.0.0.1 的请求劫走(实测 502)。

## 已知边界(诚实清单)

- gate 深层契约(gate-edit/gate-bash 证据链)只留了端口,接线形态是
  调用容器内内核 CLI,未实现;
- pi 会话恢复走 `SessionManager.inMemory()`,任务级恢复(§11)靠
  事件日志与 Git 锚点,pi 侧持久化会话未启用;
- Web/API/编排/PostgreSQL 投影(阶段 1+)未动。
