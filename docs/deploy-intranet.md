# 内网部署手册(准备件——外部完全就绪才执行)

> 原则(用户拍板):**外部完全就绪才部署内网;需要内网能力就模拟。**
> 本文是"真件就绪=换地址"的可执行版:每个假件对应一个配置点,
> 语义契约不随部署改变——契约写在各自的测试里,换真件后测试仍然是裁判。

## 机器前置

| 依赖 | 版本/说明 |
| --- | --- |
| Node.js | ≥ 20(`tsx` 直跑 TS,无构建步) |
| Python 3 | ≥ 3.10,mae-flow 内核的运行时 |
| mae-flow 内核 | checkout 到服务器,`MAE_FLOW_HOME` 指向仓根(缺省找 `../mae-flow`) |
| Git | 任务克隆/推分支/ls-remote 都用它 |
| JDK + Maven | 试点仓(Java)编译验证用;版本按试点仓 `pom.xml` 要求。**--verify-via-pipeline 形态不需要**(docker 同) |
| npm 依赖 | `npm ci`(pi 锁 0.84.1,升级必须重跑 probe+全套测试再拍板) |

**Linux 容器编译验证(外部已模拟通过)**:2026-08-14 在 Colima
arm64 Linux 容器(maven:3.8-eclipse-temurin-8)对 fieldtest-java
干净副本验证 compile/test 退出码 0。上内网第一件事仍然是:在**目标
容器镜像**里跑 `mvn compile && mvn test`,退出码必须真实核验
(不许管道吞码)——外部模拟不替代目标镜像的最终裁决。

## 四个假件 → 真件切换表

| 能力 | 外部假件 | 内网真件切换点 | 语义契约(不变) |
| --- | --- | --- | --- |
| 模型网关 | scriptedModel / bigmodel | `--models` 指向内网网关 models.json | Anthropic Messages + SSE;注意网关是否静默改路由模型 |
| 小鲁班通知 | FakeLubanServer | Notifier `endpoint` + 鉴权头 | 投递失败不改流程状态;有限退避;按 waiting_id 幂等 |
| Git 服务端 | FakeGitPlatform 裸仓 | `--repo` 指向内网仓地址(克隆凭证走 git credential) | 服务端仓是唯一远端真相 |
| MR + 流水线 | FakeGitPlatform HTTP | `delivery.platformUrl` + 鉴权 | MR 按(源→目标)幂等;流水线结果绑 SHA;验证中→等待合入 |

## 内网依赖就两个 CLI(强度刻意不同)

除标准件(git / python3 / node;`--verify-via-pipeline` 形态下
**docker 也不需要**)外,内网新增的外部依赖只有两个内部 CLI:

| | 干什么 | 强度 | 挂了会怎样 |
|---|---|---|---|
| MR/流水线 CLI | 交 MR、按 SHA 查状态、拉失败日志 | **硬依赖**(交付链的裁判入口) | 交付动作失败如实落账(`summary.delivery` 带原因原文),任务停在 completed/verifying 留痕,不假装交付 |
| 通知 CLI(拉群艾特;或小鲁班 HTTP/MCP,三选一) | 事实 → 一条消息@到人 | 软依赖(旁路 fail-open) | 只把 `summary.notify` 标红,流程一步不停 |

### MR/流水线 CLI:严格说是三个能力,第 3 个最要命

1. **交 MR**(源分支→目标分支,幂等);
2. **按 SHA 查流水线状态**(结果必须绑提交,旧绿灯不背书新代码);
3. **拉失败日志** ← **进内网第一件要核实的能力**。它是修复 agent 的
   口粮:没有失败日志,修复环退化成瞎修。若内部 CLI 拉不到日志,
   退路是修复 agent 只拿到"哪个 job 红了"、在本地复现——那就又绕回
   编译环境,免编译形态的意义损失大半。**先验这一条,再谈部署形态。**

### 适配层契约(照抄即可实现,字段是代码真实消费的全集)

适配层 = 一个把内部 CLI 输出翻译成下列 JSON 的小 HTTP 服务
(或直接改造 `delivery.platformUrl` 的指向)。宿主只读这些字段,
多余字段一律忽略;状态机、修复环、轮询一行不改:

| 端点 | 请求 | 宿主消费的响应字段 |
|---|---|---|
| `POST /mr` | `{source_branch, target_branch, title}` | `{url}`(MR 链接,展示用) |
| `POST /pipeline/trigger` | `{sha}` | `{status: "success"\|"failed"\|"running", log?}` |
| `GET /pipeline/status?sha=<sha>` | — | `{runs: [{status, log?}]}`(取最后一个终态 run) |

- `log` = 失败详情原文(修复 agent 只看前 2000 字,适配层自行截断);
- 平台若只有"触发后异步跑",trigger 返回 `running` 即可,宿主轮询收敛;
- 轮询旋钮:`pollIntervalMs` 默认 10 秒(内网建议 30~60 秒,看 CLI 开销),
  `pollTimeoutMs` 默认 30 分钟,耗尽如实留痕请人工——绝不无限等。
- 没选 webhook 的原因:要求平台能回调进来(防火墙/注册都是部署项),
  假件难模拟,重启后回调丢了仍要轮询兜底——等于养两套。真有需要时
  webhook 可后加,轮询留作兜底,语义不变。

### 通知 CLI 的两条候选(Notifier 端口的新实现,语义契约不变)

契约:投递失败不改流程状态、按 waiting_id 幂等、有限退避。
- **拉群 + CLI 艾特**(用户提议):建群、用内部 CLI 在群里 @ 相关人;
  适配层只做"事实→一条消息",失败落 `summary.notify` 标红;
- **小鲁班 MCP**:若内网提供 MCP 服务端,需引入 MCP 客户端
  (`@modelcontextprotocol/sdk`,本仓当前未装,纯 JS 无构建);
  传输方式/工具名/鉴权进内网确认,不预写。

## 流水线修复环(全绿是最终目标)

红灯不再是终点:宿主小状态机(`delivery.loop`,5 个字段的记账)派
**专职修复会话**拿失败日志修复、推新提交、触发新流水线,循环直到绿,
受三道刹车约束——轮数预算(`repairRounds`,默认 2;0=关)、同 SHA 不
二修(会话没产生新提交即停)、全部等待走宿主轮询预算。修复本身是纯
提示词;宿主只做等待、事实(绑 SHA)、刹车三件提示词干不了的事。
内网需要确认:失败日志 CLI 的输出如何截断(适配层负责喂进 `log`)。

### 免编译形态:--verify-via-pipeline(用户拍板:"先不编译了,直接上流水线")

宿主没有构建链、也不想供养容器镜像时,加 `--verify-via-pipeline`
(必须同时有 --platform/--fake-platform,否则没人裁判):
- 每次会话开场注入环境事实:本机不做编译/UT,流程里对应环节注明
  「本地验证由流水线代行」并继续(云端台账门禁已放开,done 不拦);
- 慢的代价由修复环扛:红灯自动派修复会话,不占人的时间;
- 上线自查第 1 项(容器内 mvn compile)对此形态**不适用**,改为核验
  第 5 项时流水线真实跑过 compile+test(结果绑 SHA)。

models.json 形状(key 只放服务器本地文件,权限 600,永不进仓):

```json
{
  "providers": {
    "内网网关名": {
      "baseUrl": "https://<内网网关>/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "<从凭证系统注入>",
      "models": [{ "id": "glm-5.1" }]
    }
  }
}
```

## 配置面全集(--config 一个文件收口)

`npm run serve -- --config /etc/mae-flow-cloud/serve.json`。文件键 =
去掉 `--` 的 flag 名;命令行永远压过文件(排障临时改参数不必动文件);
**文件坏了拒绝启动**,不静默忽略——带着一半配置起服,比不起服更害人。
密钥(模型 apiKey、通知鉴权头)所在文件一律权限 600,永不进仓。

```json
{
  "models": "/etc/mae-flow-cloud/models.json",
  "provider": "内网网关名", "model": "glm-5.1",
  "repo": "<内网仓地址>",
  "platform": "<MR/流水线适配层地址>",
  "luban": "<通知端点>",
  "luban-header": ["Authorization: Bearer <密钥>"],
  "pg": "postgresql://...",
  "data": "/var/lib/mae-flow-cloud", "port": 8787,
  "verify-via-pipeline": true,
  "repair-rounds": 2, "poll-interval": 30, "poll-timeout": 1800,
  "max-concurrent": 2
}
```

| 键(=flag 去 `--`) | 默认 | 说明 |
| --- | --- | --- |
| models / provider / model | 演示剧本 | 模型网关三件套 |
| repo | 无(纯会话演练) | 内核模式的目标仓 |
| platform / fake-platform | 无 | 交付平台地址 / 本地假件 |
| luban / luban-header | 假小鲁班 | 通知端点与鉴权头(可重复) |
| pg | 无 | 投影(纯旁路) |
| data / port / web | .tasks / 8787 / web-dist | 现场目录、端口、前端 |
| isolate-image/-volume/-memory/-cpus/-user | 无 | 容器隔离 |
| verify-via-pipeline | false | 免编译形态(需 platform 在场) |
| repair-rounds | 2 | 修复环预算;0=关(红灯留痕请人工) |
| poll-interval / poll-timeout | 10 / 1800(秒) | 流水线轮询节奏与预算 |
| max-concurrent | 2 | 并发任务数 |
| compact-every | 150 | 主动压缩节奏(事件数;0=关) |
| desktop-notify | false | 单机手感的桌面弹窗 |

**刻意不可配的**(这些不是缺口,是立场):判定逻辑与证据标准(内核
唯一权威);fail-open 与预算上限的**存在性**(数值可调,"无限等待"这个
取值不存在);ASKUSER 人工闸;`MAE_FLOW_HOST`(宿主自动设,不给人配错
的机会)。任务级可配的只有两个:工作流车道(内核 Q2 强制选)与通知
账号——任务表单刻意不膨胀。

## 启动与守护

```bash
MAE_FLOW_HOME=/srv/mae-flow \
MAE_FLOW_ADMIN_USER=admin \
MAE_FLOW_ADMIN_PASSWORD='<从凭证系统注入的初始密码>' \
npm run serve -- --models /etc/mae-flow-cloud/models.json \
  --provider <网关名> --model glm-5.1 \
  --repo <内网仓地址> --platform <MR/流水线网关地址> \
  --pg postgresql://<用户>@<PG地址>/<库名> \
  --data /var/lib/mae-flow-cloud --port 8787
```

(外部演练交付链:去掉 `--platform`,改用 `--fake-platform`——
从 `--repo` 灌裸仓当远端,推送/MR/流水线全环回。)

- **`--pg` 是投影不是真相**:不配它一切照旧(文件即真相);配了它
  写失败也不影响流程(fail-open,页面只多一条投影失败日志)。建表
  自动幂等;重启后 recover() 会以现场文件为源把投影补齐,PG 里的
  数据可整库重建——备份优先级远低于数据目录。
- **数据目录就是命根**:task.json / waiting.json / events.jsonl /
  transcript.jsonl / auth.json / 仓库克隆(内核状态文件在里面)全在 `--data` 下。
  备份它=备份一切;丢它=任务从头来。
- **本地登录**:正式模式首次启动必须提供 `MAE_FLOW_ADMIN_PASSWORD`
  (至少 10 个字符),可用 `MAE_FLOW_ADMIN_USER` 指定初始管理员账号。
  之后由管理员在页面创建成员。`auth.json` 只保存 scrypt 加盐哈希且权限
  为 `0600`;会话只驻进程内,8 小时过期,重启后全部重新登录。开发成员可
  查看全团队任务,但只能创建到自己名下并处理自己的审批/重跑;管理员可
  操作全部任务。对外提供页面时必须由反向代理终止 HTTPS,并传递
  `X-Forwarded-Proto: https`,服务会据此给会话 Cookie 加 `Secure`。
- **桌面通知默认关**:内核默认会在"需要裁决/进入新阶段"时弹系统通知,
  那是为"人坐在终端旁"的单机场景设计的;服务里同时跑几单就弹几倍,而且
  弹在服务器上没人看——真正的送达通道是待办页与小鲁班。serve 启动即
  置 `MAE_FLOW_NO_NOTIFY=1`,要单机手感就加 `--desktop-notify`。
  (已在跑的任务想立刻静音,不必重启:在该任务的仓库克隆里写
  `.mae-flow-defaults.json` → `{"桌面通知": false}`,内核每次调用现读现判;
  记得同时写进 `.git/info/exclude`,别让它混进未提交改动。)
- **重启语义(已实现并有测试)**:进程可死任务不死。启动时 `recover()`
  重建索引;崩溃时在跑的任务重新入队,以内核 current 为锚重建会话续跑;
  等人的任务原地挂起,决定到来走重建会话。演示模式(无 `--models`)
  每次清场,真模型模式永不自动清数据。
- **容器隔离(强烈建议内网开启)**:`--isolate-image <构建镜像>`
  后模型的 bash 命令进任务专属容器执行(会话/门禁/内核留宿主,
  工作区同路径挂载)。镜像按试点仓选并需包含 python3 + git +
  构建链(Java 例:maven + JDK + python3,参考 mfc-java-pilot 的
  Dockerfile 形状);`--isolate-volume ~/.m2:/root/.m2` 挂构建缓存;
  `--isolate-memory 4g --isolate-cpus 2` 限额;
  `--isolate-user $(id -u):$(id -g)` 防挂载卷文件属主漂移。
  教训(run7 实锤):宿主没有构建链时,模型会自己发明 docker 包裹
  命令拿到真实绿灯,但内核台账铁面拒收(命令与任务卡不符)——
  环境必须由部署侧给足,不能指望模型绕。
- 守护用 systemd `Restart=on-failure` 即可,恢复逻辑在服务内部。
  单元文件样例:

  ```ini
  [Unit]
  Description=mae-flow-cloud
  After=network.target docker.service

  [Service]
  WorkingDirectory=/srv/mae-flow-cloud
  Environment=MAE_FLOW_HOME=/srv/mae-flow
  Environment=MAE_FLOW_ADMIN_USER=admin
  EnvironmentFile=/etc/mae-flow-cloud/secrets.env
  ExecStart=/usr/bin/npm run serve -- \
    --models /etc/mae-flow-cloud/models.json \
    --provider <网关名> --model glm-5.1 \
    --repo <内网仓地址> --platform <MR/流水线网关地址> \
    --pg postgresql://<用户>@<PG地址>/<库名> \
    --isolate-image <构建镜像> --isolate-volume /var/cache/m2:/root/.m2 \
    --data /var/lib/mae-flow-cloud --port 8787
  Restart=on-failure
  RestartSec=3

  [Install]
  WantedBy=multi-user.target
  ```
  `secrets.env` 至少包含 `MAE_FLOW_ADMIN_PASSWORD=...`,权限设为 `0600`,
  不要把密码直接写进单元文件或仓库。账号库已存在后不会重复创建管理员。
- 环回代理教训(外部踩过三次):如果服务器有全局代理,
  确认 `NO_PROXY=127.0.0.1,localhost`(代码里 `ensureLoopbackDirect()`
  已兜底,但 curl 排障时记得 `--noproxy '*'`)。

## 上线自查清单(按序)

可执行版:`harness/preflight.sh --java-repo <试点仓> --models <models.json> --provider <网关名>`
——1~4 项自动核验真实退出码,5/6 两项人工,脚本会原样提醒。

0. **先验两个 CLI**(部署形态由此定,顺序不能换):
   - MR/流水线 CLI 三能力逐一实测:交 MR、按 SHA 查状态、**拉失败日志**
     ——第 3 项拉不到,免编译形态(--verify-via-pipeline)不成立,
     回容器编译形态;
   - 通知 CLI 发一条真消息@到人(失败只标红不阻流程,但要验真投得到);
1. 容器内 `mvn compile && mvn test` 真实退出码 0
   (--verify-via-pipeline 形态跳过本项,以第 5 项流水线真实跑过
   compile+test 且结果绑 SHA 代替);
2. `npm test` 全绿(17 项,含恢复/并发/交付三条路);
3. `npm run probe` 九项事实全绿(内核裁判在场);
4. 网关连通:发一个最小任务,确认首回合不是空转
   (429/网关错误会如实落 failed + detail,不会假 completed);
5. 一单真需求走到 `await_merge`,MR 出现在真平台上;
   顺带演练修复环:故意让流水线红一次,确认修复会话拿到失败日志、
   推新提交、新流水线绑新 SHA(而不是旧 SHA 的旧绿灯);
6. 杀进程重启,确认等待中的任务还在、决定后能续跑
   (可执行演练:`harness/restart-drill.sh`——真 kill -9 真 HTTP,
   全绿即过;上线机器上跑一遍)。

## 监控与排障

- 页面 `GET /`:任务状态说人话;通知失败红条;MR 链接。
- `GET /tasks/:id/events`(SSE):语义事件实时镜像。
- `GET /tasks/:id/actions`:外部动作台账(MR/流水线,含幂等键与
  绑定 SHA)——恢复时"先查远端真实状态"的对账入口;需配 `--pg`。
- `GET /history`:任务摘要投影的历史列表(按最近更新倒序)——
  数据目录清理或换机后,历史看板/审计从这里查;需配 `--pg`。
- 任务 detail 字段:失败原因原文(含网关 429 的重置时间)。
- 内核侧真相:任务克隆目录 `.mae-flow.json`(current/config)与
  `.mae-flow-work/panel.html`(现场面板)。
- 疑难对拍:transcript.jsonl 是语言中立契约,
  `harness/verify_transcript.py` 可独立裁决证据链。
