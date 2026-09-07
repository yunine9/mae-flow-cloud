---
name: mae-first-build
description: MAE 标准构建镜像中首次编译或构建准备失效时使用。先检查平台辅助仓与首编状态，再运行仓库真实构建入口；准备有效时转到语言专项 Skill 做增量构建。
---

# MAE 首次构建

只用于平台准备了 `MFC_MAE_BUILD_ROOT` 的 MAE 业务仓。需求预热、问题流预热和 Build-Fix 都先检查本 Skill；非 MAE 仓沿用自己的构建流程。

## 首编还是增量

明确业务仓根目录，不假设存在 `$CWD`。问题流的业务仓在 `repo/<仓名>`；四个辅助仓不是待编译业务仓。

```bash
node /opt/mae-flow-build/first-build.mjs status <业务仓绝对路径>
```

- `needs_first_build`：使用下面的首编入口。
- `ready_for_incremental`：读取 `.mae-flow-work/build-notes.md` 与已加载的语言构建 Skill（如 `mae-remote-build`），按已验证入口增量编译。该状态不表示当前代码已通过编译或 UT。
- 缺辅助仓、鉴权失败或容器未准备：报告 infrastructure_failure，不在 Agent 中 clone、注入令牌或改全局配置。

首次成功记录跟踪镜像、辅助仓版本、主要构建配置和工具链。源代码修改不触发全量。子模块配置、SDK 或生成目录损坏仍需按仓库事实重新配置，不能仅凭记录判断可用。换容器会恢复 HOME 中的 npm 配置，不需要因此 clean。

## 平台负责的准备

宿主将 MAEStarterParent、MAEServiceBuild、MAEBuild、DeployBuildTool 放在业务仓同级，并固定版本；凭据不进入容器。`MAEServiceBuildCache/c2` 保存准备缓存。

容器每次启动恢复 MAEBuild 提供的 npm 默认源和 scope 路由；Maven settings 在 `/etc/mae-flow/maven/settings.xml` 只读挂载。不要读取、打印配置中的凭据，不执行 `npm config set`。

未限定 scope 的内部 fork（例如 `echarts@*-htrunk*`）不能靠 `@baize:registry` 路由。若默认源不含该包，安装命令按仓库说明显式传 `--registry=https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm`；不要更改其他仓或平台全局源。

ccache 可选。平台若挂载 `/cache/maven`，Maven 命令显式加 `-Dmaven.repo.local=/cache/maven/repository`，避免业务脚本覆盖 MAVEN_OPTS 后反复下载。没有该挂载时按平台实际缓存配置执行。

## 执行首编

用以下包装器运行实际命令，它先执行平台固定版本的 pre_build.sh，成功构建后才记录首编完成：

```bash
node /opt/mae-flow-build/first-build.mjs run <业务仓绝对路径> -- <命令> <参数...>
```

执行目录自动设为业务仓根。耗时 C++ 构建的 Bash timeout 设置为 4500 秒，服从本轮平台预算和用户取消。不要将输出管道到 tail；保持实时输出。

根据仓库 POM、CI 与脚本选择入口：

- **Java**：`mvn package -U -DDEBUG_FLAG=DEBUG -DskipTests`；如有 wrapper 优先 wrapper。预热应拉齐打包插件；空工作区无需 clean。
- **JS 混合仓**：先进入 package 所在目录安装依赖，再执行 Maven 或仓库 build。存在 npm 锁文件用 `npm ci --legacy-peer-deps`，否则 `npm install --legacy-peer-deps`；pnpm/yarn 用其锁文件与仓库脚本。依赖安装和编译放在同一次包装器的 `bash -c` 命令内，安装必须成功才继续。禁止跳过安装、擅改锁文件来掩盖依赖故障。
- **C++**：检查仓库是否采用 `MAEServiceBuild/maecloudbuild/scripts/build_service.sh PushBuild <仓根> <缓存目录> <origin URL>`。FarsService 已验证的仓内入口是 `bash build/build.sh 0 "" "" "" Access <并行数> ""`；只对实际具有相同脚本契约的仓使用。其他仓以自己的 POM/脚本为准，不把 Fars 参数强加给全部 C++ 仓。

并行数用 `node /opt/mae-flow-build/first-build.mjs cores`，兼容 cgroup v1/v2、max 和小于一核；内存紧张时进一步降低。不要固定 -j8/-j12 或直接使用宿主核数。

`source build/svc_profile.sh` 只影响当前 shell；后续直接 make 时必须在**同一条 Bash 命令**内 source，再进入生成目录编译。不能单独 source 一次便假设其他 exec 都继承环境。

pre_build.sh 写只读位置失败不代表所有错误都可忽略：平台只替代 Maven/npm/可选缓存配置，缺 SDK、工具链或签名工具仍须按实际构建需要上报。不得关闭 TLS 校验。

## 收口与切换

成功后将真实命令、执行目录、语言入口、增量条件、生成目录和工具链注意事项写入 `.mae-flow-work/build-notes.md`（问题流按仓分节）。之后使用对应语言 Skill；未安装专项 Skill 时按这些已验证笔记与仓库配置继续，不猜不存在的命令。

预热只验证基线，不修业务代码、不跑 UT。Build-Fix 仍可修本次相关代码并运行定向 UT；`-DskipTests` 的成功只算编译，绝不能代替 UT 或远端流水线。不要因“推送前收口”每次都重新全量。
