# 内网部署手册(准备件——外部完全就绪才执行)

> 原则(用户拍板):**外部完全就绪才部署内网;需要内网能力就模拟。**
> 本文是"真件就绪=换地址"的可执行版:每个假件对应一个配置点,
> 语义契约不随部署改变——契约写在各自的测试里,换真件后测试仍然是裁判。

## 机器前置

| 依赖 | 版本/说明 |
| --- | --- |
| Node.js | ≥ 20(`tsx` 直跑 TS,无构建步) |
| Python 3 | ≥ 3.10,mae-flow 内核的运行时 |
| mae-flow 内核 | **不用单独准备**:快照收编在 `kernel/`,ZIP 下载也带着(是普通目录不是 submodule,`.gitattributes` 也没有 export-ignore)。开发机想用活内核就设 `MAE_FLOW_HOME` |
| Git | 任务克隆/推分支/ls-remote 都用它 |
| JDK + Maven | 试点仓(Java)编译验证用;版本按试点仓 `pom.xml` 要求。**--verify-via-pipeline 形态不需要**(docker 同) |
| npm 依赖 | `npm ci`(pi 锁 0.84.1,升级必须重跑 probe+全套测试再拍板)。**进内网前先验这一步能不能过**,见下 |

#### 离线/内网装依赖:进场前先验,别到现场才发现

代码可以靠 ZIP 带进去(内核快照在里面),但 `node_modules` **不在仓里**,
必须能装出来。要装的东西:运行时 `@earendil-works/pi-coding-agent@0.84.1`、
`pg`、`typebox`;开发 `tsx`、`typescript`;前端 `web/` 那套(react+vite)。

风险点是 `@earendil-works/pi-coding-agent` 未必在内网 npm 镜像里,而
**`tsx` 是零构建的命门**——它依赖 esbuild,那是**平台专属二进制**。

三种情况,进场前先确认走哪条:

1. **内网源装得到** → 解开 ZIP,`npm ci` 完事,最省事;
2. **装不到** → 找一台能上网的 **Linux x64** 机器(WSL 也行)跑 `npm install`,
   把整个 `node_modules` 打包带进去。**不能从 macOS 拷**——esbuild 装的是
   `@esbuild/darwin-arm64`,Linux 认不了这个二进制;
3. 完全离线 → 外网机 `npm pack` 出全集离线安装,能走前两条就别走这条。

**这一步没过,后面全部免谈**——比内核快照的风险大得多,建议进内网前一天
就在能连外网的机器上试一次。

### WSL 实战速记(2026-08-17 首跑用)

**集成产品形态:一个 clone 就是全部**——内核快照收编在 `kernel/`
(harness/sync-kernel.sh 维护,serve 自动发现:MAE_FLOW_HOME >
../mae-flow > kernel/),不用再单独 clone 内核仓。

1. **一切放 WSL 自己的 ext4**(`~/` 下)。`/mnt/c` 是 9p,chmod 600
   不可靠(密钥文件纪律会破)且慢一个量级;
2. **代理**:内网 git/模型网关/CodeHub 域名全部进 `no_proxy`,
   不然撞代理(外部实测 502 就是这么来的);
3. 装机:Node≥20 + python3 + git;`git clone <mae-flow-cloud>` →
   `npm ci` → `cd web && npm install && npm run build`(dist 不进仓);
   **不装 JDK/docker**——免编译形态流水线是唯一裁判。**不隔离=显式
   选择**,边界要认:agent 与服务同用户跑,auth.json(全体用户令牌
   明文)理论上对它可读、越界写无强制墙——单人自用+单任务+人盯着
   可接受;**转多人共用前容器隔离升回必选**(WSL2 装 docker 无障碍);
4. **最小启动(界面优先形态,用户拍板"参数该在界面配")**:
   ```bash
   MAE_FLOW_ADMIN_PASSWORD='<至少10位>' \
   npm run serve -- --data ~/mfc-data --port 8787   # tmux 里
   ```
   然后 Windows 浏览器开 `localhost:8787`,管理页配齐模型网关和
   并发数；个人页配 Git 令牌+邮箱。MR/流水线服务在部署配置中固定
   注入，管理员只看部署自检结果。正式部署在
   启动命令中加 `--kernel-mode`，代码仓由每个任务发起时明确填写。
   注意:模型网关没配之前是演示模式(剧本假模型)。演示模式**不会**
   动你的数据——要白纸起步得显式加 `--fresh`(它会先数出要删掉几个
   任务现场再删)。老版本是每次启动静默清空,踩过一次真单蒸发;
5. 适配层:填 adapter.json(codehubcli 命令模板)→ `npm run adapter
   -- --config adapter.json`(tmux)→ `curl http://127.0.0.1:8790/`
   → 三端点各手动打一发核对 → 平台地址填进管理页;
5b. **内部 CLI 只有 Windows 版也不怕**,两条路:①(首选)WSL 互操作
   直接调 .exe——命令模板写 `/mnt/c/.../codehubcli.exe`,其余不变,
   .exe 走 Windows 侧网络栈,公司代理/VPN 白捡;先验
   `/mnt/c/Windows/System32/cmd.exe /c echo hi` 确认互操作开着。
   ②(兜底)适配层零依赖纯 Node,整个搬去 Windows 原生跑,管理页
   平台地址填 `http://<Windows侧地址>:8790`(Win11 镜像网络
   localhost 互通,老模式用主机 IP)。CLI 输出的 \r\n 已归一化。
   个人令牌 push 走 WSL 的 git,与 CLI 无关;
6. 首跑验收(诚实清单口径):推送身份、commit 归属头像、MR 发起人
   **三个都是本人**;CodeHub token 是否兼任 HTTPS push 凭据;
   失败日志是否每个 stage 各留一段摘要(分诊的口粮);
7. Windows 浏览器访问 `localhost:8787`(WSL2 自动转发);不通再用
   WSL IP(`hostname -I`)。

### 暴露给内网同事(WSL 里的服务,别人怎么访问)

服务默认只听 `127.0.0.1`——不声明就不上网是姿态。要给同事用,三步:

1. **serve 加 `--host 0.0.0.0`**(适配层**不要**跟着放开:它拿着服务
   令牌执行 CLI,保持默认回环,只给本机宿主调);
2. **打通 Windows → WSL**,二选一:
   - **镜像网络(Win11 22H2+,首选)**:`C:\Users\<你>\.wslconfig` 写
     `[wsl2]` + `networkingMode=mirrored`,`wsl --shutdown` 重进——
     WSL 直接共享 Windows 网卡,第 3 步做完即通;
   - **NAT 模式(默认)**:管理员 PowerShell 做端口转发
     (WSL IP 用 `wsl hostname -I` 取,重启会变,写成开机脚本):
     ```powershell
     netsh interface portproxy add v4tov4 listenport=8787 `
       listenaddress=0.0.0.0 connectport=8787 connectaddress=<WSL_IP>
     ```
3. **Windows 防火墙放行入站 8787**(管理员 PowerShell):
   ```powershell
   New-NetFirewallRule -DisplayName "mae-flow-cloud" -Direction Inbound `
     -LocalPort 8787 -Protocol TCP -Action Allow
   ```

同事访问 `http://<你的 Windows 内网 IP>:8787`(`ipconfig` 看 IPv4;
公司 AD 环境通常也能用 `http://<机器名>:8787`)。账号由你在「账号
管理」页创建,每人配自己的 Git 令牌,任务身份互不掺和。

要认的两条边界:**内网是明文 http**,会话 cookie 可被同网段嗅探——
试用可接受,转正式部署套反代 TLS;**工作机合盖=全员断线**,它是
工作站不是服务器,多人依赖后尽快挪到常驻机器(顺带把容器隔离升回
必选,见"不隔离部署的边界")。

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

**适配层骨架已就位:`npm run adapter -- --config adapter.json`**
(src/platformAdapter.ts,零依赖零构建)。进内网当天只填配置文件里的
codehubcli 命令行,代码零改动。配置形状(权限 600,文件头注释里有
完整示例):每个端点一条 argv 命令模板(占位符 `{repo} {source_branch}
{target_branch} {title} {sha} {token} {git_username}`,不过 shell,
标题带空格/注入都不是问题)+ 输出抽取(`{"json": "data.web_url"}` 点路径
/ `{"regex": "..."}` 首个捕获组 / `{"const": "running"}` 固定值)+
状态映射表(`{"SUCCESS": "success", ...}`)。纪律内置:CLI 超时预算
(默认 60s)、**未映射状态 502 拒绝猜**(猜 running 白轮询、猜 failed
白烧修复)、CLI 非零退出带 stderr 上浮、令牌不落日志、配置坏拒启。

**个人身份头**:宿主每个平台请求带 `x-mfc-git-token`/`x-mfc-git-user`
(percent 编码;任务归属人的个人令牌,来自「我的工作」页配置)。
适配层的 `{token}` 优先取它——**MR 发起人=本人**;没带头回落配置里的
`token`/`token_file`(服务账号)。令牌只走请求头不走请求体:请求体
会被外部动作台账原样记进 PG 投影,头不会。

自研适配层(不用骨架)时,契约同样是下面三个端点。宿主只读这些字段,
多余字段一律忽略;状态机、修复环、轮询一行不改:

| 端点 | 请求 | 宿主消费的响应字段 |
|---|---|---|
| `POST /mr` | `{repo, source_branch, target_branch, title}` | `{url}`(MR 链接,展示用)`, id?`(iid,门禁/讨论查询带回) |
| `POST /pipeline/trigger` | `{repo, sha}` | `{status: "success"\|"failed"\|"running", log?}` |
| `GET /pipeline/status?sha=<sha>&repo=<url>` | — | `{runs: [{status, log?}]}`(取最后一个终态 run) |

MR 闭环的可选端点(mr_gates/mr_discussions/discussion_reply/
pipeline_artifacts,不配=404=宿主按纯流水线旧语义)与按能力核对报告
钉出来的 adapter.json 参考填法(mergeable_state 平铺布尔、先查后建、
两步回复/解决、MCP 日志桥),见 **docs/mr-loop-adaptation.md §3/§11**。
检视回复默认只回复不代点"已解决"(报告 D3:resolve 归检视人);
团队明确允许代点的部署,serve 加 `--resolve-discussions` 且适配层配
`discussion_resolve`。

- `repo` = 这一单的交付仓地址(任务级可选,缺省=部署仓)。单仓部署的
  适配层/假件可以忽略它;多仓时靠它路由到对的 CodeHub 仓;
- **内部平台是 CodeHub(类比 GitHub)**:codehubcli 配一个从 CodeHub
  申请的 token 即可做 MR 等操作。对接两件事:① 适配层调 CLI 时应带
  **任务归属人的个人令牌**(auth.gitCredential 那份),MR 发起人才是
  本人,没配的回落服务账号;② **同一个 token 兼任 push 凭据已由能力
  核对报告 D2 证实**(2026-08-17),但既有框架的用法是
  `https://oauth2:{token}@<host>`——**凭据用户名固定写 `oauth2`**,
  不是平台账号名;试点首推若 401,先把用户名换成 oauth2 试(报告里
  push 本身被代理 504 挡住没走通,这条是试点必验第 1 项,见
  docs/mr-loop-adaptation.md §11);
- `log` = 失败详情原文(修复 agent 只看前 2000 字,适配层自行截断);
  **多类问题并发时每个失败 stage 各留一段摘要**——修复会话按它分诊,
  只给第一个 stage 塞满 2000 字会让其余问题类别漏诊;
- 平台若只有"触发后异步跑",trigger 返回 `running` 即可,宿主轮询收敛;
- 轮询旋钮:`pollIntervalMs` 默认 10 秒(内网建议 30~60 秒,看 CLI 开销),
  `pollTimeoutMs` 默认 30 分钟,耗尽如实留痕请人工——绝不无限等。
- 没选 webhook 的原因:要求平台能回调进来(防火墙/注册都是部署项),
  假件难模拟,重启后回调丢了仍要轮询兜底——等于养两套。真有需要时
  webhook 可后加,轮询留作兜底,语义不变。

### 通知:小鲁班怎么接(2026-08-18 内网实测通,端到端收到消息)

契约不变:投递失败不改流程状态、按 waiting_id 幂等、有限退避。

小鲁班是**普通 HTTP 接口,不是 MCP**:

| 项 | 值 |
|---|---|
| URL | `http://xiaoluban.rnd.huawei.com:80/`(**要绕代理**) |
| 方法 | POST JSON |
| 请求体 | `{"content": "正文", "receiver": "首字母+工号", "auth": "<token>"}` |
| 鉴权 | **body 里的 `auth` 字段**,不是 Authorization 头 |
| 正文 | 纯文本 + 部分 HTML(`<span style=...>`、表格、emoji) |
| 成功 | `{"status":"ok"}` |

宿主的 Notifier 发的是 `{account, text, link}`(见 `src/notifier.ts`),
形状对不上——**中间放一个几十行的桥**(与 MR 适配层同一思路:形状翻译
是配置产物,不改宿主代码):

```bash
# 桥:监听 127.0.0.1:8791,收 {account,text,link} → 发 {content,receiver,auth}
#     content = text + "\n" + link;auth 从 0600 的 token 文件读;不走代理
python3 /etc/mae-flow-cloud/luban-bridge.py --port 8791 &
npm run serve -- ... --luban http://127.0.0.1:8791
```

为什么不让宿主直接发:`auth` 进请求体是那家接口的特例,而本仓的密钥
纪律是**令牌只走请求头**(请求体会被外部动作台账原样记进投影)。桥
把这个特例关在外面,宿主一行不改、台账里也不会出现令牌。

早先设想的"小鲁班 MCP / 拉群 CLI 艾特"两条候选就此作废——真件是
上面这个 HTTP 接口,已实测送达。

## 流水线修复环(全绿是最终目标)

红灯不再是终点:宿主小状态机(`delivery.loop` 记账)派**专职修复会话**
拿失败日志修复、推新提交、触发新流水线,循环直到绿。**默认不限轮**
(用户拍板:"不该有最大轮数限制,都该尽力修好");`repairRounds` 从
默认值降级为可配手刹(数字=上限,0=关,三层覆盖:任务>设置>部署)。

不限轮不等于无脑 loop,收敛靠三道刹车:
- **同 SHA 不二修**:修复会话没产生新提交即停——会话自己判了
  "改代码解决不了",它的收口发言当**诊断**(缺什么、去哪配、配好怎么
  重跑)带进任务详情、环账(`loop.diagnosis`)和小鲁班通知,主动喊人;
- **原地打转必须转向**:第 2 轮起使命附带上一轮失败详情,与本轮同一处
  打转=上轮改法无效,必须换思路,换不动就走诊断出口(提示词纪律);
- 全部等待走宿主轮询预算,单轮资源永远有界。

修复会话的使命是"分诊台":先通读日志列出**全部**问题类别(编译报错/
编译告警/UT 失败/UT 覆盖率/CodeCheck/其他);**分诊之后、动手之前先
定位**——每类问题落到具体文件与函数/用例,并写明依据(日志哪一行、
堆栈哪一帧、覆盖率报告哪个类),说不出依据就是还没定位到,不许凭猜
改(Agentless 的实证:定位→修复→验证的固定管线比自由 loop 更省);
按类修复、能派专职子 agent 的派专职(编译类/UT 类/检视类各修各的,
定位结果随派单一起交过去);纪律写死:补覆盖率写
真测试不许凑数、CodeCheck 修问题不许加抑制、告警要消除不是关闭;
**全部修完凑一次提交、收尾一次 push**——远端每收到一次 push 就烧一整
条流水线,中途绝不 push(用户原则:一次修全,大幅降低流水线重跑)。
不是本仓代码能修的(外部平台配置如 yaml、权限、环境)不硬改,出诊断。

修复本身是纯提示词;宿主只做等待、事实(绑 SHA)、刹车三件提示词
干不了的事。内网需要确认:失败日志的截断策略——**多类问题并发时,
每个失败 stage 都要在 `log` 里留一段摘要**(分诊的原料),不能只给
第一个 stage 塞满 2000 字。

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
      "models": [{ "id": "glm-5.1", "contextWindow": 160000 }]
    }
  }
}
```

**提交信息:先搞清楚谁在管,别配出互相打架的规矩**

两层校验,**业务提交这两层是兼容的,不用额外配**:

- **内核(权威)**:`guard/safety_kernel.py` 硬门禁——业务提交必须
  `[<单号>][feat|fix]描述`,不合规连 commit 都做不成(不是事后拒收);
- **平台 pre-receive 钩子**:正则
  `(^(\[\w+\])(\[(feat|fix|refactor|test|chore|docs|style)\])\s*\S+)|(…)`,
  不合规**拒收 push**(2026-08-18 内网实测原文:`Deny by project hooks
  setting 'default': message of commit '…' does not match the
  regular-expression …`)。

内核那条是平台那条的**真子集**(`REQ…` 命中 `\w+`,`feat|fix` 在平台
类型表内),所以走流程的业务提交天然合规。实测那次被拒的是手工搓的
测试提交(`push verification from mae-flow pilot`),没走内核。

**`--commit-convention` 什么时候才用**:平台钩子有内核管不到的额外
要求时——比如**合并提交**(冲突修复会产生 `Merge branch …`,由宿主
直接推送,不经内核门禁)、revert、或本仓要求带模块前缀。配的时候
**必须与内核规则一致**,只做补充不做改写:

```bash
# 反例(会打架):--commit-convention '[模块][类型] 一句话'
#   → agent 写成 [access][fix]…,内核门禁当场 block(单号对不上)
npm run serve -- ... --commit-convention '业务提交按内核要求写
[单号][feat|fix]描述(如 [REQ2026081401][fix]修复空指针);
合并提交保留默认 Merge 信息即可'
```

这项属于部署级兼容开关，不在管理页维护。通常应由内核和仓库中的
`AGENTS.md` 统一约束；只有平台存在内核覆盖不到的额外钩子时才使用。

**钩子正则全文**(2026-08-18 内网实测取回,五个分支):

```
(^(\[\w+\])(\[(feat|fix|refactor|test|chore|docs|style)\])\s*\S+)
|(^(Merge remote-tracking branch '.+' into \w+))
|(^(merge '.+' into '.+'))
|(^(Merge branch '.+' of .+ into .+))
|(^(Merge branch '.+' of .+))
```

对我们的三条推论:

- 业务提交:内核要求的 `[单号][feat|fix]描述` 命中第 1 分支,天然过;
- **合并提交:必须 merge 远程跟踪分支**。宿主的冲突修复本来就是
  `git merge --no-edit origin/<目标分支>`,产生的
  `Merge remote-tracking branch 'origin/master' into <分支>` 命中第 2
  分支;若改成 merge 本地分支,信息会变成 `Merge branch 'master' into
  <分支>`——**五个分支一个都不匹配,推送会被拒**。测试已把这个形状钉住;
- revert 不放行(`Revert "..."` 五条都不匹配)。本仓不做 revert,无影响;
  真要 revert 得改项目 hook 配置。

**`contextWindow` 必填(内网实测的坑)**:内网网关的真实上限是
169984 token,超了直接 400——
`input too long, exceed max input length, max input length is 169984,
current input length is 171308`。pi 的自动压缩按它自己估的窗口触发,
估大了就撞墙。**按网关真实上限留出余量声明**(169984 → 写 160000,
余量给输出和统计误差),pi 会提前压缩,根本不撞。没声明时 serve 启动
会提醒一句。

撞上了也不会当场死:宿主有一次压缩自愈(按内核现场压缩后原样重发,
该轮零活动所以不会重做已完成的事),**只补救一次**——压完还爆说明是
单轮输入本身过大(把大文件/长日志整段塞进了会话),那时如实失败并
把这句话写进任务详情。

## 团队的 UT skill 怎么进云端(部署放一次,不用再手动集成)

老宿主(Claude Code)的做法是:内核派 `ut-generator` 子 agent,你**每次
手动**把内网那两个 UT skill 集成进那个子 agent。云端**同样有子 agent**
(`Task` 工具派出的是另一个 pi 会话,独立上下文,只回一份最终报告),
但 skill 不会自动跟过去——pi 的资源装载默认是关的,而且 skill 在内网、
不在仓里。

所以给了它一个固定的家:

```
<数据目录>/skills/<skill 名>/SKILL.md      # 例:~/mfc-data/skills/java-autout/SKILL.md
```

放一次,**之后每个任务的会话都自动带上**(服务日志会打印装载了哪些目录,
可核对),内核派出的子 Agent 也一并带上——它们和主会话同一套装配。
交付仓里的 `.pi/skills/` 与 `.claude/skills/` 也会被一起装载,愿意让
skill 随仓走、众筹修改的话用这条。

两件要知道的事:

- pi 不提供"调用 Skill 工具"这个通道,它把 SKILL.md **注进系统提示**让
  模型读。所以内核在云端形态下不再要求"transcript 里必须有 Skill 调用"
  这类证据(否则永远等不到,死循环);
- skill 里"编译通过""执行构建/运行测试"那类段落在云端做不到,任务卡
  已明说**跳过这些段落、其余照写**。你也可以在收编时把那几段删掉,
  两种做法都行,不删也不会卡住流程。

`build-fix` 这类纯构建 skill 云端用不上(本机不编译),不必收编。

### 收编时顺手改这几处(省轮次,不是保命)

内核已经不要求本地编译/运行的证据了,所以下面这些不改也**不会卡死**;
不改的代价是模型照着 skill 去试一把、撞一次"命令不存在",白烧一两轮。

**最值钱的一处:把 `description` 写准。** pi 只把每个 skill 的
`name`/`description`/路径注进系统提示,**正文要模型自己决定去读**。
描述写成"UT 生成规范"模型未必点得开;写成"写 Java 单测时的命名、分层、
断言与 mock 口径;新增/修改测试前必读"就会。这一条决定 skill 到底有没有
被用上,比删几段编译文案重要得多。

**该删或改写的:**
- "编译通过后再提交""先跑一遍 mvn/mcde 确认"→ 改成"写完即交,编译与
  运行由流水线裁决";
- "调用 build-fix / 某某 Skill"这类**互相调用**的写法(云端没有 Skill
  工具通道,调不动);
- 引用内网工具路径、IDE 操作、本机脚本的段落——那台机器上没有。

**务必留着的(这些才是价值):** 测试命名与目录规范、分层与粒度口径、
断言写法、mock/桩的约定、覆盖率算法与豁免规则、本仓踩过的坑。

改完不必重启服务:skill 在每次开会话时装载,下一个任务就生效。

## 会话开场自带的两样东西(不用配,零依赖)

内核模式下每次会话(首跑/修复/重建)开场白里会多两块材料。它们是
**上下文材料不是判定**:错了顶多慢,不影响门禁裁决,任何一步炸了
就不上桌,任务照跑。

1. **仓库地图**:按"被引用扇入"排序的文件+符号清单,让模型在大仓里
   先看骨架再找代码,不用全仓乱 grep。正则近似(不引 tree-sitter,
   内网 WSL 上原生构建是负担),带三道预算帽(1500 文件/单文件
   200KB/3 秒)与 12000 字符输出帽,超了在地图尾部明说截断。
   **无需配置**,也没有开关——地图为空时它自己不出现。
2. **知识块**:交付仓里的 `.mae-flow/knowledge/*.md`,命中触发词才
   注入。知识跟着仓走,平台不做知识库、不做配置面——换个仓就是换套
   知识。格式:

   ```markdown
   ---
   triggers: 覆盖率, coverage, jacoco
   ---
   覆盖率补齐要写真断言;本仓禁止用 @Generated 排除类。
   ```

   - `triggers` 为空或整个头部缺失 = **常驻知识**(每次都注入),
     团队通用规范放这类,不用硬编一个假触发词;
   - 匹配语料 = 需求原文 + **本轮流水线失败详情**:所以红灯日志里
     出现"覆盖率"时,上面这篇会自动到修复会话手上;
   - 大小写不敏感、按子串匹配(中文没有词边界),宁可多注入一篇也
     不漏;注入总量 8000 字符封顶,超了明说截断。

   建议起手就放两三篇:本仓的构建/测试怪癖、CodeCheck 的历史包袱、
   哪些目录碰不得。这是团队经验沉淀的地方,人人可提 MR 补充。

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
  "poll-interval": 30, "poll-timeout": 1800,
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
| repair-rounds | 不限 | 修复环手刹:数字=上限,0=关;不配=修到绿/出诊断为止 |
| poll-interval / poll-timeout | 10 / 1800(秒) | 流水线轮询节奏与预算 |
| max-concurrent | 2 | 并发任务数 |
| compact-every | 150 | 主动压缩节奏(事件数;0=关) |
| desktop-notify | false | 单机手感的桌面弹窗 |

### 部署配置之上还有一层:管理页运行时设置

管理员登录 Web 后左侧「服务设置」页,可热改两类东西(存
`<data>/settings.json`,权限 600,**压过部署值**):

- **运行参数**:并发数、修复轮预算、轮询间隔/预算。生效边界如实:
  并发=下一次调度,修复轮/轮询=下一次红灯/下一轮轮询;页面直接显示
  当前服务默认值，留空即使用默认值，不要求管理员猜启动参数。
- **模型网关**:网关地址、API Key、模型名称三项；服务端转换为任务
  运行时需要的配置，不在界面暴露 JSON/provider 概念。
  生效于下一个新会话,在跑的会话不换血。

小鲁班投递端点属于部署基础设施，只能通过部署配置维护；每位成员在
「个人设置」中填写自己的小鲁班发送 Token。普通任务提醒发给本人；
主动邀请检视时，用任务责任人的 Token 发给所选 Committer 工号，
收件人无需配置 Token。管理页不再维护团队共享密钥。

通知中的任务链接不得使用 `127.0.0.1`。平台默认从浏览器 `Origin`
自动取得用户实际访问的内网域名/负载均衡地址；没有 Origin 时再回落到
反代的 `X-Forwarded-Host/Proto` 和请求 Host，不需要硬编码机器 IP。
只有多入口必须统一出口等特殊部署，才在启动参数或配置文件中设置可选的
`--public-url http://<稳定内网域名>:8787`，它的优先级最高。
MR/流水线服务同样是部署基础设施，管理页仅通过「部署自检」显示链路
是否可用，不展示内部地址，也不允许运行时覆盖。

两种失败语义是刻意分开的:`--config` 坏了**拒绝启动**(部署形态残缺
比不起服害人);`settings.json` 坏了**按无覆盖处理**并记日志(它是
旁路覆盖,不许挡服务)。密钥纪律:**只写不读**——界面与 API 永远只
给掩码(••••末4位),明文只存在于 600 权限的文件里,不落日志。

### 个人 Git 令牌(每用户,「我的工作」页配置)

开发成员在自己的工作台配平台访问令牌(PAT)+ 平台用户名(默认=登录
账号),之后**这个人的任务**以他的身份 clone/push;没配的用户走服务
级访问方式(服务账号 helper / 开放内网)。机制与纪律:

- 注入走 **credential helper**:明文凭据(0600)与只答 `get` 的脚本
  (0700)放任务的 pi-agent 目录,`.git/config` 只记脚本路径——
  **明文永不进 config、永不拼进远端 URL**(拼 URL 会原样留在
  config 里等着被 cat 出来);
- 注入时先**清空继承的 helper 列表**再登记我们的脚本:git 会对列表里
  所有 helper 广播 store,不清的话令牌会被系统钥匙串之流顺手存走
  (macOS 实测中招);
- clone 一律 `GIT_TERMINAL_PROMPT=0`:子进程没有终端,缺凭据就地
  失败、错误如实上浮,绝不挂死等密码(不卡死红线);
- 生效边界=下一次任务启动/会话重建;在跑的任务不换凭据;
- 存储在 auth.json(0600):密码是哈希,令牌必须明文(git 要用原文),
  所以只许住这份 600 文件;界面与 API 只见 ••••末4位;
- **commit 署名与推送鉴权是两码事**:令牌只管 push 过门禁,"commit
  是谁的"平台按 commit email 认。表单里的平台用户名/邮箱会写进克隆的
  `user.name`/`user.email`;邮箱没填则 commit 归属可能认不到人,界面
  有提示。MR 发起人是第三码事,归适配层带个人令牌解决(见适配层契约)。

**刻意不可配的**(这些不是缺口,是立场):判定逻辑与证据标准(内核
唯一权威);fail-open 与预算上限的**存在性**(数值可调,"无限等待"这个
取值不存在);ASKUSER 人工闸;`MAE_FLOW_HOST`(宿主自动设,不给人配错
的机会)。任务级可配的收在四个:**交付方式**(下单就选——用户拍板
"不让 agent 来问";选项**现读内核 `flow/flow.json` 的 workflow_select**
:完整开发 / 已定位问题修复 / 局部修改 / 处理评审意见,宿主一个字都
不另造;内核仍举卡,宿主拿预选答案自动交卷,对不上就退回真等人)、
通知账号、**交付代码仓**(必填,本部署不设默认仓;URL 不许带账号
密码,鉴权走个人令牌;MR/流水线请求带 repo 字段给适配层)、修复轮
预算(0=本单关修复环)——都记在任务上重启不漂移。模型不在其列:
管理员统一配一个,表单只显示"这单用谁跑"。

**月光模式(免审批,每用户开关)**:默认关;「我的工作」身份栏随时
开/关。开着时本人任务的人工节点由系统代答直行(答复写明"用户预授权
放行,按最稳妥判断继续,理由供事后复盘"),且对已经在等的卡立刻清场;
关掉后之后的节点恢复审批。代答走人工决定同一条通路——内核台账、
事件、409 竞态语义一字不差,事后复盘有完整记录可查。

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
  等人的任务原地挂起,决定到来走重建会话。**任何模式都不会自动清数据**
  ——清场只在显式 `--fresh` 时发生(且清前把要删的任务数报出来)。
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

可执行版:`harness/preflight.sh --java-repo <试点仓> --models <models.json> --provider <网关名> --adapter http://127.0.0.1:8790`
——1~4.5 项自动核验真实退出码,5/6 两项人工,脚本会原样提醒。
(--adapter 是进场项:适配层起来后加上,冒烟根路径;契约字段的
真对拍走 adapter --selftest,不重复。)

0. **先验两个 CLI**(部署形态由此定,顺序不能换),并确认**流水线含
   静态检查(CodeCheck)stage**——云端不做本地扫描(内核 cloud 宿主
   短路,lightcheck 照常),流水线是它唯一的兜底。
   另:**ut-generator 在内网对应两个具体 skill(用户确认存在,外部
   看不到内容)**——进场后把它们收编进 git,不进平台配置:方法论类
   落内核仓、由 UT 步骤任务卡引用;仓库特有约定落目标仓 docs、
   由仓根 **AGENTS.md** 索引(注意不是 agent.md——pi 与 CC 同款机制,
   只认 AGENTS.md/CLAUDE.md 这几个名字,认出后**进系统提示词每次携带**,
   已实测接线在 CloudSession 的 resource loader 上,零开发)。
   收编前 ut-generator 只有内核步骤卡自带的方法论:
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
