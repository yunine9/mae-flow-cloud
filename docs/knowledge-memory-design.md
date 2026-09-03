# 任务记忆(语料库)设计稿

状态:讨论稿,未拍板。2026-09-03 与用户多轮对齐后的结论整理,配套实测见
`docs/memsearch-deploy.md`(内网环境 memsearch 0.4.19 部署与四个数)。

## 0. 一句话

**平台不建知识库,平台有记忆。** 知识在仓和团队 Skill 货架里;平台只记住
自己干过的活,让下一单少踩一遍坑。

## 1. 定位与边界

| | 系统的知识 | 记忆(本稿) |
|---|---|---|
| 从哪来 | 人写的:docs、AGENTS.md、Skill | 干活的副产品:闭环的批注、修复、决定 |
| 谁拥有 | 有作者、负责人、版本 | 没有作者,任务过程自动留下 |
| 住在哪 | 仓里、团队 Skill 货架 | 部署数据目录,索引可随时重建 |
| 谁维护 | 人整编、上下架 | 没人维护,只增不改,久了自然沉底 |
| 给谁用 | 人和 Agent | 只给 Agent,在下一单干活时用 |

**刻意不做**(守住"不是知识平台"):

- 不做语料的编辑页、管理页,人不"维护记忆"。
- 不做面向人的检索门户,检索只给 Agent。
- 不做分类体系,位置(仓/路径/模块/阶段)就是分类。
- 不做向量库以外的第二真相源:语料以 Markdown 文件为正本,向量索引只是
  索引,删了能从文件重建(实测 ✅)。
- 记忆里反复出现、值得成为正式知识的,走提案进团队 Skill 货架(另案:
  知识归一,"所有资产都是 Skill")。平台没有第二个知识源。

## 2. 两条流

- **需求流**只做两件事:消费知识、产生语料。过程中零知识负担:没有
  "沉淀"按钮、没有收口问卷、没有"这条是规矩"标记。闭环即入库,人无感。
- **知识流**是另一个工作面(Skill 货架 + 修订收件箱),有自己的人和节奏,
  与任何一单进度无关。本稿不展开。

两条流之间只有两个只读接口:语料库(需求流写、Agent 读)、货架(知识流
写、需求流读)。

## 3. 语料记录契约

一条记录 = 一个 Markdown 文件(memsearch 是 markdown-native,按文件与
标题切块;frontmatter 进元数据)。字段定死:

```markdown
---
id: c-000412
source: annotation            # 见 §4 来源表
judged_by: human              # human | pipeline | agent
repo: notify-service
paths: [src/main/java/com/x/filter/FilterEngine.java]
module: 通知
phase: 写代码                  # 内核七段词表之一;来源决定,不猜
task: task-38
evidence: annotation:a-91     # 可回溯到现场的指针
at: 2026-09-01
---
# 改 FilterEngine 的过滤顺序时

## 问题
黑名单判断放在了渠道开关之后,被关掉的渠道也会跑黑名单。

## 解决
黑名单判断必须在渠道开关之前(diff 见 task-38 批注 a-91 的回应)。
```

- 正文三段固定:标题 = `trigger`(什么情况下),`问题`,`解决`。
- 五个问题每条都回答:什么情况下、预期是什么、实际发生了什么、怎么解决
  的、谁判的它闭环。
- `judged_by` 决定权重:human > pipeline > agent。检索排序与摘要层都按
  权重;agent 自判的不单独成簇。
- 只追加,不改写。记录错了,追加一条 `supersedes: c-000412` 的新记录
  (与 ADR/勘误纪律同一路)。
- 目录:`<data>/corpus/<repo>/<yyyy-mm>/<id>.md`。跨仓的(需求确认、拆分
  方案)放 `<data>/corpus/_module/<module>/`。

## 4. 入库:来源与字段映射

标准只有一条:**一个被人或权威来源关掉的环**。

| 来源 `source` | 触发时刻 | trigger / 问题 / 解决 从哪来 | judged_by |
|---|---|---|---|
| annotation | 批注路由给 Agent、Agent 回执 fixed、人确认通过 | 锚点+文件 / 意见原文 / 回执 summary + diff | human |
| requirement_revision | 需求确认每轮修订被人确认 | 批注锚点 / 意见 / 该轮 diff 摘要 | human |
| decision_override | 决定卡人选了自定义答案或非推荐项 | 问题文本 / 推荐项 / 人写的说明 | human |
| prepush_fix | Build-Fix 失败后修好并通过 | 报错首行 / 报错原文 / 修复 diff 摘要 | pipeline |
| pipeline_repair | 流水线失败→修复环收口(绑 SHA 绿) | 平台事实 / 失败原文 / 修复回执 | pipeline |
| mr_discussion | MR 平台检视讨论闭环 | 讨论位置 / 意见 / 回执 | human |
| assistant_takeover | 开发助手交还且有变更 | 人的指令 / 助手总结 / 变更文件 | human |
| steer | 插话之后 Agent 有对应改动(弱) | 插话原文 / — / 之后的动作 | agent |
| chain_rework | 拆分方案被退回后再确认 | 退回原因 / 旧方案 / 新方案差异 | human |
| issue_rca | 问题流根因分析确认并修复验证 | 结论 / 现象 / 修复与验证 | human |

- 不进库:原始事件流、Agent 自述、未验证回执、许愿墙。
- `trigger` 一句由入库时一次便宜的模型调用起草(单发、无工具、预算
  10 秒,失败留空)。留空的记录只进全文检索,不进目录摘要。
- 入库是旁路:写失败只记日志,绝不影响任务流程(与知识足迹同纪律)。

## 5. 检索旁路进程(sidecar)

宿主是 Node,memsearch 是 Python;CLI 冷启动 2.8s(实测),所以必须常驻。

- 宿主启动时拉起 `memsearch-run`(包装脚本带 HF_HOME/OFFLINE/TMPDIR,
  见部署文档),stdio JSON lines 通信;挂了自动重拉,重拉有退避与次数上限。
- 协议四个动作:`health`、`ingest {path}`、`search {query, repo?, path_prefix?, limit≤8}`、
  `expand {id}`。
- 预算:search 1.5s、expand 1s、ingest 5s、health 500ms。超时返回空结果
  加一句"检索暂不可用",绝不卡 Agent。
- 单 writer:ingest 在宿主侧串行(promise 链,与内核 dispatch 同法)。
- 资源:常驻 RSS 1.2 GB(实测),部署预留 2 GB;写进 preflight。
- 索引与正本分离:`milvus.db` 可删,`corpus/` 是正本;preflight 含一次
  "删索引→重建→对拍"演练。

## 6. 消费:三个时刻 + 一个工具

Agent 不会自己想起来查,所以"什么时候"主要由宿主定:

1. **开局**:按这单的仓和负责面路径 `search` 一次,结果并进开局使命
   (最多 8 条,每条一行结论 + id)。
2. **阶段切换**:内核步骤进入定规格/写代码等阶段时,按范围再查一次,
   以插话送入(两行:几条、在哪、建议先读)。走的是与"提醒 Agent 使用"
   同一条送达路径,不碰内核。
3. **首次改某目录**:工具钩子看到 Edit/Write 路径,该目录有语料且本会话
   未提示过,则附一句(最重的一条 + id)。每目录每会话一次。若钩子不能
   "放行加一句",退回插话。

工具:`corpus_search`,经 pi 扩展 `registerTool` 注册在现有门禁扩展旁边,
主 Agent、子 Agent、开发助手、Build-Fix 自动同有。参数 `query`、
`path_prefix?`、`limit?`;`repo` 由宿主按任务固定,Agent 不能跨仓。
`promptGuidelines` 写动作锚定的触发,不写"需要时使用":

> 改一个没改过的目录之前、修一个报错之前、对某个约定拿不准的时候,先用
> corpus_search 查这个仓的历史语料;结果里的 id 可用 expand 看全文。

推送与工具结果都进知识足迹(kind: corpus),将来接效果账。

## 7. 部署与自查

- 环境变量与目录:`HF_HOME`、`HF_HUB_OFFLINE`、`TRANSFORMERS_OFFLINE`、
  `TMPDIR`、`milvus.uri` 全部在包装脚本里,不靠人 export。
- 模型缓存与 `milvus.db` 在部署数据目录下,与现场、货架同处,受同一备份
  与回收纪律。
- `harness/preflight.sh` 加项:sidecar 起得来、health 过、一次 search 在
  预算内、删索引重建对拍一致、RSS 在预留内。
- 四个坑(内网 pip 源、根盘空间、HF 离线缓存结构、软链两级上级)以
  `docs/memsearch-deploy.md` 为准。

## 8. 测试契约

- 假 sidecar(进程内,同协议)承载全部语义用例:入库映射、权重排序、
  预算超时返回空、宿主三时刻推送内容、工具参数被固定 repo。
- 真 sidecar 用例:venv 不存在时**显式 skip 并明说**;存在时跑 health/
  search/expand/重建对拍。
- 事故式用例:sidecar 中途被 kill -9,任务照跑、推送变空、重拉后恢复。

## 9. 分期

1. 第一期:语料记录 + `annotation`/`prepush_fix` 两个来源入库 + sidecar +
   开局推送。够验证"记忆有没有用"。
2. 第二期:阶段切换推送、首次改目录钩子、`corpus_search` 工具、足迹。
3. 第三期:其余来源、目录摘要层(单目录超 15 条时揉摘要)、效果账
   (某条记忆/Skill 之后同路径返工是否减少)。
4. 不做:语料 UI、人用的检索门户、向量库以外的存储。

## 10. 待拍板

1. 语料按仓分库还是全团队一库(跨仓检索需求 vs. 隔离与噪音)。倾向:
   一库,`repo` 是过滤键,宿主按任务固定。
2. 保留期:记忆只增不减,是否按时间沉底(如两年后不进检索、不删)。
3. 谁能看语料:仅 Agent,还是给管理员一个只读导出。倾向:仅 Agent,
   导出走文件系统。
