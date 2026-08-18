# MR 闭环适配文档(对照内网既有框架)

> 来源:用户提供的内网既有框架说明(代码不出内网,只有行为描述)。
> 目的:把那套"提交→建 MR→监控→分类修复→直至合入"的闭环能力移植进
> 本仓,由内网的模型按批次实施。
>
> **分工(重要)**:判定与状态机在本仓这边写(能力弱的模型写判定必出事,
> 而且本仓红线是"判定只在内核/宿主既有机制里,不许随手复刻");内网模型
> 负责的是**适配层填空**——把下面每个 HTTP 端点映射到 codehubcli 子命令
> 或 MCP 调用,以及把返回值形状翻译成契约字段。适配层不做任何判断:
> 不认识的状态一律 502 拒绝猜(既有纪律,别改)。

---

## 0. 一句话对照

| | 内网既有框架 | 本仓现状 | 差距 |
|---|---|---|---|
| 提交/推送 | **平台代劳**,AI 禁止 commit | **agent 自己提交**,内核门禁管合法性 | 见 §1,不照搬 |
| 建 MR | 平台建,幂等复用 | 宿主建(`POST /mr`),**不幂等** | 补幂等 |
| 监控信号 | MR 状态 + 流水线 + **门禁 9 项** | 只有流水线 | **缺整层** |
| 失败分类 | 检视/冲突/CI/不可修/等待 五类 | 只有"红了就修" | **缺** |
| 重试语义 | 只有 CI 失败扣次数 | 所有失败同等 | 补 |
| 修复上下文 | 摘要进 prompt + 日志落盘双通道 | 只有摘要,2000 字截断 | 补落盘 |
| 检视意见闭环 | 拉讨论→逐条回复→标记已解决 | **无** | 补 |
| 冲突修复 | 本地 merge 造冲突标记给 agent 解 | **无** | 补 |
| 挂起等待 | 审批/投票/WIP 不空转、不扣重试 | 无此状态,会当异常 | 补 |
| 多仓 | 逐仓提交逐仓 MR | 一单一仓 | 待确认是否需要 |

---

## 1. 一个必须先拍板的分歧:谁来 commit

内网框架的设计是"**agent 只改文件,commit/push/建 MR 全由平台代劳**",
理由是避免 agent 权限过大、提交信息不规范。

本仓不能照搬,原因是硬的:**提交本身是内核判定的一部分**——commit 的
归属、提交前的证据链(编译/UT/检视是否走完)、`gate-bash` 对 git 命令的
拦截,都是内核契约。把提交收归宿主等于绕过内核门禁,直接撞红线
(内核唯一权威;宿主不复刻判定)。

**建议的取法(已按此写下面的方案)**:

- **保留** agent 提交:业务提交仍由流程内的 agent 做,内核照常把关;
- **收归宿主**的只有"机械自愈"那部分——推送被拒后的 `pull --rebase`、
  修复前的 rebase 前置、冲突时的 `git merge` 造标记。这些是 git 机械
  动作,不含判定,宿主做不越权;
- **force-push 不做**。内网框架敢 force 是因为工作分支由平台自建、
  格式固定(`目标分支_用户_DTS单号`)覆盖安全;本仓分支名来自内核配置,
  且红线里"不可逆动作要人裁决"——内核门禁本身就拦 force push
  (实测打回文案:"禁止 force push(含 +refspec 形式)")。遇到必须
  覆盖远端的场景,走停机请人工,不自己硬来。

> 待确认 **Q1**:你们那套的工作分支确实是平台自建的固定格式吗?如果
> 内网试点仓也允许 agent 自己起分支,force-push 这条更不能抄。

---

## 2. 目标状态机(本仓形态)

```
交付点 ─→ 建 MR(幂等) ─→ 监控轮询 ┬─ 全绿 & 已合入 → merged(终态)
                                  ├─ 门禁失败 → 分类:
                                  │    检视未解决 → 检视修复会话
                                  │    有冲突     → 冲突修复会话
                                  │    CI 红      → CI 修复会话(唯一扣重试)
                                  │    审批/投票/WIP 等 → 挂起等待(继续监控,通知人)
                                  │    不可修工具失败 → 跳过本轮(不扣重试,留痕)
                                  └─ 流水线未结束 → 等下一轮
修复会话收尾 → agent 提交并推送 → 回监控(同一个 MR,不重建)
出口:merged / halted(请人工,带诊断) / exhausted(重试耗尽) / closed(MR 被关)
```

与现状的关系:`monitoring` 就是现有的 `pollPipeline`,`fixing` 就是现有的
修复环(`pipelineVerdict` → 派修复会话)。**改造是给它加信号与分叉,
不是重写**。

---

## 3. 适配层要新增的端点(内网模型的主要工作面)

现有三个端点不动(`POST /mr`、`POST /pipeline/trigger`、
`GET /pipeline/status`)。新增四个:

### 3.1 `GET /mr/gates?repo=<url>&mr=<iid>`

合并门禁九项。**宿主消费的字段**:

```json
{
  "mr_state": "opened|merged|closed",
  "gates": [
    {"name": "ci_state_passed", "passed": false, "detail": "3 个 job 失败"},
    {"name": "resolve_discussion_passed", "passed": false, "detail": "2 条未解决"},
    {"name": "conflict_passed", "passed": true}
  ]
}
```

- `name` 必须用 CodeHub 原始门禁名,**不要翻译**(宿主按名字分类,
  见 §4 的表;认不出的名字宿主按"挂起等待"处理并留痕,不会瞎修);
- `passed` 必须是布尔;拿不到某项就**不要输出这一项**(别塞 `null`,
  宿主会当成未知项);
- `detail` 可选,人话一句,进任务详情给人看。

> **Q2 已核实(2026-08-17 报告)**:真实调用是 REST
> `GET /api/v3/projects/{路径}/merge_requests/{iid}/mergeable_state`,
> 返回**不是数组,是平铺布尔对象**:九项门禁名与 §4 的表逐字吻合、
> 全是布尔,另有约 18 个额外布尔字段、一个 `reason` 文案对象和
> `merge_request_switch` 总开关。适配层为此加了 `bools`/`reason`/
> `ignore_fields` 平铺模式(把布尔字段翻译成上面的 gates 数组,
> reason 同名文案进 detail),契约本身不变——宿主"认不出的名字按
> 等人处理"的设计正好兜住那 18 个额外字段。参考填法见 §11。

### 3.2 `GET /mr/discussions?repo=<url>&mr=<iid>`

未解决的检视意见。

```json
{"discussions": [
  {"id": "d-123", "file": "src/a/B.java", "line": 42,
   "severity": "major", "author": "张三",
   "body": "这里空指针没防", "url": "https://.../#note_123"}
]}
```

- 只回**未解决**的;`id` 是回复/标记已解决时要带回去的那个标识;
- `file`/`line` 缺失也行(整体意见),`severity` 缺失按普通处理。

### 3.3 `POST /mr/discussions/:id/reply`

请求 `{repo, mr, body, resolve: <bool>}` → 回 `{ok: true, resolved: <bool>}`。
把 agent 写的逐条回复发布到对应讨论;`resolve` 为 true 且适配层配了
`discussion_resolve` 时才标记已解决。

> **Q3 已核实(2026-08-17 报告 D3)**:回复(POST notes)与标已解决
> (PUT discussions / 新代 CLI `--resolve` 带 note id)是**两个调用**,
> 且既有框架**刻意只回复不代 resolve**——"that is the reviewer's
> responsibility"。宿主已改为同一语义:默认 `resolve:false`,回复
> 发布后讨论保持未解决,任务挂"等检视人确认已回复的意见"继续监控
> (不是刹车),检视人点掉后门禁自然清。平台/团队明确允许代点的
> 部署,serve 加 `--resolve-discussions` 才走两步调用。

### 3.4 `GET /pipeline/artifacts?sha=<sha>&repo=<url>`

失败详情的**结构化清单**,用于落盘给 agent 读(§5)。

```json
{"files": [
  {"name": "build_12345.log", "text": "....."},
  {"name": "codecheck_detail.json", "text": "{...}"},
  {"name": "coverage_summary.json", "text": "{...}"}
]}
```

- 适配层负责把你们那套(SSE 网关 → CloudBuild → zip/分页)封装成
  "一次调用给我一组文本文件";**宿主不碰你们的认证与分页**;
- 单个文件超 200KB 请适配层自行截断并在末尾标注"(已截断)";
- 拿不到就回 `{"files": []}`,宿主降级用摘要通道,不报错。

> 待确认 **Q4**:那个 SSE 网关(`10.244.150.123:9000/sse`)在试点机器上
> 能直连吗?`get_mr_pipeline_info` 的真实返回样例发我一份——我要确认
> `record_ids` / `x_auth_groups` 这些字段最终能不能落到上面这个契约里。

---

## 4. 门禁分类表(宿主实现,内网模型不用改)

| 门禁名 | 分类 | 动作 | 扣重试 |
|---|---|---|---|
| `resolve_discussion_passed` | 可修 · 优先级 10 | 派检视修复会话 | 否(并清零) |
| `conflict_passed` | 可修 · 优先级 15 | 派冲突修复会话 | 否(并清零) |
| `ci_state_passed` | 可修 · 优先级 20 | 派 CI 修复会话 | **是** |
| `approvers_passed` | 等人 | 挂起 + 通知归属人 | 否 |
| `vote_passed` | 等人 | 同上 | 否 |
| `work_in_progress_passed` | 等人 | 同上 | 否 |
| `e2e_check_passed` | 等人 | 同上 | 否 |
| `custom_ctrl_items_passed` | 等人 | 同上 | 否 |
| `evaluation_passed` | 等人 | 同上 | 否 |
| 认不出的名字 | 等人 | 挂起 + 留痕(名字进详情) | 否 |

优先级含义:同时有多项未过时,**只派优先级最高的那一路**(检视 > 冲突 >
CI)。理由照抄内网框架:冲突不解,CI 白跑;检视优先于代码问题。
一个例外(2026-08-17 报告 D3 之后):检视这一路"这批意见都答复过了、
只是检视人还没点已解决"时**不占路**——归入等待名单,顺位落到下一
优先级继续派(等人不许把 CI 修复堵死)。

报告 B 节实证:九项拼写与上表逐字一致、全布尔。**2026-08-18 内网
selftest 拿到真实门禁集(19 项)**,九项之外多这十项,分类与文案已按
实物钉死:

| 平台原始名 | 分类 | 界面文案 |
|---|---|---|
| `codequality_passed` | **可修 · CI(优先级 25)** | ——(派修复,见下) |
| `approval_approvers_required_passed` | 等人 | 等必需审批人审批 |
| `approval_reviewers_required_passed` | 等人 | 等必需检视人检视 |
| `committer_must_cast_two_votes_passed` | 等人 | 等提交人以外的两票 |
| `merge_by_self_passed` | 等人 | 等他人代为合入 |
| `merged_by_user_passed` | 等人 | 等有权限的人点合入(目标分支受保护) |
| `mr_state_passed` | 等人 | 等 MR 回到可合入状态 |
| `no_commits_passed` | 等人 | 等分支上出现提交 |
| `branch_missing_passed` | 等人 | 等分支恢复(远端分支不见了) |
| `non_ff_passed` | 等人 | 等处理非快进(需变基,自动修复不做强推) |

两条判断的理由:

- **`codequality_passed` 必须归可修**。它是 CodeCheck/CodeCC 那类扫描
  结论——改代码就能解决,正是 CI 修复使命里"按类分诊"已覆盖的一类。
  归到等人的话,MR 卡在这里没有任何人会来动,任务干等到监控预算耗尽
  (首次实测时它正是 false)。排在 `ci_state_passed` 之后同一路:同一个
  修复会话一次修完,而流水线原文比质量门禁的一句话更全;
- **`non_ff_passed` 只能等人**。平台要求线性历史时,宿主的冲突修复走
  `git merge`(产生合并提交)解不了它;真解法是变基后强推,而强推是
  内核明令禁止的不可逆动作。如实挂等人,交给人裁决,不假装能自动修。

"等人"不是失败:任务停在验证中,**继续轮询**,并给归属人发通知说清
"卡在哪一项、需要谁做什么"。这是本仓现在缺的语义——现在会一路轮询到
预算耗尽然后判"请人工",人看不出到底是没人审批还是真出问题了。

---

## 5. 修复上下文:双通道(宿主实现)

- **通道 A(摘要)**:失败 job 列表 + 质量检查前 5 条 + 门禁未过项,
  压成几行写进修复会话开场白。现状已有,但要把门禁项加进去;
- **通道 B(落盘)**:`§3.4` 拿到的文件写进**工作区外**的
  `<任务工作区>/pipeline/`(不是仓库里,不能进 MR),开场白里给出文件
  清单让 agent 自己 read。每轮修复**先清空再重下**,保证是最新一轮。

> 落在工作区外这条必须守住:落进仓库会被 agent 顺手 commit 进 MR,
> 检视的人会看到一堆日志文件。

---

## 6. 三类修复会话的差别(宿主实现)

三者共用现有的修复环机械(另起会话、一次提交一次 push、同 SHA 不二修、
诊断出口),差别只在使命文案与准备动作:

| | 准备动作(宿主做) | 使命附加内容 | 收尾额外动作 |
|---|---|---|---|
| CI 修复 | rebase 到目标分支最新;刷新 `pipeline/` 落盘 | 失败摘要 + 日志路径清单 + 上一轮失败对比 | 无(推送后回监控) |
| 检视修复 | 拉未解决讨论落盘 `reviews/` | 逐条意见(文件/行号/原话)+ 要求写 `review_replies.md` | 把回复发布到对应讨论并标记已解决 |
| 冲突修复 | `git merge --no-edit origin/<目标分支>` 故意造冲突标记 | 冲突文件清单 + "保留双方必要改动、删干净标记" | 无 |

冲突修复那条的巧思值得抄:**让 agent 在真实冲突标记上解**,而不是给它
一段描述让它凭空想——这是内网框架里最实用的一条。

**merge 必须写 `origin/<目标分支>`,不是 `<目标分支>`**(2026-08-18
内网拿到平台 pre-receive 完整正则后确认的硬约束):

| 合并提交信息 | 平台钩子 |
|---|---|
| `Merge remote-tracking branch 'origin/master' into <分支>`(merge origin/x 的默认信息) | ✅ 放行 |
| `Merge branch 'master' of <url> into <分支>`(git pull 的默认信息) | ✅ 放行 |
| `Merge branch 'master' into <分支>`(**merge 本地分支**的默认信息) | ❌ 拒收 |

宿主代码本来就是 `origin/` 形式(`src/taskService.ts` 的
`dispatchConflictRepair`),所以这条天然过——但**本文档此前把它简写成
`git merge <目标分支>`,内网照文档读代码,判成"契约洞"报了回来**。
教训写在这儿:文档里的命令是会被当契约读的,简写要付代价。测试已把
合并提交信息的形状钉住(`tests/mrLoop.test.ts` 冲突用例)。

---

## 7. 实施批次(每批可独立验收)

> 每批都必须:①有测试(假件裁判,契约写进测试);②`npm test` 全绿;
> ③`npm run typecheck` 0 错;④README 诚实清单补一条"什么验过、什么没验"。

- **批 1~4:已完成(2026-08-17)**,tests/mrLoop.test.ts 端到端 +
  delivery.test.ts 旧 16 项全绿;适配层四个新端点与 `--selftest` 就绪。
- **报告已回并消化(2026-08-17)**:《MR 闭环能力核对报告》总判定
  "可以集成,3 处缺口"。按报告改了三处契约(都在外网改,内网零代码):
  ①检视回复默认不代 resolve(D3),已回复未确认=等人不等于修不动;
  ②适配层 mr_gates 加平铺布尔模式(B 节 mergeable_state 真实形状);
  ③MR 先查后建 + 创建失败回查兜竞态(A2 幂等语义不统一)。
  三个缺口进试点清单(§11 末尾)。
- ~~批 1(核心)~~:门禁进契约 + 分类表 + 优先级派单 + 重试语义
  (只 CI 扣)+ 挂起等待状态与通知。假件 `gitPlatform.ts` 加门禁模拟。
- ~~批 2~~:日志落盘 `pipeline/` + 双通道开场白。
- ~~批 3~~:检视修复闭环(拉讨论→使命→回复发布并标已解决)。
- ~~批 4~~:冲突修复(merge 造标记→使命→解完提交)。

**MCP 怎么办(已定,依据报告 C2)**:网关是 streamable HTTP——
`GET /sse` 拿 session_id,`POST /messages` 发 JSON-RPC;鉴权分两个
网关(主网关 `X-Auth-Token` + w3token,SSE 日志网关 auth:false 但要
`x_auth_token` 参数)。这个形态**包桥就够了**:一个几十行的脚本
(argv 收参数 → 发两个 HTTP 请求 → stdout 吐 JSON),适配层照常以
命令行拉起它——桥是配置产物,不算内网改代码,原生 MCP 客户端不做。
唯一必须走 MCP 的能力是完整构建日志下载(A6:CLI token 打日志网关
401,要 MCP access token),桥只为它服务;其余能力 CLI/REST 全够。
- **批 5(内网模型做,只改配置不碰代码)**:在 `adapter.json` 里填四个
  新端点的命令模板/MCP 调用与形状映射;`npm run adapter -- --selftest`
  自检通过;再用 curl 逐个端点验一遍。**不许改任何 .ts**(见 §9)。
- **批 6(内网模型做)**:真实平台上跑一单到底,把每个端点的真实返回
  与自检输出誊出来,对照契约字段查漏。

---

## 8. 给内网模型的硬性纪律(照抄进 prompt)

1. **适配层不做判断**:不认识的状态/门禁名一律原样上抛或 502,
   **绝不猜**(猜 running 白轮询、猜 failed 白烧一轮修复);
2. **不改宿主的判定代码**:门禁分类表、重试语义、状态机在
   `src/taskService.ts`,那是本仓这边维护的,适配层只管形状翻译;
3. **令牌只走请求头**(`x-mfc-git-token`/`x-mfc-git-user`),
   不进请求体、不落日志——请求体会进 PG 台账;
4. **每个端点都要有超时预算**(默认 60s),超时如实报错,不许无限等;
5. 改完必须跑 `npm test`;需要 docker/PG 的用例没环境会显式 skip,
   **skip 不等于通过**,不要把 skip 当绿灯汇报。

---

## 9. 怎么保证代码不分叉(内网改了我就看不见了)

这是这件事最大的风险,不是技术风险是流程风险:**内网一旦开始改 .ts,
外网这份就永远追不上了**,以后每次我改代码都可能覆盖掉内网的补丁,
而我连它长什么样都不知道。

所以定死一个方向:**代码单向流动,数据反向流动。**

```
外网(我写代码) ──ZIP──→ 内网(只填配置、只做观测)
                 ←─文本─── adapter.json + 真实返回样例 + 报错原文
```

具体三条纪律:

1. **内网侧零 .ts 改动**。内网模型的产出只有 `adapter.json`(命令模板
   与形状映射)——那是**配置不是代码**,而且形状由本文档定义。判定、
   状态机、修复环全在外网这份代码里,内网不碰;
2. **内网带出来的只有数据**:填好的 `adapter.json`(脱敏)、每个端点的
   真实返回样例、失败时的错误原文。这些都是文本,可以誊出来/口述,
   不涉及内网代码资产;
3. **内网非改代码不可的时候,那是我的契约有洞**——反馈"哪个端点的
   真实形状对不上",我在外网改契约再发新版进去。**内网打补丁是分叉
   的第一步,一次都不要开这个头**。

配套一个自检口子(我来实现,批 5 之前给):

```bash
npm run adapter -- --config adapter.json --selftest
```

它会打印:解析到的每个端点命令、一次 dry-run 的真实返回、以及"哪些
契约字段没取到"。**把这段输出贴给我,等于我看到了内网那边的形状**,
不需要看代码,也不需要网络连通。

---

## 10. 待确认问题清单(2026-08-17 报告已答大半)

| # | 问题 | 答案(依据能力核对报告) |
|---|---|---|
| Q1 | 工作分支格式 | ✅ 平台固定 `<目标分支>_<用户>_<单号>`(实测 `master_z30003938_REQ...`),与内核"分支名"配置同形;force-push 维持禁用 |
| Q2 | 门禁查询形状 | ✅ REST `mergeable_state`,平铺布尔+reason,见 §3.1/§11 |
| Q3 | 回复/标已解决 | ✅ 两个调用;框架刻意不代 resolve,宿主已同语义,见 §3.3 |
| Q4 | SSE 日志网关 | ⚠️ 试点机可达、缺陷信息免鉴权可拿;**完整日志要 MCP access token**(CLI token 401)——缺口②,走 §7 的桥 |
| Q5 | `mr update` | 未真调(非闭环必需,暂不消费) |
| Q6 | SuperChecker 识别 | ⚠️ 源码实锤有 skip 逻辑,但无真调样例(缺口③);本仓现行为:派一轮修复→会话诊断"不可修"→halted 带诊断请人工,诚实但多烧一个会话,拿到判据后再做前置跳过 |
| Q7 | 单仓/多仓 | 试点单仓;多仓路由(repo 字段)已在契约里,配置层面扩 |
| Q8 | token 兼任 push 凭据 | ✅ 同一个 token,但框架用 `https://oauth2:{token}@host` 形式(用户名固定 `oauth2`);push 本身被代理 504 挡住未走通(缺口①),部署手册有对策 |
| Q9 | 等审批表现 | 已实现:waiting_on 说清卡在哪 + 幂等通知归属人(同一批等待只响一次) |
| Q10 | maxRetries=20 | 维持本仓语义:默认不限轮、可配手刹,收敛靠同 SHA 刹车 |

补充实证(不在问题清单里但影响契约的):
- **A2 幂等**:CLI 重复建报 stderr `Another open merge request already
  exists...: !N`;REST 重复建**静默 200 空 body**。两种形状都别赌——
  适配层已加 `mr_lookup` 先查后建,创建失败再回查一次兜竞态;
- **D5 触发**:push 自动触发流水线,不需要显式 trigger——
  `pipeline_trigger` 配成查询 `actual_head_pipeline` 的只读命令 +
  `status: {"const": "running"}` 即可(§11);注意 `is_valid: false`
  表示 MR 头上还没有有效流水线(挂着的可能是旧分支的陈灯),适配层
  这时**不要**把旧灯翻译成终态;
- **C1 CLI 三代不兼容**:Python codehub.exe v0.4.9(已装)与设计契约
  参照的 Node codehub-cli 1.6.0 子命令/参数完全不同(如 v0.4.9 用
  `--source-project <数字id>`,MR 建单要项目 id 不是路径)。适配层是
  命令模板,**照装机上真实存在的那一代填**,selftest 会当场暴露对不上
  的形状;REST 用自动派生的 `{repo_path}` 不需要 id,只有 CLI 命令
  要数字 id 时按 §11 的办法查一次写进模板。

---

## 11. adapter.json 参考填法(照报告的真实形状,进场对着微调)

下面是按报告钉出来的骨架——REST 优先(形状最稳、不吃 CLI 代际),
`curl` 都是只读或幂等安全的。**占位说明**:`<host>`=CodeHub API
域名(手填这一个就够);`{repo_path}` 等花括号占位符由适配层运行时
填——`{repo_path}` 是从宿主传来的仓库 URL **自动派生**的 URL 编码
项目路径(如 `g%2Fdemo`),CodeHub REST 按路径定位仓,**不用手抄
项目数字 id**。只有走 v0.4.9 CLI 的命令才要数字 id(它不认路径),
那也别手抄:`curl .../api/v3/projects/{repo_path}` 的返回里 `.id`
就是,查一次写进模板。真实字段名以 selftest 输出为准,对不上改
这份配置,不改代码。

```jsonc
{
  "token_file": "/etc/mae-flow-cloud/codehub-token",   // 0600
  "mr_lookup": {   // 先查后建(A2:幂等语义不统一,查询是唯一稳的路)
    "command": ["curl", "-sf", "-H", "X-Auth-Token: {token}",
      "https://<host>/api/v3/projects/{repo_path}/merge_requests?state=opened&source_branch={source_branch}&target_branch={target_branch}"],
    "url": {"json": "0.web_url"},
    "id": {"json": "0.iid"}
  },
  "mr_create": {
    "command": ["curl", "-sf", "-X", "POST",
      "-H", "X-Auth-Token: {token}", "-H", "Content-Type: application/json",
      "-d", "{\"source_branch\":\"{source_branch}\",\"target_branch\":\"{target_branch}\",\"title\":\"{title}\"}",
      "https://<host>/api/v3/projects/{repo_path}/merge_requests"],
    "url": {"json": "web_url"},
    "id": {"json": "iid"}
    // 注意:重复建时 REST 回 200 空 body,url 抽取会失败——
    // 但 mr_lookup 在前面已经把已存在的单接走了,这条只处理真创建。
  },
  "pipeline_trigger": {   // D5:push 自动触发,这里只是查询,不产生副作用
    "command": ["curl", "-sf", "-H", "X-Auth-Token: {token}",
      "https://<host>/api/v3/projects/{repo_path}/merge_requests/{mr}/pipelines/latest"],
    "status": {"const": "running"}   // 交给宿主轮询 pipeline_status 收敛
  },
  "pipeline_status": {
    // actual_head_pipeline:注意 is_valid=false 时挂的是旧灯,不是
    // 本次提交的结果——包一层 jq 只在 is_valid 且 sha 匹配时输出 run
    "command": ["bash", "/etc/mae-flow-cloud/pipeline-status.sh",
      "{sha}", "{token}"],
    "status": {"json": "state"},
    "log": {"json": "fail_summary"},
    "status_map": {"success": "success", "failed": "failed",
                   "running": "running", "pending": "running",
                   "canceled": "failed"}
  },
  "mr_gates": {   // B 节:mergeable_state 平铺布尔 + reason
    "command": ["curl", "-sf", "-H", "X-Auth-Token: {token}",
      "https://<host>/api/v3/projects/{repo_path}/merge_requests/{mr}/mergeable_state"],
    "bools": {"json": ""},            // 布尔字段在哪层就指到哪层
    "reason": {"json": "reason"},
    // ⚠️ mergeable_state 里的 `state` 是**布尔**(整体可不可合),
    // 不是 opened/merged/closed 的生命周期(2026-08-18 内网实测)。
    // 它必须进 ignore_fields(否则被当成一项门禁),而 mr_state 要
    // 从 MR 详情端点取:GET .../merge_requests/{iid} 的 state 字段。
    // 单条命令拿不到两样东西时,包一个 sh 脚本把两个响应合成一个
    // JSON 输出(脚本是配置产物,不算改代码)。
    "ignore_fields": ["merge_request_switch", "state"],
    "mr_state": {"json": "mr_state"},   // 脚本合成:来自 MR 详情
    "mr_state_map": {"opened": "opened", "merged": "merged",
                     "closed": "closed", "locked": "opened"}
  },
  "mr_discussions": {
    "command": ["bash", "/etc/mae-flow-cloud/unresolved-discussions.sh",
      "{mr}", "{token}"],   // jq 过滤 resolved==false,拍平 notes[0]
    "fields": {"id": {"json": "id"}, "file": {"json": "position.new_path"},
               "line": {"json": "position.new_line"},
               "author": {"json": "author"}, "body": {"json": "body"}}
  },
  "discussion_reply": {
    "command": ["curl", "-sf", "-X", "POST",
      "-H", "X-Auth-Token: {token}", "-H", "Content-Type: application/json",
      "-d", "{\"body\":\"{body}\"}",
      "https://<host>/api/v3/projects/{repo_path}/merge_requests/{mr}/discussions/{id}/notes"],
    "note_id": {"json": "id"}
  },
  // discussion_resolve 默认不配(D3:resolve 归检视人)。团队拍板要
  // 代点再配:PUT .../discussions/{id} -d '{"resolved":true}'
  "pipeline_artifacts": {   // A6:完整日志走 MCP 桥(§7),先落盘再读
    "command": ["python3", "/etc/mae-flow-cloud/mcp-log-bridge.py",
      "--sha", "{sha}", "--out", "/var/mfc/artifacts/{sha}"],
    "files_dir": "/var/mfc/artifacts/{sha}"
  }
}
```

两个小脚本(pipeline-status.sh / unresolved-discussions.sh)和 MCP 桥
都是**配置产物**——几十行、只做取数和过滤、不做判定,放 /etc 下随
adapter.json 一起管,不进仓库、不算改代码。

### 试点必验清单(报告的三个缺口,都不是本仓代码能修的)

1. **push 走不走得通**(缺口①):报告里 push 被代理 504 挡住。在试点
   机器上用 `git push https://oauth2:<token>@<host>/<repo>` 实推一次
   测试分支;404/401 再试把凭据用户名换成平台账号。结论回填部署手册;
2. **MCP access token 供给**(缺口②):完整构建日志要它。找平台方拿
   token 文件路径与刷新方式,MCP 桥读它;拿不到就先降级——
   `pipeline_artifacts` 不配,修复环走摘要通道(宿主自动 fail-open);
3. **SuperChecker 真实失败样例**(缺口③):逮到一条后把工具名/错误码
   贴回来,外网把"前置跳过不可修工具失败"补上;在那之前的行为是
   多烧一个诊断会话后诚实停机,不会瞎修。
