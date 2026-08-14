# 任务工作区容器隔离(设计,2026-08-14)

主 spec §4/§8:任务执行通过 Docker 创建隔离工作区。本文回答
"隔离什么、不隔离什么、在哪个接缝动刀",并给分步落地计划。

## 结论先行

**隔离命令执行,不搬会话。** pi 会话、门禁拦截、内核 dispatch、
文件工具全部留在宿主;只有 bash 工具(编译/测试/任意命令——模型
真正能伤到宿主的通道)经 `docker exec` 进任务专属容器执行。
工作区目录以**相同绝对路径**双向挂载进容器,三方(容器内命令、
宿主文件工具、内核状态文件)看到同一份文件,零路径映射。

## 为什么是这个刀口

pi SDK 0.84.1 原生留了这个接缝(调研实锤,非猜测):

- `BashOperations.exec(command, cwd, {onData, signal, timeout, env})`
  ——bash 工具的执行后端可插拔,文档原话举例 SSH 远端执行;
- `createBashToolDefinition(cwd, { operations })` 造出同名 bash 工具;
- `createAgentSession({ excludeTools: ["bash"], customTools: [...] })`
  摘掉内建 bash、换上我们的。

工具仍叫 `bash`:tool_call 拦截、内核 pretooluse/posttooluse、
transcript 形状全部零改动——门禁看到的世界不变,变的只是命令
最终在哪个内核里跑。

三个备选被否:
- **整任务进容器(会话也搬)**:推翻进程内架构(三条铁边界之三),
  同步拦截/未 resolve Promise 挂起/子会话同进程全部报废;
- **macOS sandbox-exec 限权**:不符内网 Linux 服务器形态;
- **只靠门禁字符串拦截**:门禁是流程契约不是安全边界,
  拦截"看起来危险的命令"挡不住无穷的变体。

## 生命周期与恢复

- 任务 launch(host 模式且配了 isolation)→ `docker run -d`
  长驻容器(`sleep infinity`),挂载 `克隆目录:同路径`;
- 每条 bash 命令 → `docker exec <容器> sh -lc <命令>`,
  stdout/stderr 流式回传,退出码原样上报;
- 任务收口/失败 → 停容器;
- **恢复语义(§11"任务容器丢失但工作区卷仍在时重建容器")天然满足**:
  容器从不保存状态,工作区全在挂载卷里;重启后 launch 重新
  `docker run` 就是"重建容器",zero 额外机制;
- 容器起不来 → 任务 failed 并明说原因,不降级回宿主执行
  (要隔离就真隔离,静默降级是假隔离)。

## 已知边界(诚实清单)

- `docker exec` 客户端被杀(超时)不会杀容器内进程:v1 接受,
  容器随任务收口销毁兜底;后续可 `docker exec` 配 PID 追杀;
- 镜像由管理员按试点仓选(Java 仓 = maven:3.8-eclipse-temurin-8),
  依赖下载走容器网络,内网镜像源配置属部署事项;
- Apple Silicon 外部演练是 arm64 容器,内网 x86_64 语义已由
  双架构编译验证覆盖;
- uid 映射:容器内以 root 写挂载卷,宿主文件属主可能变化——
  内网部署时按平台惯例配 `--user`(部署手册补充项)。

## 分步落地

1. `containerRuntime.ts`:起/停/exec(流式、退出码、超时),docker CLI
   直驱不引 SDK 依赖;✅(本次)
2. sessionDriver 接 `bashOperations` 选项:摘内建 bash 换容器版;✅(本次)
3. TaskService `isolation: { image }`:容器生命周期挂到任务生命周期;✅(本次)
4. serve/pilot `--isolate-image` 参数;✅(本次)
5. 测试:容器内 `uname` 是 Linux 而宿主是 Darwin——隔离的直接证据;
   无 docker 的机器显式跳过;✅(本次)
6. 后续:资源限额(--memory/--cpus)、`--user` 映射、内网镜像源、
   exec 超时的容器内追杀。
