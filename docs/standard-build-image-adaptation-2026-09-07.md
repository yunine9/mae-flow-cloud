# 标准构建镜像适配与本次故障收口

## 已证实的根因

内网报告的 A/B/C/D 实验显示：docker run 都成功返回容器 ID；entrypoint 因
`MAVEN_CONFIG=/home/huawei/.m2` 在只读根目录不可写而退出 73。平台只覆盖了
`HOME=/home/mae-flow`，没有同步 Maven 用户配置目录。改变缓存挂载或登录
shell 都没有消除错误；去掉只读根目录只是绕开了路径问题。

错误显示 `id=unknown` 是另一处诊断缺陷：完整 metadata 要在全部校验通过
后才赋值。Docker 创建成功但校验失败时，它仍为空。另有两处证据丢失：
`docker logs` 成功时 stderr 被忽略；`--rm` 可能在取证前删除已退出容器。

报告中的边界：当前源码确实带 `--rm`，不能把去掉它的诊断 argv 称为完全相同；
实验 D 只排除了 shell 参数是这次退出的原因，并未排除所有环境变量差异。
报告对 ccache 有“未安装”和“登录后 PATH 含 ccache”两种说法，不能当成已安装。

## 本次代码修复

- 共用 TaskContainer 按最终 HOME 派生 MAVEN_CONFIG、NPM_CONFIG_USERCONFIG，
  HOME tmpfs 同步；不再让这些变量继承镜像内过期的用户路径。
- `serve.json` 新增 `isolate-home`，同时传入需求流和问题流。底层容器支持
  启动环境指定 HOME；命令执行阶段仍禁止把宿主 HOME/PATH 任意透传进去。
- 平台在容器内准备临时 Maven 用户配置并接入只读 settings.xml。
  原始镜像无需安装平台 entrypoint；已有 entrypoint 的适配镜像也能继续使用。
- 缓存挂载同时设置大小写 npm cache 变量和 MFC_MAVEN_CACHE。
- ccache 不再是自检和 C++ 预检的硬依赖；登录 shell 检测存在时才设置
  CMake launcher，保留显式指定的其他 launcher。缺席时正常使用编译器。
  自检说明缺席事实，Agent 的构建指引也同步改为可选，避免模型又按旧要求停工。
- 启动失败保留真实 ID、子阶段、退出码、Docker 错误、OOM 状态及日志 stderr。
  日志取证后显式清理容器；正常结束、启动失败、取消及服务启动清扫继续负责回收。

改动位于共用运行时，覆盖自检、普通任务、基线预热、Build-Fix、问题流。
保持现有宿主/任务容器架构，不关闭只读根目录，不把容器用户改成 root。

## 内网一次性更新与验收

1. 将包含本修复的 main 同步到 prod/test 的部署代码目录，保留现有配置与任务数据。
2. 对当前 `mae-flow-task-builder:cs9-euler-v4-thrift`：报告确认 passwd HOME 已改成
   `/home/mae-flow`，因此无需重建镜像，也无需修改 HOME 配置。平台会覆盖旧的
   MAVEN_CONFIG。不要给这张已改 passwd 的镜像配 `/home/huawei`。
3. 若使用未改造的公司原始镜像，保留其 passwd HOME，在对应 serve.json 中设置：

   ```json
   { "isolate-home": "/home/huawei", "isolate-user": "1001:100" }
   ```

   这是合并进现有配置的字段，不是替换整个配置文件。镜像路径仍使用实际部署值。
4. 先更新并重启 test 的 `mae-flow-serve-test`，调用 `/settings/check`。
   确认 container/prepush 正常；缺 ccache 只显示说明，不导致失败。
5. 再更新 prod 的 `mae-flow-serve` 并自检。已存在的任务容器保留旧环境，
   更新后应通过正常任务恢复流程重建，不直接删除业务工作区。
6. 若仍失败，返回的新日志应直接包含实际 ID、startup-inspect 或
   user-environment 阶段及 stderr。此时按新错误处理，不继续重建镜像猜路径。

本机无法连接内网服务器；上述部署尚未执行。不要将本机回归通过当成内网已上线。

## 标准构建脚本揭示的另一个层面

用户提供的脚本不是“有编译器就执行 Maven”这么简单。它明确要求：

- Java 与 C++ 使用不同镜像：Java 为 cs9.0_v4.0_thrift，C++ 为 cs5.1_v3_internal。
  当前 cs9 镜像能通过 C++ 小程序探针，不能证明它与 FarsService 所需 SDK/ABI 兼容。
- 工作区是 `Source/MAE/src/<仓名>`，旁边还需要 MAEStarterParent、MAEServiceBuild、
  MAEBuild、DeployBuildTool 四个辅助仓库。
- 先调用 `MAEServiceBuild/maecloudbuild/scripts/pre_build.sh`，再调用
  `build_service.sh PushBuild ...`，后者的副作用与完整行为需以内部脚本为准。
- FarsService 的 `build.sh` 会加载 `/etc/profile` 和 `svc_profile.sh`，还可能
  追加构建参数；不能把一次 source 的环境假定为所有后续 shell 都继承。

因此，自检绿代表所选镜像的通用工具、用户目录和挂载可用；业务构建最终仍需
在指定镜像、辅助仓库和真实标准入口下验收。本次没有把这些内部仓库的内容
复制到平台，也没有自动按 Java/C++ 切换镜像或重构多仓编排。

原始通用脚本还有以下具体问题，应在正式用于业务验收前修正：

1. `grep -A1 '<parent>'` 常取不到 artifactId，因为 parent 的下一行通常是
   groupId；应使用支持 XML namespace 的解析器读取直接 parent/artifactId。
2. 文末三条使用示例是可执行代码，包含 `<URL>` 占位符；必须改成注释或移到文档。
3. 路径/分支/URL 多处未引用，且通过 sed 替换变量，含空格、&、分隔符时可能损坏。
   应统一引用参数，以参数或环境传入容器内脚本，不用文本替换生成 shell。
4. 已存在代码仓只跳过 clone，没有确认 remote、当前分支及提交；容易构建旧代码。
5. 调用辅助脚本用了相对路径，内层脚本虽计算 WORKSPACE 却没有切换目录；
   应显式 `cd "$WORKSPACE"` 或使用绝对路径，并给 docker run 指定工作目录。

这些是独立于退出73的业务构建问题，不应归因于缓存权限或容器没创建。

## 验证依据

使用本机已有构建镜像派生临时回归镜像，不访问内网或下载镜像：

- 设置旧 MAVEN_CONFIG=/home/huawei/.m2，真实复现 entrypoint 退出73。
- 保持只读根目录、去掉 ccache，修复后经 TaskService.systemCheck 完成
  Java/C++ 编译执行、Maven settings、缓存读写与 prepush 自检。
- 再移除平台 entrypoint，把 passwd/HOME 改为 /home/huawei；仅由平台配置
  isolate-home 对应的环境完成相同自检。
- 单测覆盖 Docker stderr、ID 回传、启动失败取证后清理、原生 HOME 配置接线、
  可选 ccache 检测和显式 launcher 保留。

这些回归未替代内部 cs9/cs5 两张镜像及 FarsService 完整构建验收。
