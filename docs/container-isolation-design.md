# 统一任务命令容器化(已实现,2026-08-21)

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

- 正式 host 模式未配 isolation → 启动期拒绝；不存在宿主 Bash 回退;
- 任务 launch → `docker run -d`
  长驻容器(`sleep infinity`),挂载 `克隆目录:同路径`;
- 每条 bash 命令 → `docker exec <容器> sh -lc <命令>`,
  stdout/stderr 流式回传,退出码原样上报。无论成功、失败、中断还是
  超时，原始完整输出都会以 `0600` 落到任务工作区
  `.mae-flow-work/bash-logs/<task>/<session>/*.log`；给 Agent 的有界
  首尾预览以这条可 `Read` 的相对路径收尾，长 Maven/C++ 日志不会再
  指向容器外不可读的 `/tmp/pi-bash-*`;
- 普通编码/修复会话收口 → **等待**容器确认删除；准备 push 时再为
  prepush 编译+UT Agent 创建一次性 attempt 容器，绝不并发写同一工作区;
- 暂停/取消/timeout/Abort → 中止会话并销毁整个容器进程树，按
  TERM→KILL→rm 顺序确认对象不存在；恢复创建新容器/新 attempt;
- prepush 容器名按实例+任务稳定，round/SHA 写入 label 与收据；服务
  启动时在 `recover()` 前按完整 dataDir SHA-256 ownership label 清扫
  上次崩溃留下的 coding/prepush/system-check 容器，逐个复验 name、role、
  task 与 container label，不能只凭名称误杀;
- SIGTERM/SIGINT 先停止调度并 drain 构建等待者，再 abort 在途会话/
  prepush、等待全部登记容器确认删除；关机不把任务伪写成暂停/取消/失败，
  下次仍按原业务状态恢复;
- **恢复语义(§11"任务容器丢失但工作区卷仍在时重建容器")天然满足**:
  容器从不保存状态,工作区全在挂载卷里;重启后 launch 重新
  `docker run` 就是"重建容器",zero 额外机制;
- 容器起不来 → 任务 failed 并明说原因,不降级回宿主执行
  (要隔离就真隔离,静默降级是假隔离)。

## 当前安全契约与边界

- 默认 read-only root、cap-drop ALL、no-new-privileges、pids=512、
  bridge 网络、HOME 与 `/tmp` tmpfs；`/tmp` 显式 exec 以兼容 Maven
  Jansi/JNA/native。CPU/内存/PID/网络均可由部署收紧;
- 镜像最终以非 root builder 运行；显式 root/0、空 `Config.User` 都在
  启动复验时拒绝。宿主环境仅透传 PI 元数据/locale
  白名单；镜像自身若烘入 TOKEN/PASSWORD/API_KEY 等 ENV 也拒绝启动;
- `safe.directory` 只认当前 workspace；额外挂载禁止覆盖 workspace、
  HOME、`/tmp` 或 Docker Socket；同名外部容器没有 ownership labels 时
  拒绝误杀;
- Maven/npm/ccache/XDG 缓存按仓库地址哈希隔离。它是速度层而不是质量
  证据；同仓缓存仍应由运维做清理/容量策略，最终流水线仍是裁判;
- 文件 Read/Edit/Write 留宿主以维持 Pi/内核结构，但 Gate 用真实路径、
  软链与任务 workspace 做 fail-closed 边界；Cloud 控制面、凭据、clone/
  push、MR 与通知也仍留可信宿主;
- bridge 网络允许访问部署网络中的依赖仓；若需要按域名/地址做 egress
  白名单，应在 Docker 网络/主机防火墙实现，不把规则塞进 Agent 提示词。

## 分步落地

1. `containerRuntime.ts`:加固 start/inspect/exec/stop、不可变镜像元数据、
   timeout/Abort 全容器清理;✅
2. sessionDriver `bashOperations`:主会话与 Task 子会话共用容器后端;✅
3. TaskService:普通/修复/prepush、构建槽、暂停/取消/恢复、分仓缓存;✅
4. serve:host 模式强制镜像，资源/网络/缓存/build-slots 配置;✅
5. `deploy/build-image/`:JDK21/Maven、Node18/npm9、C/C++ 统一非 root 镜像;✅
6. 管理员部署自检:真起短命容器编译 Java/C++、检查 JS/Maven、确认销毁;✅
7. 测试:纯运行时 8 项、编排回归、真实 Docker 隔离、真实统一镜像 smoke;✅
