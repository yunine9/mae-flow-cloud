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
| Docker + 统一构建镜像 | 宿主运行 Docker；`deploy/build-image/` 镜像提供 JDK 21/Maven、Node/npm、GCC/G++/CMake/Ninja 等。项目 wrapper/脚本在容器内非交互执行 |
| 最终质量环境 | CodeCheck 与最终编译/UT 结论仍由绑定提交 SHA 的权威流水线提供；流水线不是可选项 |
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
kernel/ > ../mae-flow),不用再单独 clone 内核仓；需要联调活内核时
显式设置 MAE_FLOW_HOME。

1. **一切放 WSL 自己的 ext4**(`~/` 下)。`/mnt/c` 是 9p,chmod 600
   不可靠(密钥文件纪律会破)且慢一个量级;
2. **代理**:内网 git/模型网关/CodeHub 域名全部进 `no_proxy`,
   不然撞代理(外部实测 502 就是这么来的);
3. 装机:Node≥20 + python3 + git + Docker；`git clone <mae-flow-cloud>` →
   `npm ci` → `cd web && npm install && npm run build`(dist 不进仓);
   构建或拉取 `deploy/build-image/` 的统一构建镜像。JDK/Maven、Node/npm、
   C/C++ 工具链不要求装在 Cloud 宿主；代表仓的真实编译与 UT 必须在该
   镜像、同一组缓存/证书/私服挂载下验收。正式内核模式强制
   `--isolate-image`，没有“不隔离继续跑”的生产降级；CodeCheck 仍由
   流水线执行。
4. **最小启动(界面优先形态,用户拍板"参数该在界面配")**:
   ```bash
   MAE_FLOW_ADMIN_PASSWORD='<至少10位>' \
   npm run serve -- --data ~/mfc-data --port 8787   # tmux 里
   ```
   然后 Windows 浏览器开 `localhost:8787`,管理页配齐模型网关和
   并发数；个人页配 Git 令牌+邮箱。MR/流水线服务在部署配置中固定
   注入，管理员只看部署自检结果。正式部署在
   启动命令中加 `--kernel-mode`，代码仓由每个任务发起时明确填写。
   **`--kernel-mode` 必须与 `--platform <网关地址>` 同时给**(本地演练可
   用 `--fake-platform`):每次新 HEAD 在 push 前先由独立 Agent 做服务器
   编译+UT，随后仍会停在 `external_verify` 等权威流水线事实；没有平台
   就没人核销，每一单都会卡在"验证中"。少给这个参数服务会**直接拒绝
   启动**并说明原因，不会
   起一台每单都废的服务。完整正式命令见下文「启动与守护」。
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
工作站不是服务器,多人依赖后尽快挪到常驻机器。内核模式现在强制统一
任务容器，未配置镜像会拒绝启动，不再把多人安全边界留给操作习惯。

**统一任务容器承担所有业务命令**：主 Agent、子 Agent、修复会话及独立
推送前验证 Agent 的 Bash 都使用同一类镜像；宿主只保留控制面、凭据、
clone/push、MR/通知。镜像由 `deploy/build-image/` 构建，包含 JDK 21/
Maven、Node/npm 与 C/C++ 工具链。CodeCheck 仍不装，最终质量结论仍以
绑定提交 SHA 的流水线为准。

## 四个假件 → 真件切换表

| 能力 | 外部假件 | 内网真件切换点 | 语义契约(不变) |
| --- | --- | --- | --- |
| 模型网关 | scriptedModel / bigmodel | `--models` 指向内网网关 models.json | Anthropic Messages + SSE;注意网关是否静默改路由模型 |
| 小鲁班通知 | FakeLubanServer | Notifier `endpoint` + 鉴权头 | 投递失败不改流程状态;有限退避;按 waiting_id 幂等 |
| Git 服务端 | FakeGitPlatform 裸仓 | `--repo` 指向内网仓地址(克隆凭证走 git credential) | 服务端仓是唯一远端真相 |
| MR + 流水线 | FakeGitPlatform HTTP | `delivery.platformUrl` + 鉴权 | MR 按(源→目标)幂等;流水线结果绑 SHA;验证中→等待合入 |

## 内网依赖就两个 CLI(强度刻意不同)

除宿主标准件(git / python3 / node / Docker；正式内核模式强制 Docker)外，
内网新增的外部依赖只有两个内部 CLI:

| | 干什么 | 强度 | 挂了会怎样 |
|---|---|---|---|
| MR/流水线 CLI | 交 MR、按 SHA 查整体状态、可选返回三项 checks、拉失败日志 | **硬依赖**(交付链的裁判入口) | 交付动作失败如实落账(`summary.delivery` 带原因原文),任务停在 verifying 留痕,不假装交付 |
| 通知 CLI(拉群艾特;或小鲁班 HTTP/MCP,三选一) | 事实 → 一条消息@到人 | 软依赖(旁路 fail-open) | 只把 `summary.notify` 标红,流程一步不停 |

### MR/流水线 CLI:严格说是四个能力,后两个都是上线门槛

1. **交 MR**(源分支→目标分支,幂等);
2. **按 SHA 查流水线状态**(结果必须绑提交,旧绿灯不背书新代码);
3. **建议按质量维度返回 Job 结果**：`COMPILE / UT / CODECHECK`
   checks 是可选的诊断增强。订单的 `execution_contract` 已声明整体
   流水线覆盖三项，因此精确 SHA 的总体 `success` 可聚合核销；checks
   一旦明确给出 `failed` / `pending`，更精确事实优先，分别裁为 RED /
   INCOMPLETE。没有逐项 Job 不会永久卡住，但红灯定位粒度会变差;
4. **拉失败日志** ← **进内网第一件要核实的能力**。它是修复 agent 的
   口粮:没有失败日志,修复环退化成瞎修。若内部 CLI 拉不到日志,
   推送前 Agent 虽能复现常规编译/UT，却无法替代流水线里的 CodeCheck、
   专有环境与完整 stage 上下文。退路只能是保留诊断并请人工补齐流水线
   材料，因此失败日志仍是试点上线的硬前置。**先验这一条,再谈部署。**

### 适配层契约(照抄即可实现,字段是代码真实消费的全集)

**适配层骨架已就位:`npm run adapter -- --config adapter.json`**
(src/platformAdapter.ts,零依赖零构建)。进内网当天只填配置文件里的
codehubcli 命令行,代码零改动。配置形状(权限 600,文件头注释里有
完整示例):每个端点一条 argv 命令模板(占位符 `{repo} {source_branch}
{target_branch} {title} {sha} {token} {git_username}`,不过 shell,
标题带空格/注入都不是问题)+ 输出抽取(`{"json": "data.web_url"}` 点路径
/ `{"regex": "..."}` 首个捕获组 / `{"const": "running"}` 固定值)+
状态映射表(`{"SUCCESS": "success", ...}`)。流水线命令另配
可选配置 `checks`（Job 数组点路径）、`check_dimension`、`check_status`，
以及可选的
`check_job`/`check_url`，以及 `check_status_map`；适配层会输出统一的
`{dimension,status,job?,url?}`。纪律内置:CLI 超时预算
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
| `POST /pipeline/trigger` | `{repo, sha}` | `{status: "success"\|"failed"\|"running", log?, checks?}` |
| `GET /pipeline/status?sha=<sha>&repo=<url>&mr=<iid>` | — | `{runs: [{status, log?, checks?}]}`(严格取 `runs.at(-1)` 最新 run；历史终态不得越过最新 running) |
| `GET /pipeline/artifacts?sha=<sha>&repo=<url>&mr=<完整 MR URL>` | — | `{files: [{name, text}]}`(失败材料；与 status 的 `mr` 形状不同) |

可选的终态 `checks` 固定形状如下。`status` 可用
`success/failed/running/pending/canceled/skipped/not_run`；部署适配层负责
把内部平台词映射过来。缺席时总体 `success` + 精确 SHA 按执行契约聚合
核销；存在时逐项事实优先，任何明确失败都不会被总体绿灯盖掉：

```json
{
  "checks": [
    {"dimension": "COMPILE", "status": "success", "job": "compile"},
    {"dimension": "UT", "status": "success", "job": "unit-test"},
    {"dimension": "CODECHECK", "status": "success", "job": "codecheck"}
  ]
}
```

MR 闭环的可选端点(mr_gates/mr_discussions/discussion_reply/
pipeline_artifacts,不配=404=宿主按纯流水线旧语义)与按能力核对报告
钉出来的 adapter.json 参考填法(mergeable_state 平铺布尔、先查后建、
两步回复/解决、MCP 日志桥),见 **docs/mr-loop-adaptation.md §3/§11**。
检视回复默认只回复不代点"已解决"(报告 D3:resolve 归检视人);
团队明确允许代点的部署,serve 加 `--resolve-discussions` 且适配层配
`discussion_resolve`。`discussion_reply` 模板必须引用
`{idempotency_key}` 并把它传给平台支持的幂等请求头/稳定键参数；宿主
同时发送 `Idempotency-Key` 头与 `idempotency_key` JSON 字段。模板吞掉
该键时适配层会 502 fail-closed，回复留在 outbox 等修好配置后重试。

MCP 网关令牌与 CodeHub 项目/个人令牌是两个鉴权域。`{token}`
仍只供 CodeHub REST、`codehub-cli`、push/MR 与已验证的 REST 兼容路；
CodeHub/Build/CodeCCP/CodeCov 等所有 streamable-HTTP MCP 以及 SSE 日志
下载都使用 `mcp-token`。
部署时把可刷新令牌放在 `/etc/mae-flow-cloud/mcp-token`（权限 0600），
并把以下环境传给 adapter 进程：

```bash
MFC_MCP_TOKEN_FILE=/etc/mae-flow-cloud/mcp-token
# 可选：鉴权失效时立即调一次现有刷新脚本（不经 shell）
MFC_MCP_TOKEN_REFRESH_COMMAND=/usr/local/bin/refresh-mcp-token
MFC_MCP_TOKEN_REFRESH_TIMEOUT=15
```

脚本继续每 5 分钟刷新没有问题；采集器会按 mtime 换新 token，鉴权失败
时立即刷新/重试一次，仍失败则退出当前请求。Cloud 会在 3 分钟后
重新取证，不会在 Node HTTP 处理路径里等 3 分钟。如刷新脚本直接改原
文件，建议改为写临时文件后 `rename` 的原子替换，避免读到半个 token。
`MFC_W3TOKEN_FILE` 默认不配：目前没有独立 w3token 的现场证据，代码也
不会把 mcp-token 自动复制到 `w3token` 头。只有某网关后续实测明确要求
时才显式配置，即使指向同一文件也必须有实证。

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

通知**正文**可按部署自定义(值班群口吻、前缀规范等):三个模板键
`luban-template-waiting/-outcome/-review`,`{占位符}` 套值;`/mfc`
激活提示与手机审批指令由代码追加,模板删不掉。词汇表与示例见
[`docs/luban-notification-templates.md`](./luban-notification-templates.md)。

### 手机纯文本审批:小鲁班插件回调

内网 Agent/运维请优先按独立交接单
[`docs/luban-mobile-approval-handoff.md`](./luban-mobile-approval-handoff.md)
执行；本节只保留 Cloud 契约摘要。

这条链与上面的**出站通知**分开:通知负责喊人,插件回调负责把用户在
手机上的明确指令送回 Cloud。它不增加第二套审批状态,最终仍调用
TaskService 的现有 `decide()`，因此 `waiting_id/state_version`、账号归属、
先到决定生效与旧卡失效等纪律完全复用。

Cloud 复用主服务端口，启用后监听：

```text
POST /integrations/luban/plugin
```

先创建一个随机回调 Token 并限制权限，再配置路径：

```bash
umask 077
openssl rand -hex 32 > /etc/mae-flow-cloud/luban-plugin.token
# serve.json: "luban-plugin-token-file": "/etc/mae-flow-cloud/luban-plugin.token"
```

上面只表示 Cloud 回调端点已就绪，不表示小鲁班已经会把回复送进来。插件或
入站桥完成真实端到端验收后，才在 `serve.json` 增加：

```json
{ "luban-plugin-replies": true }
```

未打开这个开关时，出站通知仍正常发送，但不会宣称“直接回复 1”可用。
无论消息属于待办、收口、检视邀请还是连通测试，正文都会带固定前置说明：
手机端先输入 `/mfc` 激活 Mae-Flow 插件；未激活时，直接回复普通通知不会
进入 Mae-Flow。

小鲁班真实插件的回调形状、验签方式尚未拿到，因此部署桥负责把它转换成
Cloud 的稳定内部契约；如果插件本身可按该契约发出，也可直接注册 Cloud
地址。**不要为了接未知协议在 Cloud 里堆字段猜测。**

```http
POST /integrations/luban/plugin
Content-Type: application/json
X-MFC-Luban-Plugin-Token: <固定回调Token>

{"message_id":"唯一消息ID","sender":"Mae-Flow账户名","content":"mae-flow 待审批"}
```

Token 不对、工号不存在或正文不合法就拒绝；同 message_id 重放复用原
结果，不会重复提交决定。`sender` 必须是启用中的 Mae-Flow 本地账号。
这个 Token 只是防止其他内网请求伪装成小鲁班回调，不是用户的个人发送
Token，也不需要每个人配置。

已启用 `luban-plugin-replies` 时，账号只有一项待办的通知会直接显示审批
上下文、当前问题和选项，无需先查询“待审批”，
先输入 `/mfc` 激活插件，再回复 `1`、`2`、`确认` 或具体修改意见即可。若同一账号有多项待办，裸序号会
被安全拒绝；应使用通知里的审批码，或打开“Mae-Flow 待审批”插件后先选任务。
插件/桥必须把同一用户的后续裸消息继续转发给 Cloud。多题卡会在每次回复后明确显示“已记录、尚未
提交”并提示下一题，全部答完后才统一生效。选项不合适时回复
`自由回复：答案或修改要求`，Cloud 会回显选择结果并确认原话已保留；无法
唯一判断的普通自然语言不会被猜成某个选项，而是明确提示用户消歧。全是选择题时可用
`1/2/1` 这种斜杠格式一次答完，答错则回复“重答上一题”。

以下显式命令保留为会话丢失、服务重启或排障时的兼容入口：

```text
mae-flow 待审批
mae-flow 详情 <审批码>
mae-flow 选择 <审批码> <选项序号>
mae-flow 通过 <审批码>
mae-flow 退回 <审批码> <意见>
```

审批码绑定账号、task、waiting_id 与 state_version，卡片变化后旧码立即
失效。Cloud 只短期记住“该账号刚刚在看哪张卡”，不缓存决定；每条裸回复
提交前仍重新核对 waiting_id/state_version。明确的修改意见会选择卡片已有的
“修改/退回”项并把原文作为意见保留；开放题按原文提交。单题审批可在手机
完成；多题卡按顺序逐题收集并以结构化 `answers` 一次提交，避免一行文本把
答案错配，也不会把只答完第一题的草稿冒充为已生效决定。自由回复如果能
安全对应现有的“修改/退回”等选项，会同时保留选项原文和用户具体意见；
无法唯一对应时不猜选项也不提交，提示用序号或显式 `自由回复：…` 消歧。
回调响应固定为 JSON `{"text":"纯文本结果"}`，
真实插件若要求其他响应形状，由同一部署桥翻译。

内网插件侧只需确认六件事：回调 URL 能从小鲁班服务器访问、真实工号字段、
唯一消息 ID、插件能否携带固定 Header、HTTP 响应如何显示给用户，以及插件
能否在首次调用后继续把裸回复原样转发。若插件
本身已有可靠验签，桥先按原生方式验证，再加上这个固定内部 Token 转给
Cloud。手机不需要访问 Cloud 内网页面。

## Build-Fix 与流水线修复环（MR 合入才是任务结束）

每次准备把一个**新 HEAD** 推到远端时，Cloud 宿主先启动独立的
Build-Fix Agent。它不是普通编码会话的延长，也不是 Mae-Flow
的新阶段：

- 普通编码会话仍只写代码和 UT；Build-Fix 不挂 Mae-Flow Hooks，不读取
  或改写内核 `current/done`，因此轻量修复不会被内核阶段门禁卡住；
- 它在一次性加固构建容器中发现并执行仓库真实的编译、UT 命令，失败时可
  修改代码、重跑并在本地 commit；它不读取个人 Git 令牌，也不能自行 push；
- 它只核对编译与 UT，不运行 CodeCheck。成功收据同时绑定最终 commit SHA
  和 clean worktree，修复产生新 commit 后以新 SHA 出具；工作区或 HEAD
  再变化，旧收据立即失效。收据附带实际镜像 digest、只读根、资源/网络和
  挂载目的地；暂停/取消会销毁整个 attempt 容器，恢复后新建一轮；
- 宿主拿到 PASS 后先让人检视最终代码，确认后才直接 push。若只是网络失败，重试同一 SHA 且工作区仍干净时
  复用收据，不再烧一次模型和构建；代码失败或工具链/依赖环境失败则停止
  push，并在任务状态中分别说明；
- 这张收据只是快速反馈与 push 闸门，不是内核最终证据。push 后仍进入
  `external_verify`，CodeCheck 与最终编译/UT 由绑定同一 SHA 的权威流水线
  裁决。

### Build-Fix 怎样选择构建命令（内网经验基线）

命令不是平台按语言写死的。Agent 先以本仓 pom/package、wrapper、仓库脚本
和流水线构建描述确认真实可执行入口，再按名称与描述判断选中的构建/测试
Skill 是否相关，需要时自行读取其说明；Skill 不能覆盖真实配置或安全边界。
只有这些材料都没有明确说明时，才采用内网默认经验。跨仓
需求逐仓判断，A 仓的参数不能套到 B 仓。当前首批内网业务仓虽覆盖 Java、
JS 和 C++，共同经验是**以 Maven 为主要编排入口、统一镜像使用 JDK 21**；
这是一条部署基线，不是绕过仓库约定的硬编码。

上线前从管理页执行「部署自检」，确认真实任务容器中的 `java -version`、
`mvn -version`、Node/npm 与 C/C++ 工具链通过，并分别把代表性仓库放进同一
镜像跑通。不要拿宿主 PATH 的结果冒充任务环境。Agent 的执行次序如下
（方括号表示从本仓脚本或 Skill 取得的参数，不照抄为字面量）：

| 仓库类型 | 推荐的快速验证顺序 | 不能省略的仓库信息 |
| --- | --- | --- |
| Java | 先 `mvn [仓库参数] compile`，再 `mvn [仓库参数] test`；修复单个失败时可先用 `-Dtest=<TestClass>[#method]` 定向重跑，收口前仍按仓库要求扩大范围 | wrapper、模块选择（如 `-pl/-am`）、profile、测试插件及私服设置 |
| JS / Web | Maven 仍是主入口；仅在 `website` 依赖缺失或 lockfile 变化时，按仓库脚本和 lockfile 对应的包管理器安装依赖，再执行本仓增量构建与测试 | `website` 工作目录、Node/包管理器版本、lockfile、前端构建被哪个 Maven goal 编排 |
| C++ | 通过本仓 Maven 入口保留已有 DT profile/`-D...` 参数，优先增量编译受影响模块，再跑对应测试与定向覆盖；只有仓库明确要求时才扩大为全量 | DT 参数的准确名字和值、模块/目标、编译器环境、定向测试与覆盖率 goal |

“快速”不等于先清空现场：不得把 `mvn clean`、删除 `website/node_modules`
或递归删除构建目录当成每轮默认动作。已有增量产物应复用；只有仓库脚本明确
要求、或已证明缓存损坏且删除范围可控时，才执行相应 clean。这样既保留
JS 依赖缓存，也避免 C++ 全量编译把一次小修拖成长流水线。

失败分类也要守边界：源码编译错误、测试断言失败属于 `code_failure`，Agent
可以修代码后重跑；JDK/Maven/Node/编译器缺失，私服不可达，依赖下载、证书、
网络、磁盘或权限异常属于 `infrastructure_failure`，停止 push 并写清缺口。
不得为“修环境”自动关闭 TLS/SSL 校验、设置不安全下载参数、修改用户级或
系统级 Maven/npm/Git 配置，也不得读取、打印或写入 token。证书、私服镜像
与全局工具链由部署人员修复，再从同一 SHA 重试。

本机通过仍只是一张预推送收据。CodeCheck、完整环境差异以及最终 compile / UT
结论继续由绑定该 SHA 的权威流水线裁决；仓库脚本或 Skill 可以教 Agent 怎样
构建，不能把局部/增量结果包装成最终质量证明。

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
**全部修完凑一次提交；Agent 不读取/索要个人令牌，也不 push**。修复
产生的新 HEAD 先交给独立推送前 Agent 编译+UT；通过后 Cloud 宿主才使用
短生命周期凭据统一推送并反查远端 SHA，再启动流水线(用户原则:一次修全,
大幅降低流水线重跑)。
不是本仓代码能修的(外部平台配置如 yaml、权限、环境)不硬改,出诊断。

修复本身是纯提示词;宿主只做等待、事实(绑 SHA)、刹车三件提示词
干不了的事。内网需要确认:失败日志的截断策略——**多类问题并发时,
每个失败 stage 都要在 `log` 里留一段摘要**(分诊的原料),不能只给
第一个 stage 塞满 2000 字。

### Cloud 固有执行契约（无部署开关）

Cloud 只有一种最终质量语义，不需要管理员选择。推送前 Agent 是容器化
快速反馈层，不改变订单契约：

- 普通编码 Agent 编写代码与 UT，不在 Mae-Flow 会话内编译；可用 UT 编写方式随每单写入
  `.mae-flow-order.json` 的 `UT生成方式`；
- 每个新 HEAD push 前，独立 Agent 在一次性加固容器运行编译+UT，可自动
  修复并本地 commit；它不挂 Mae-Flow Hooks，不做 CodeCheck；
- 普通 Agent 与推送前 Agent 都不持有个人 Git 凭据、不 push；宿主只在
  获得绑定最终 SHA + clean worktree 的 PASS 收据后推送；
- `execution_contract` 中编译、UT 运行、CodeCheck 仍写 `pipeline`，表示
  **最终裁决来源**，不是说 push 前禁止快速运行；
- UT/build skill 可以指导代码、测试或仓库构建方法，但本地结果不构成内核
  最终通过证据；
- push 后保留 `external_verify`；流水线红灯进入轻量修复环，修复依据该次
  绑定 SHA 的流水线材料，新 HEAD 再走一次推送前编译+UT。
- 红灯只在对应维度拿到可定位报错后才派修；全缺证据时先有限重试，随后
  由《流水线证据缺口》批注回灌或平台晚到证据自动恢复，不派盲修也不扣轮次。

订单中的固定形状如下（除 `UT生成方式` 会按实际可用 Skill 选择外，不是
配置项）：

```json
{
  "execution_contract": {
    "schema": "mae-flow-execution/1",
    "host": "cloud",
    "compile": "pipeline",
    "ut_write": "agent",
    "ut_run": "pipeline",
    "codecheck": "pipeline",
    "git_push": "host"
  },
  "UT生成方式": "java-autout"
}
```

历史 `--verify-via-pipeline` 参数仍可出现在旧启动脚本中，但只会打印
弃用提示并被忽略；带与不带该参数的行为完全一致。

models.json 形状(key 只放服务器本地文件,权限 600,永不进仓):

```json
{
  "providers": {
    "内网网关名": {
      "baseUrl": "https://<内网网关>/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "<从凭证系统注入>",
      "models": [
        { "id": "glm-5.1", "contextWindow": 160000 },
        { "id": "glm-5.3-flash", "input": ["text", "image"], "reasoning": false }
      ]
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

放一次,**之后每个任务的会话都自动带上**(服务日志会打印“宿主技能”,
可核对),内核派出的子 Agent 也一并带上——它们和主会话同一套装配。

业务仓自带的 Skill 不再全量自动灌入。发起任务时在「代码仓 Skill」点击
「读取 Skill」，页面只列出下面四个固定位置的 Skill。首次读取默认勾选
全部可用项，用户可取消不适用的能力：

```
<仓库>/.agents/skills/<skill 名>/SKILL.md   # 首选的跨 Agent 标准
<仓库>/.pi/skills/<skill 名>/SKILL.md
<仓库>/.claude/skills/<skill 名>/SKILL.md
<仓库>/.cac/skills/<skill 名>/SKILL.md
```

只认这些根目录的直接子目录，不递归搜索整个仓库。跨仓下单按仓分组选择，
方案确认后拆出的每个交付任务只继承自己仓的 Skill；A 仓内容不会进入 B 仓
Agent 的上下文。同名 Skill 因此也可以分别用于不同仓。

选择结果由服务端目录令牌校验，任务启动时再做路径、软链接与体积检查，
并复制为任务内只读快照；主 Agent、子 Agent、暂停恢复和修复会话始终使用
同一份 allowlist。未选择的仓内 Skill 对 Pi 完全不可见。目录读取失败或
仓库没有 Skill 不妨碍正常下单，用户可以直接跳过。

平台不扫描、不索引、不展示或选择仓库里的 `docs` 与其他普通文件，也不把
它们复制到知识快照。项目规则及其引用资料由 Agent 的原生项目探索机制负责。

MFC 自己管理的业务模块知识与团队工程知识采用另一条通路：创建任务时固定
发布版本，正文复制成任务内只读快照；会话开局只注入
`.mae-flow-work/TASK_KNOWLEDGE_INDEX.md`，其中只有标题、摘要、适用条件、
作用域、版本和正文路径。Agent 确认相关后再 Read 正文，选中不等于加载，
更不等于已经使用。可用、加载、Read/Grep 和 Skill 正文读取会写入
`knowledge-events.jsonl`。工作台「执行现场 → 本任务知识」展示消费资源、
次数、会话身份和内核阶段。该台账是 fail-open 观测旁路，不能替代质量证据
或卡住流程；无法读取、内容含糊或不适用时必须明确提示。

团队总览「团队知识效能」每 60 秒独立读取一次聚合结果，也可手动刷新。它会
按仓库/类型筛选知识使用排行，并基于至少两个任务的样本提示“多次选择但未
主动访问”或“主动访问后仍频繁出现修复信号”；至少三个主动访问、两个已交付
且无修复信号时才建议提升可见性。所有结论都是运营线索而非因果裁决，不会
自动修改业务仓，也不参与 Mae-Flow 步骤、质量证据或完成判定。旧任务没有
足迹时不会猜测回填，因此试点初期显示“等待第一批数据”属于正常现象。

两件要知道的事:

- pi 不提供"调用 Skill 工具"这个通道,它把 SKILL.md **注进系统提示**让
  模型读。更准确地说，开场只注入 name、description 与文件位置；模型按
  description 判断任务匹配时才 Read 正文。因此用户不用指定“在哪一步用”，
  也不要求每个选中的 Skill 都使用。内核不会把普通业务 Skill 当流程或
  完成证据(否则永远等不到,死循环);
- `disable-model-invocation: true` 的 Skill 会在页面显示为不可选，因为它
  明确禁止模型自主使用；仓库 Skill 也不能扩大工具权限、改变 Mae-Flow
  当前步骤、Git 推送权或替代编译/UT/CodeCheck/流水线证据;
- skill 里的构建/测试说明可以由独立推送前 Agent 使用，尤其适合记录本仓
  wrapper、模块选择和环境准备方式；它仍不能把模型自述或本地结果升级为
  内核最终证据。

`build-fix` 这类纯构建 skill 现在可以收编并按单选择；Pi 会按 description
自行判断是否在推送前会话中读取，不需要用户指定调用步骤。它只帮助找到
命令和修复问题，不增加 shell/Git 权限，也不替代最终流水线。

### 收编时顺手改这几处(省轮次,不是保命)

执行契约会阻止模型把推送前结果当成最终流水线证据；仍建议清理 Skill 中
冲突段落，让普通编码会话与独立推送前会话的职责说清楚。

**最值钱的一处:把 `description` 写准。** pi 只把每个 skill 的
`name`/`description`/路径注进系统提示,**正文要模型自己决定去读**。
描述写成"UT 生成规范"模型未必点得开;写成"写 Java 单测时的命名、分层、
断言与 mock 口径;新增/修改测试前必读"就会。这一条决定 skill 到底有没有
被用上,比删几段编译文案重要得多。

**该删或改写的:**
- "普通编码会话必须现场编译通过"→ 改成"普通会话完成代码与 UT；每个新
  HEAD push 前由独立 Agent 运行编译+UT，最终仍由流水线裁决";
- "调用 build-fix / 某某 Skill"这类**互相调用**的写法(云端没有 Skill
  工具通道,调不动);
- 只能通过 IDE 点按钮、依赖个人桌面状态的操作——服务器会话无法复现。

**构建说明务必留可执行版本:** 仓库 wrapper、模块/工作目录、JS/Java/C++
常用命令、依赖私服前置、如何区分代码失败与环境失败。绝对路径要改成部署
可解析的环境变量或仓内相对路径，避免把某位开发的机器路径带进服务器。

**务必留着的(这些才是价值):** 测试命名与目录规范、分层与粒度口径、
断言写法、mock/桩的约定、覆盖率算法与豁免规则、本仓踩过的坑。

改完不必重启服务:下一个任务重新读取目录并选择后生效；运行中的任务使用
已冻结快照，不会被仓库里随后发生的 Skill 改动半路换掉。

## 仓库资料由 Agent 原生探索

平台不扫描或注入仓库普通文档，也不约定 `.mae-flow/knowledge` 之类的
第二套知识目录。仓库自己的规则、文档与代码关系由 Agent 按原生项目规则
和任务需要探索；需要强制提示的内容应维护在仓库支持的项目规则文件中。
MFC 管理的跨任务业务/工程知识只走上一节的任务知识索引，不与仓库资料
混成同一套选择或注入机制。

## 配置面全集(--config 一个文件收口)

`npm run serve`(不带参数)会自动装载 `/etc/mae-flow-cloud/serve.json`
(存在才装);也可 `--config <路径>` 显式指定别的文件。文件键 =
去掉 `--` 的 flag 名;命令行永远压过文件(排障临时改参数不必动文件);
**文件坏了拒绝启动**,不静默忽略——带着一半配置起服,比不起服更害人。
密钥(模型 apiKey、通知鉴权头)所在文件一律权限 600,永不进仓。

```json
{
  "models": "/etc/mae-flow-cloud/models.json",
  "provider": "内网网关名", "model": "glm-5.1",
  "vision-provider": "内网网关名", "vision-model": "glm-5.3-flash",
  "repo": "<内网仓地址>",
  "platform": "<MR/流水线适配层地址>",
  "luban": "<通知端点>",
  "luban-header": ["Authorization: Bearer <密钥>"],
  "luban-plugin-token-file": "/etc/mae-flow-cloud/luban-plugin.token",
  "dts-mcp-url": "<可省:站点缺省已内置,token 文件在场即生效>",
  "mcp-token-file": "<可省:缺省就是 /etc/mae-flow-cloud/mcp-token>",
  "issue-max-turns": 2,
  "issue-only": false,
  "luban-plugin-replies": false,
  "pg": "postgresql://...",
  "data": "/var/lib/mae-flow-cloud", "port": 8787,
  "poll-interval": 30, "poll-timeout": 1800,
  "max-concurrent": 2,
  "workspace-retention-days": 14,
  "build-cache-retention-days": 30,
  "build-cache-max-gb": 100,
  "isolate-image": "registry.intra/mae-flow/task-builder@sha256:<digest>",
  "isolate-memory": "8g", "isolate-cpus": "8", "isolate-pids": 512,
  "isolate-network": "bridge",
  "isolate-cache-root": "/var/cache/mae-flow-cloud/build",
  "isolate-npm-registry": "https://npm.intra.example/repository/npm-group/",
  "build-slots": 1
}
```

问题流的 MCP token(仅 DTS 网关用;提 MR 复用上方 --platform 适配层):

```bash
install -m 600 /dev/null /etc/mae-flow-cloud/mcp-token
# 写入 x-auth-token 的值;两个网关地址配进 serve.json 后,
# 「问题处理」页的拉单与 AI 的查单/提MR 即接线。未配置时对应
# 能力如实报"未配置",不影响需求主链。
```

| 键(=flag 去 `--`) | 默认 | 说明 |
| --- | --- | --- |
| models / provider / model | 演示剧本 | 模型网关三件套 |
| vision-provider / vision-model | 无 | 专用图片理解角色；必须同时配置，目标模型须在 models.json 声明 `input: ["text", "image"]` |
| repo | 无(纯会话演练) | 内核模式的目标仓 |
| platform / fake-platform | 无 | 交付平台地址 / 本地假件 |
| luban / luban-header | 假小鲁班 | 通知端点与鉴权头(可重复) |
| luban-plugin-token-file | 无 | 准备 Cloud 手机审批回调端点；0600、至少 32 字节的固定 Token 文件，不代表小鲁班入站已接通 |
| luban-plugin-replies | false | 真实小鲁班插件/入站桥端到端验收通过后才设 true；控制通知是否承诺 `/mfc` 激活后可回复 |
| luban-template-waiting / -outcome / -review | 内置默认文案 | 通知正文模板，`{占位符}` 按类别白名单，词汇表与用法见 [`docs/luban-notification-templates.md`](./luban-notification-templates.md)；配错占位符拒绝启动 |
| pg | 无 | 投影(纯旁路) |
| data / port / web | .tasks / 8787 / web-dist | 现场目录、端口、前端 |
| isolate-image | 无(内核模式必填) | 统一任务构建镜像 |
| isolate-volume | 无 | 部署只读配置/CA 等额外挂载(可重复) |
| isolate-memory / isolate-cpus / isolate-pids | 8g / 8 / 512 | 每个任务容器的资源上限；`isolate-cpus` 是可用上限，不是预留核数 |
| isolate-network | bridge | 任务容器网络；拒绝 host/container 模式 |
| isolate-cache-root | `<data>/build-cache` | 按仓库哈希隔离的 Maven/npm/ccache/XDG 缓存 |
| isolate-npm-registry | 无(正式内网部署建议配置) | 任务容器内的 npm 源,以 `npm_config_registry` 注入,需求流与问题流容器同一通道;缺席不注入——容器内只剩 `npm_config_cache`,npm 会打公网直到超时(#75)。URL 以实际内网 npm 源为准 |
| build-cache-retention-days | 30 | 仓库构建缓存从最后一次真实挂载起连续未使用多少天后自动回收；`0`=不按时间回收。正在运行或仍可能继续的任务一律保护 |
| build-cache-max-gb | 100 | 构建缓存总量上限，超出后按最久未用优先回收；`0`=不限容量。扫描与删除使用异步 I/O，不阻塞服务请求 |
| isolate-user | **Linux:服务进程 uid:gid**;root 守护形态必须显式给数字 uid:gid;其他平台:镜像内非 root 用户 | Linux 普通服务账号不配时按自己的 uid:gid 跑。root 守护进程必须显式给非 root 数字 uid:gid；Cloud 在容器启动前把实际代码工作区和分仓缓存安全交给该用户，不修改任务台账与凭据目录 |
| build-slots | 1 | 同时运行的 Build-Fix 重构建数，独立于普通 Agent 并发 |
| build-fix-attempt-timeout-minutes | 普通仓 30 / C++ 仓 60 | 单轮 Build-Fix 的总墙钟预算；只在代表仓实测确实更慢时覆盖 |
| build-fix-command-timeout-minutes | 普通仓 20 / C++ 仓 45 | Maven/CMake/Make/Gradle/npm 等单条重构建预算；Agent 填得更短时由平台自动提升，总预算仍是硬上限 |
| repair-rounds | 不限 | 修复环手刹:数字=上限,0=关;不配=修到绿/出诊断为止 |
| poll-interval / poll-timeout | 10 / 1800(秒) | 流水线轮询节奏与预算 |
| max-concurrent | 2 | 并发任务数 |
| workspace-retention-days | 14 | 现场保留期(天)。终态任务过期后回收**代码克隆等编译环境**,交付账本/事件/transcript/prepush 收据/流水线证据/批注一律保留;`0`=永不回收。只碰 completed/failed/canceled,`await_merge` 与 `verifying` 不碰 |
| compact-every | 150 | 主动压缩节奏(事件数;0=关) |
| desktop-notify | false | 单机手感的桌面弹窗 |

旧部署中的 `--prepush-attempt-timeout-minutes` 和
`--prepush-build-timeout-minutes` 仍可读取，仅作为滚动升级兼容别名；新配置统一使用
`build-fix-*`。

### 部署配置之上还有一层:管理页运行时设置

管理员登录 Web 后左侧「服务设置」页,可热改两类东西(存
`<data>/settings.json`,权限 600,**压过部署值**):

- **运行参数**:并发数、修复轮预算、轮询间隔/预算、现场保留期，以及构建缓存保留期/容量上限。生效边界如实:
  并发=下一次调度,修复轮/轮询=下一次红灯/下一轮轮询;页面直接显示
  当前服务默认值，留空即使用默认值，不要求管理员猜启动参数。
- **模型网关**:网关地址、API Key、模型名称三项；服务端转换为任务
  运行时需要的配置，不在界面暴露 JSON/provider 概念。
  生效于下一个新会话,在跑的会话不换血。
- **图片识别**:独立的多模态网关、协议与模型配置。主 Agent 不切换
  模型；需要读取工作区截图、照片或图表时才调用 `InspectImage`，得到
  受限的文字观察结果。保存后可用系统生成的红/绿/蓝色块图做一次真实
  端到端测试；测试不读取业务图片，也不创建任务。

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
是否可用，不展示内部地址，也不允许运行时覆盖。启动与每次手动自检都会
只读访问平台根接口：只有明确声明 `POST /mr`、`POST /pipeline/trigger`
和 `GET /pipeline/status` 三项能力才算通过；`200 {}` 这类“地址活着但
接错服务”的情况会判红并阻止新需求下单，不会创建试探 MR 或流水线。

两种失败语义是刻意分开的:`--config` 坏了**拒绝启动**(部署形态残缺
比不起服害人);`settings.json` 坏了**按无覆盖处理**并记日志(它是
旁路覆盖,不许挡服务)。密钥纪律:**只写不读**——界面与 API 永远只
给掩码(••••末4位),明文只存在于 600 权限的文件里,不落日志。

### 个人 Git 令牌(每用户,「我的工作」页配置)

开发成员在自己的工作台配平台访问令牌(PAT)+ 平台用户名(默认=登录
账号),之后**宿主**以这个人的身份 clone/push;没配的用户走服务级访问
方式(服务账号 helper / 开放内网)。机制与纪律:

- 每次 clone/push 才在系统临时目录创建 0700 目录与 helper(凭据文件
  0600)，同步 Git 命令结束后 `finally` 删除；helper 不进入任务目录;
- CloudSession 创建前清理旧版本可能遗留的 `pi-agent/git-credential*`
  和仓库本地 `credential.helper`；`.git/config` 不持久化 helper/token;
- Agent 会话内 origin 的 fetch URL 保持干净，pushurl 指向不可写地址；
  会话释放后宿主用显式干净 URL 推送并 `ls-remote` 反查同一 SHA;
- clone 一律 `GIT_TERMINAL_PROMPT=0`:子进程没有终端,缺凭据就地
  失败、错误如实上浮,绝不挂死等密码(不卡死红线);
- clone 在任务启动时现读凭据；push 在会话释放后再次现读，不把凭据
  生命周期扩张到 Agent 执行期;
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
  --isolate-image <统一任务构建镜像@sha256:digest> \
  --isolate-memory 8g --isolate-cpus 8 --isolate-pids 512 \
  --isolate-cache-root /var/cache/mae-flow-cloud/build \
  --build-slots 1 \
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
- **统一任务容器(正式内核模式必选)**:`--isolate-image <构建镜像>` 后
  所有任务 Bash 进入容器；缺镜像、Daemon、加固项、工具链或清理证明时
  都明确失败，不允许回宿主。默认只读根、cap-drop ALL、
  no-new-privileges、PID 512、bridge 网络、HOME 与 `/tmp` tmpfs；`/tmp`
  显式保留 exec 以兼容 Maven Jansi/JNA/native。资源默认 8g/2 CPU，可按
  代表仓实测调整；`--build-slots` 控制重构建并发，避免一台机器被多单
  Maven/C++ 同时打满。镜像构建与内部 CA/Maven settings 的只读挂载见
  `deploy/build-image/README.md`。镜像 `Config.User` 为空/root/0 或显式
  `--isolate-user root/0` 会拒绝运行；不要用 root 绕过目录权限。
- **慢构建预算由平台兜底**:普通仓默认整轮 30 分钟/单条重构建 20 分钟；
  检出 C++ 信号后自动放宽到 60/45 分钟。即使 Agent 给 Maven 全量编译
  填了 `timeout: 600`，容器实际仍至少获得平台预算；普通探查命令不被
  无谓放宽。若代表仓的完整冷构建 P95 仍超过默认值，用
  `--build-fix-attempt-timeout-minutes` 与 `--build-fix-command-timeout-minutes`
  显式上调（例如 120/100）。单命令预算会自动限制在整轮预算以下，给
  结果整理与容器清理留余量；真正耗尽时当次命令立即明确收口，不再靠
  下一条 Bash 触发二次错误。
- **构建环境先于模型验明**:管理页「部署自检」会在真实任务身份下核对
  passwd HOME、Maven 实际使用的 JDK 21、该 JDK cacerts、显式挂载的
  settings、五类缓存和 C++ 仓父子拓扑。正式任务每次进入推送前验证时还会
  先做当前仓语言相关的本地预检；缺 settings/JDK/CA/权限/SDK 时直接归类
  基础设施故障，不启动模型，不用 curl 猜制品仓。预检不访问网络，内部
  mirror 的真实连通性仍由随后真正的 Maven/npm 命令证明。
- **宿主 `/tmp` 不需要 exec**:Host Git 的短期 credential helper 和
  askpass 位于 `<data>/.runtime/host-git/operation-*`（0700，用完删除），
  不再从系统 `/tmp` 执行。宿主可保持 `/tmp noexec`；只有受限任务容器自己
  的 `/tmp` tmpfs 为兼容 Maven native 库显式使用 exec，两者不要混淆。
- **Root 守护与非 root 容器的属主接缝**:首选仍是让服务账号与容器使用
  同一 uid:gid。若进程管理器必须以 root 启动 Cloud，则必须配置数字形式
  的 `--isolate-user 10001:10001`（示例），不能写用户名。每次 docker run
  前，Cloud 会在宿主上递归核对本次真正挂载的代码工作区，并在首次使用
  时修正该仓的 Maven/npm/ccache/XDG 缓存；符号链接只改链接本身，不跟随
  到工作区外。后续宿主 Write/Edit 与内核原子换新状态文件时也会立即把
  对应文件交还容器用户，属主修正失败会在当次工具调用暴露，不拖到编译
  阶段。缓存跳过标记保存在容器不可见的宿主控制目录，不能由任务伪造。
  任务台账、模型配置、账号与凭据目录不参与 chown。禁止用
  `umask 0000` 让所有系统用户可写；老数据第一次修正可能耗时，日志会以
  `[container-ownership]` 报出处理数量，后续缓存由属主标记直接复用。
- **镜像普通用户权限是上线门槛**:预装二进制（包括可选平台 CLI）必须
  `a+rx`，`/etc/profile.d/*.sh` 必须可读，CA 目录逐级可遍历且 bundle
  可读。统一 Dockerfile 会切到最终非 root 用户后用 login shell 真验；
  管理页「统一任务容器」自检也按真实任务用户复验 bind 工作区、五类缓存、
  profile、CA、可选平台 CLI 与只读 Mae-Flow 内核挂载，不能拿 root 构建
  阶段的成功结果代替。
- **关机与孤儿回收**:SIGTERM/SIGINT 会停止调度、释放构建队列、abort
  会话并等待容器 TERM→KILL→rm；不会改写任务业务状态。重启时先按完整
  dataDir ownership label 清理本实例遗留的 coding/prepush/system-check
  容器，再执行 `recover()`；日志包含 phase/role/name/短 ID/镜像，定位时
  不必靠猜。
- **编译错误全文可回读**:每条容器 Bash 的完整原始输出写到对应任务仓
  `.mae-flow-work/bash-logs/<task>/<session>/*.log`（`0600`）。页面/Agent
  看到的截断预览最后一行会给这个相对路径；排查 Maven、UT、C++ 长输出
  时直接打开它，不要再去宿主或容器 `/tmp` 猜临时文件。该目录属于过程
  现场，不进入业务 Diff、审批哈希或预推送工作区洁净度判断。
- **缓存不是共享工作区**:`--isolate-cache-root` 下按仓库地址 SHA-256
  分 Maven/npm/ccache/XDG/C++ SDK 五类目录；不同仓不共享可写缓存。C++ SDK
  缓存会挂到代码仓同级的 `cpp_sdk_repository`，代码仓仍保持
  `<任务目录>/<仓名>`，兼容依赖 `build/../..` 的内部构建脚本；不得把仓库
  拍扁成 `/workspace` 后再用根目录软链接补洞。工作区产物仍
  留在各任务目录。Linux 上容器默认就以服务账号的 uid:gid 运行，缓存目录
  只要归服务账号所有即可；若显式配了 `--isolate-user <uid>:<gid>`，那就
  由你负责让该 uid 对工作区与缓存可写。缓存只用于加速，最终流水线仍是
  权威裁判。
- **一个数据目录只能起一个实例**:`<data>/instance.lock` 是独占锁，起服
  时被本机活着的实例占用就直接拒绝启动并报出占用者 pid。这不是洁癖——
  实例身份就是 dataDir 指纹，第二个实例起来的瞬间会按这个指纹把第一个
  正在跑的编译/prepush 容器清掉。进程被 `kill -9` 后留下的锁由下次启动
  自动接管，不需要手工清理；确实要手工清时先确认对方真的没了，再删这个
  文件。**跨机共享同一个数据目录不受支持**（NFS 之类），会被直接拒绝。
- **等审批时保留原任务容器**:Agent 会话与 HOME、`/tmp`、工作区保持同一
  执行现场，答复到达后直接继续，不做 stop/rm/run。`8g` 是单容器内存上限
  而非预分配；暂停、取消、终态、服务关闭和编码转 prepush 时仍会正常回收。
- 守护用 systemd `Restart=on-failure` 即可,恢复逻辑在服务内部。
  单元文件样例:

  ```ini
  [Unit]
  Description=mae-flow-cloud
  After=network.target docker.service

  [Service]
  # 以专用非 root 账号运行(先 useradd -r maeflow 并把数据/缓存目录
  # chown 给它)。root 运行时服务会要求 --isolate-user <uid>:<gid> 且
  # 拒绝 0:0——与其在 push 前才被容器用户约束拦下,不如单元文件里
  # 就写对(e2e-picky-20260830 审计:旧样例 root 裸跑与启动约束冲突)。
  User=maeflow
  Group=maeflow
  WorkingDirectory=/srv/mae-flow-cloud
  Environment=MAE_FLOW_HOME=/srv/mae-flow
  Environment=MAE_FLOW_ADMIN_USER=admin
  EnvironmentFile=/etc/mae-flow-cloud/secrets.env
  ExecStart=/usr/bin/npm run serve -- \
    --models /etc/mae-flow-cloud/models.json \
    --provider <网关名> --model glm-5.1 \
    --kernel-mode --platform <MR/流水线网关地址> \
    --pg postgresql://<用户>@<PG地址>/<库名> \
    --isolate-image <统一任务构建镜像@sha256:digest> \
    --isolate-memory 8g --isolate-cpus 8 --isolate-pids 512 \
    --isolate-cache-root /var/cache/mae-flow-cloud/build \
    --build-slots 1 \
    --data /var/lib/mae-flow-cloud --port 8787
  Restart=on-failure
  RestartSec=3
  KillSignal=SIGTERM
  TimeoutStopSec=180

  [Install]
  WantedBy=multi-user.target
  ```
  `secrets.env` 至少包含 `MAE_FLOW_ADMIN_PASSWORD=...`,权限设为 `0600`,
  不要把密码直接写进单元文件或仓库。账号库已存在后不会重复创建管理员。
  必须以 root 运行的部署(极少数,如需要读受限 CA):去掉 `User=` 并在
  ExecStart 追加 `--isolate-user <业务uid>:<业务gid>`——0:0 会被拒绝启动。
- 环回代理教训(外部踩过三次):如果服务器有全局代理,
  确认 `NO_PROXY=127.0.0.1,localhost`(代码里 `ensureLoopbackDirect()`
  已兜底,但 curl 排障时记得 `--noproxy '*'`)。

## 上线自查清单(按序)

可执行版:`harness/preflight.sh --models <models.json> --provider <网关名> --adapter http://127.0.0.1:8790`
——本机服务与连接项自动核验，流水线与恢复项按清单演练。
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
   - MR/流水线 CLI 四能力逐一实测:交 MR、按 SHA 查状态、可选返回
     **COMPILE/UT/CODECHECK 三项 checks**、**拉失败日志**——checks 建议
     配置以提升诊断；日志拉不到，Cloud 修复环没有可信输入，试点不得上线;
   - 通知 CLI 发一条真消息@到人(失败只标红不阻流程,但要验真投得到);
1. `npm test` 全绿，`npm run typecheck` 无错，前端可构建；构建
   `deploy/build-image/` 后以 `MFC_REAL_BUILD_IMAGE=<镜像> npm test` 运行
   真实 Docker 自检。再对 JS/Java/C++ 代表仓各跑一单，确认容器内无需
   交互、私服/证书/缓存可用，宿主无需安装项目构建链;
2. `npm run probe` 全绿(内核裁判在场);
3. 网关连通:发一个最小任务,确认首回合不是空转
   (429/网关错误会如实落 failed + detail,不会假 completed);
4. 适配层自检通过，管理员「部署自检」确认「Linux 部署」与 MR/流水线
   能力均为 ok；容器部署时服务必须直接接收停止信号（PID 1），建议用
   `exec node --import tsx src/serve.ts …` 或直接运行编译后的 JS，不要让
   npm / tsx 启动器隔一层；「统一任务容器」也必须为 ok，并显示不可变镜像 digest，
   该项会在 bind-mounted 工作区真实写文件并编译 Java/C++，逐项写读删
   Maven/npm/ccache/XDG 缓存，检查 Node/Maven 后确认容器销毁;
5. 一单真需求走到 `await_merge`,MR 出现在真平台上；核对
   新 HEAD 在 push 前出现推送前验证状态，`delivery.prepush` 的 PASS
   绑定最终 SHA 且当时 worktree clean，receipt.execution 记录同次容器的
   镜像 digest、只读根、资源和网络；模拟一次 push 网络失败后重试，
   确认同 SHA 复用收据，改出新 commit 后必须重新编译+UT。随后核对
   `delivery.git_push.sha`、`delivery.sha`、远端分支 SHA 三者一致，
   `delivery.attested` 为同一 SHA 的 `PASS@...`；若平台提供逐项 Job，
   再核对 `delivery.checks` 含 COMPILE、UT、CODECHECK。任务订单的
   `execution_contract` 与 `UT生成方式` 完整;
   顺带演练修复环:故意让流水线红一次,确认修复会话拿到失败日志、
   推新提交、新流水线绑新 SHA(而不是旧 SHA 的旧绿灯);
6. 杀进程重启,确认等待中的任务还在、决定后能续跑
   (可执行演练:`harness/restart-drill.sh`——真 kill -9 真 HTTP,
   全绿即过;上线机器上跑一遍)。

## 监控与排障

- 页面 `GET /`:任务状态说人话;通知失败红条;MR 链接。
- `GET /tasks`:每个任务可带 `token_usage`，来自模型提供方真实 usage；
  含累计输入/输出与最近 60 秒吞吐，网关不返回 usage 时字段缺席。
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
