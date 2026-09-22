# 问题流审计日志规格(图 402 产出,#406 收口)

问题处理流程(issueFlow 宿主 + 适配层调用侧)的可机读审计账面。目的:任何一次生产故障,服务器上的 Agent 拿到 issue id 后**仅凭读文件**快速、全面、精准还原"平台/AI/外部系统各自做了什么、为什么没做"。验收标准 = [诊断场景清单](https://github.com/yunine9/mae-flow-cloud/issues/404) 的 8 个场景(research/diagnosis-scenarios 分支)全部可按本规格路径定位。消费侧(服务器 Agent)已存在,本规格只造审计能力,不做查询入口(2026-09-22 拍板)。

三份调研供料:[业界实践](https://github.com/yunine9/mae-flow-cloud/issues/403)、[事故考古](https://github.com/yunine9/mae-flow-cloud/issues/404)、[账面盘点](https://github.com/yunine9/mae-flow-cloud/issues/405)。关键取舍的 why 见 ADR-0053。

## 1. 总则(每行审计账的硬约束)

1. **格式**:JSON lines。每行必带 `msg`(一句人话)与 `kind`(稳定事件标识,代码协议,命名 `<域>.<动作>`)。
2. **双时间**:`ts`(事实发生,RFC 3339 UTC 毫秒)与 `written_at`(落账);平时相等,补记才分叉。
3. **级别**:`debug|info|warn|error` 五级语义:WARN=系统已自愈的异常,ERROR=需人/后续动作关注。级别只表严重度;**审计是另一个轴**——事实记 `info`,不因"重要"升级级别。
4. **关联 id**(join 键,见 §3):`issue_id`/`turn_id`/`request_id` 每行必带(进程级账可缺 issue_id);跨进程调用带 `parent_request_id`。
5. **代码位置**:不逐行记文件:行号;用稳定模块标识(`module` 字段,如 `issueFlow.pipeline`)。仅 `error` 级行可附 `at`(调用点)或 `stack`。
6. **审计最小字段集**(事实类行):`actor`(谁:平台/AI/责任人/检视人/外部系统)、`action`、`target`、`result`(`ok|failed|skipped|pending`)+ 缺席动作的原因字段 `reason`。**"平台为什么没做某事"的决策留痕与事实留痕同等重要**(考古结论):凡守卫、判定分支、预算耗尽、去重跳过,都发一条 `kind=decision` 的行,带 `decision` 与 `why`。
7. **明文边界**(2026-09-22 拍板:脱敏让位定位):密钥默认掩码(adapter redact 同源);定位需要时字段可明文;对话正文不复制进审计账——记"发生了什么+关联 id",正文在 transcript.jsonl 原地可查。
8. **fail-open**:审计落账失败不拖垮主流程(记 stderr 降级);翻转见 §5。

## 2. 账面清单(P1,场景全覆盖最小集)

### 会话级账(`<dataDir>/issues/<id>/audit/`)

| 账 | kind 前缀 | 记什么 | 覆盖场景 |
|---|---|---|---|
| `delivery.jsonl` **投递账** | `delivery.notify` / `delivery.turn` | 平台递给 AI 的每一样东西:通知锚点名(notice key)、注入消息摘要(≤200 字)、投递去向(当回合/停靠随行/作废)及判定分支;回合收口时 AI 实际收到的清单。回答"平台为什么没让 AI 做某事"(#383 死通知、#350 停靠、#368 未达) | 1①、3、4 |
| `decisions.jsonl` **决策账** | `decision.<域>` | 守卫与判定分支:监看 settle 分支(为何不唤醒)、双预算耗尽(原因码)、预热收据守卫拦截、外推/检查目标切换、去重跳过、SHA 漂移作废。回答"平台为什么没做某事" | 5、6、7、8 |
| `dispatch.jsonl` **对外副作用账** | `dispatch.<目标>` | 平台对外部系统的每次发送意图与终局:信箱条目装箱(带 discussion_id、mr iid、expected_sha)、每次发送尝试、终局(delivered/failed+last_error)。发送事实已在 outbox 的,此处记同 id 流水,两账按条目 id join | 1② |

### 进程级账(`<dataDir>/logs/`)

| 账 | kind 前缀 | 记什么 |
|---|---|---|
| `host-calls.jsonl` **调用账** | `call.<端点>` | 宿主→适配层每次 HTTP 调用:端点、参数摘要(repo/mr/discussion_id)、`request_id`+`parent_request_id`、结果、耗时 ms、错误原文(含 CLI stderr)。#383②③ 的直接解药——401 可按端点聚合,两侧日志可对上同一动作 |
| `canonical.jsonl` **回合汇总账** | `canonical.turn` / `canonical.issue` | 每回合收口必发一条聚合汇总行(成败都发,begin/ensure 保证):回合号、阶段、工具调用数、关键产物、终态。Agent 考古第一入口——先读 canonical 再按关联 id 下钻 |

### P2(不挡 P1 收口,另票)

存量 121 处 `this.log` 自由文本按重要度分批迁结构化(journald 兜底不动);fetch-logs 抓取结果账;适配层进程日志内部格式(只按 §5 立翻转纪律,不重写)。

## 3. 关联 id

- `issue_id`:会话 id,天然 correlation id,会话级账每行必带;
- `turn_id`:回合 id(平台侧生成,回合开始时定),回合内各行共享;
- `request_id`:单次动作 id(新动作即生成,如一次调用、一次投递尝试);信箱条目沿用既有 `mrr-*` id 兼作 request_id,不另造;
- `parent_request_id`:跨进程指向——宿主调适配层时经 HTTP 头 `x-mfc-request-id` 透传,适配层账记宿主侧的 request_id 为父。语义对齐 W3C traceparent,将来升级只加头不改账面。

## 4. 文件布局契约(账面地图,Agent 读取入口)

```
<dataDir>/issues/<issue_id>/     ← Agent 拿 issue id 即达
├── audit/
│   ├── delivery.jsonl           ← 平台→AI 投递(通知/回合)
│   ├── decisions.jsonl          ← 平台判定分支与守卫留痕
│   └── dispatch.jsonl           ← 平台→外部系统发送流水
├── events.jsonl                 ← 用户可见协作账(ADR-0018,不动)
├── transcript.jsonl             ← AI 对话转写(正文在这里)
├── mr-review-outbox.json        ← 信箱终态(与 dispatch.jsonl 同 id join)
└── …(既有账全部原位保留)
<dataDir>/logs/
├── host-calls.jsonl             ← 宿主→适配层调用(带 issue_id 可回查)
└── canonical.jsonl              ← 回合/会话汇总(考古第一入口)
```

读法约定:先 `canonical.jsonl` 找到出事的回合与关联 id → 按 issue_id 进会话目录读 `audit/` 三账 → 需要正文进 transcript,需要终态进 outbox/state,需要适配层细节按 `request_id` grep `host-calls.jsonl`。

## 5. 翻转与留存

- 大小+时间双触发(默认 50MB 或 1 天),`host-calls`/`canonical` 按 `<名>.jsonl-<时间戳>.gz` 滚动压缩;最近档明文、旧档压缩、**只压缩不删除**(审计属过程记录);
- 会话级 audit/ 账随会话现场走既有清扫纪律(与 transcript 同命,不单独清理);
- 落账失败 fail-open:记 stderr 降级,不重试不阻塞主流程;
- 适配层进程日志(adapter.log):部署文档补翻转约定(logrotate 大小+时间双触发、delaycompress),内部格式不重写。

## 6. 分期与验收

- **P1(票 #407 宿主侧 / #408 适配层调用侧)**:上表 P1 三+二本账 + 关联 id 透传。验收:8 个诊断场景逐条对照,每个场景写出"读哪几行账、几步定位"的演练记录;
- **P2(另票)**:存量 this.log 迁移、fetch-logs 结果账、适配层进程日志纪律落地;
- CONTEXT.md 词条:审计账、投递账、canonical 行、关联 id(随本规格落)。
