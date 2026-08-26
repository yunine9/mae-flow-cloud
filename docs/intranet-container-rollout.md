# 内网容器化落地待办(2026-08-22 收口)

一句话现状:**代码侧全做完并在本机以真 Docker + 真模型整链验证过;内网侧
一步都没走。** 当前决定是等内网操作系统刷成 Ubuntu 之后再动容器,周一只做
一件跟操作系统无关的事——把目标仓真实的工具链版本探明。

这份文档只讲"内网还欠什么、按什么顺序补、谁来做、怎么验"。
镜像怎么造看 `deploy/build-image/README.md`,隔离机制为什么这么设计看
`docs/container-isolation-design.md`,部署全量参数看 `docs/deploy-intranet.md`。

## 为什么现在按兵不动

1. **内网现役版本还停在 `1604670` 之前**,容器相关代码根本不在上面,不升级
   就没有任何新风险,不存在"必须马上跟进"的压力。
2. **容器引擎是唯一跟宿主 OS 绑死的东西。** 镜像自带整个用户态——一个
   Debian/Ubuntu 基础的镜像在欧拉宿主上照跑不误,Dockerfile 一个字都不用改。
   真正跟宿主 OS 有关的只有两件:能不能装上容器引擎、内部 apt 源认不认。
   系统若要刷成 Ubuntu,这两件正好一并解决,现在折腾等于白做一遍。
3. 但**工具链版本探明与 OS 无关**,而且它是造镜像的输入,越早拿到越好——
   所以周一只做这一件(见下文可直接粘贴的 prompt)。

## 仓库侧已经完成的

| 能力 | 落点 | 验证形态 |
| --- | --- | --- |
| 任务命令进容器 | `src/containerRuntime.ts` / `taskService.ts` | 真 Docker 用例 + 本机整链 |
| 统一构建镜像 | `deploy/build-image/` | `tests/buildImageAssets.test.ts` + 真构建 |
| push 前独立验证 Agent | `src/prepushAgent.ts` | 整链跑通,真 Maven 18 tests 全绿 |
| 内核模式强制隔离 | `src/serve.ts:467` 未配 `--isolate-image` 拒绝启动 | `tests/serveConfig.test.ts` |
| 实例互斥 | `src/instanceLock.ts` | 两个真 serve 进程 + 真 SIGTERM / kill -9 |
| Linux 容器 uid | `resolveContainerUser()` | `tests/containerUser.test.ts` |
| 等人期间保留原容器 | `settleTurn()` / `activeTaskContainer()` | `tests/idleContainerRelease.test.ts` |
| Clone/技能发现凭据边界 | `prepareHostGitSandbox` 接管 | `tests/cloneCredentialBoundary.test.ts` |

## 内网还欠的(按依赖排序,前一项不成后一项做不了)

**第 0 步 · 工具链版本探明 —— 与 OS 无关,周一就能做。**
目标:拿到各目标仓真实使用的 JDK/Maven/Node/npm/GCC 版本,以及内网 Maven
私服地址和公司 CA。这是造镜像的唯一输入,拿不到就只能靠猜。

**第 1 步 · 容器引擎(等刷机后)。** 宿主装上 docker 或兼容引擎并确认服务
账号在 docker 组里。欧拉自带 podman,`podman-docker` 能不能顶住没验过——
这正是"等刷完 Ubuntu 再说"的原因之一。

**第 2 步 · 基础镜像来源。** 两个上游基础镜像内网大概率拉不到,两条路都行:
- 让运维把 `maven:3.9.9-eclipse-temurin-21-jammy` 和 `node:18.16.1-bullseye-slim`
  同步进内部仓(周期最长,要走审批,建议先提);
- **或者**直接用内网已有的任一 Linux 基础镜像自己装工具链——你的内网服务器
  本来就能装这些工具,这条路不依赖任何人。
`deploy/build-image/Dockerfile` 的两个基础镜像都是 `ARG`,`--build-arg` 覆盖
即可,不必改文件。

**第 3 步 · 造镜像。** 按 `deploy/build-image/README.md` build,注意
`BUILDER_UID/GID` 要对上服务账号(默认 10001)。

**第 4 步 · 内部私服与 CA 只读注入。** 部署时把
`/etc/mae-flow/maven/settings.xml` 和 `/etc/mae-flow/ca/company-ca.pem`
以只读方式挂进去,样例见 `deploy/build-image/maven-settings.example.xml`。

**第 5 步 · 升级 mae-flow-cloud 到新 HEAD 并带 `--isolate-image` 启动。**
升级会有感知的行为变化见下一节。

**第 6 步 · 亲手跑通第一单到 MR。** 这是唯一能证明内网真的通了的东西,
本机测试证明不了。

## 周一那件事:可直接粘给内网 agent 的 prompt

> 请只做只读探查,不要修改任何文件、不要提交、不要动任何代码仓。
> 对我们计划接入 Mae-Flow 的每个目标仓,分别报告:
> 1. 仓库根目录下的构建入口是什么(pom.xml / package.json / Makefile / CMake),
>    以及项目声明要求的 JDK 版本(pom 的 maven.compiler.release 或 properties)。
> 2. 本机 `java -version`、`mvn --version`、`node --version`、`npm --version`、
>    `gcc --version`、`git --version`、`python3 --version` 的原样输出。
> 3. 该仓真实跑通一次编译和单元测试的完整命令原文(照抄你平时用的那条)。
> 4. Maven 内部私服地址,以及 `~/.m2/settings.xml` 里 mirror/repository 的
>    结构(**把任何密码、token 打码成 `<token>`,但保留 XML 字段名与层级**)。
> 5. 公司 CA 证书在本机的路径。
> 6. 宿主操作系统与版本(`cat /etc/os-release`),以及 `docker version` /
>    `podman version` 是否可用(不可用就如实说不可用,不要尝试安装)。
>
> 每一项都要贴原样输出;拿不到的项指名道姓说明是哪一项、为什么拿不到,
> 不要跳过也不要用推测填充。

## 悬而未决的问题(造镜像前必须有答案)

- **Node 18.16.1 / npm 9.5.1 的出处查无实据。** 它被写死在
  `deploy/build-image/Dockerfile:70-71` 的构建期断言里,同时被
  `tests/buildImageAssets.test.ts:30-31` 用正则钉在 Dockerfile 文本上,
  但仓库里**没有任何地方说明这个版本是从哪个目标仓量出来的**。
  你说内网 Node 是 24——如果目标仓真要 24,这两处都得改,而且要顺手把
  版本改成 build arg,别再把版本硬写在断言里。第 0 步就是为了给它一个出处。
- **JDK 21 同理**,只是它至少有 README 里"目标仓以 Maven 为主、基线 JDK 21"
  的口径撑着,比 Node 强一点,但一样没有实测出处。
- **缓存目录属主。** entrypoint 会校验 `/cache/*` 可写,不可写直接 `exit 73`,
  症状是"容器启动后未处于 running"。宿主上的缓存目录必须属于
  `BUILDER_UID:BUILDER_GID`。本机夹具就在这里栽过一次(README 已记)。
- **欧拉/Ubuntu 上的真实 uid 行为没验过。** 本机是 macOS + Colima,Docker 在
  VM 边界做 uid 映射,跟 Linux 上 bind mount 直接透传 uid 是两回事。
  `resolveContainerUser()` 的 Linux 分支只有单元测试,没有真机实测。
- **codehubcli 真实输出形态没见过。** 适配层契约是照着文档写的,第一单跑起来
  才知道对不对。

## 升级到新 HEAD 时会有感知的行为变化(运维必读)

1. **实例互斥锁可能让服务起不来。** 报错形如
   `数据目录已被本机另一个实例占用(pid=xxx)`。处置:确认确实没有第二个进程
   在跑,然后删掉 `<data>/instance.lock` 再起。它防的是两个 serve 指同一个
   `--data` 时互相杀容器、共写 task.json。
2. **内核模式未配 `--isolate-image` 直接拒绝启动。** 这是有意的硬边界,不是
   bug——不许在没有隔离的情况下跑多人生产。
3. **Linux 上容器默认按服务进程自己的 uid:gid 跑**(不再用镜像里的 10001),
   服务以 root 运行则拒绝启动。只在配了隔离时生效。
4. **等人审批期间保留原容器**,答复到达后在同一执行环境继续。只在配了隔离时生效。
5. **clone 与仓库技能发现改走加固沙箱**(空 HOME、空全局 git 配置)。
   这条**不配容器也生效**,但风险有界:push 和 ls-remote 早就在用同一套沙箱,
   所以内网只要 push 成功过,clone 就不会因为它挂。且它只在用户配了个人
   Git 令牌时启用,走部署账号的路径行为一个字没变。

## 本机验证到什么程度(以及证明不了什么)

**证明了**:真 Docker 全量测试 0 skip 通过;整链一次跑通——需求 → Grill →
Spec/Story → 容器内编码 → 提交 → prepush 在独立构建容器跑真 Maven 全绿 →
PASS 收据带完整容器事实存根 → 推送 → MR → 流水线绿灯绑 SHA → `await_merge`;
并发实战三任务同跑,只按宿主可核实的事实判(容器名、`docker ps` 残留、
工作区产物、容器内 `uname`)。

**证明不了**:欧拉或 Ubuntu 宿主上的真实行为、真 codehubcli、内部私服与 CA、
Linux 真 uid 透传。这四样只能靠你亲手跑通第一单。
