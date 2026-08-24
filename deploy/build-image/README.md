# Mae-Flow Cloud 统一任务构建镜像

这个镜像只承载任务的命令执行面，不承载 Mae-Flow 内核、Pi 会话、Git
凭据、模型配置或 Docker Socket。首版兼容基线为 JDK 21、Maven 3.9.9、
Node 18.16.1/npm 9.5.1，以及 JavaScript、Java、C++ 仓需要的常见本地
工具链。

## 构建

开发机可用 Dockerfile 中已经固定 manifest digest 的公共默认镜像验证：

```bash
docker build \
  -f deploy/build-image/Dockerfile \
  -t mae-flow-task-builder:dev \
  deploy/build-image
```

内网生产构建必须把两个基础镜像同步到内部镜像仓，并使用审批过的
digest，不能依赖可漂移的 tag：

```bash
docker build \
  --build-arg JAVA_MAVEN_BASE_IMAGE=registry.intra/build/maven-jdk21@sha256:<approved-digest> \
  --build-arg NODE_BASE_IMAGE=registry.intra/build/node-18.16.1@sha256:<approved-digest> \
  -f deploy/build-image/Dockerfile \
  -t registry.intra/mae-flow/task-builder:2026.08 \
  deploy/build-image
```

若内网完全离线，先由运维导入上述两个镜像。如果内部 Java/Maven
基础镜像已经包含 Dockerfile 列出的 OS 工具，可加
`--build-arg INSTALL_OS_PACKAGES=false`，构建过程仍会逐项校验工具，缺失
时立即失败。否则基础镜像必须已配置能访问的内部 apt 镜像。

`BUILDER_UID`、`BUILDER_GID` 默认都是 `10001`。生产环境优先用运行
Mae-Flow Cloud 的服务账号 UID/GID 重建镜像。服务若由 root 守护进程
启动，必须显式配置数字形式的 `--isolate-user <uid>:<gid>`；Cloud 会在
每次任务容器启动前，只把实际 bind 的代码工作区和平台构建缓存交给该
用户；宿主 Write/Edit 与内核状态换新后也会立即修正对应文件，不会改任务
控制面或凭据目录。禁止用 `umask 0000` 代替所有权处理。

最终镜像不能假设任务用户属于 root 组。所有预装 CLI、JDK/Node 环境脚本
必须让普通用户可读/执行，CA 路径的每一级目录必须可遍历，证书文件必须
可读。标准 Dockerfile 会在切换到 `USER builder:builder` 后用 `sh -lc`
再次验证这些条件；基于自有 rootfs 派生镜像时也必须保留同等检查。

## 运行时挂载约定

每个仓库使用独立的 Maven、npm、ccache 和 XDG 缓存目录。下面仅展示挂载
约定，具体 CPU、内存、PID、临时磁盘和网络限制由 Cloud 运行时统一
下发：

```text
<task-workspace>:<same-absolute-path>:rw
<cache-root>/<repository-id>/maven:/cache/maven:rw
<cache-root>/<repository-id>/npm:/cache/npm:rw
<cache-root>/<repository-id>/ccache:/cache/ccache:rw
<cache-root>/<repository-id>/xdg:/cache/xdg:rw
<deploy-config>/settings.xml:/etc/mae-flow/maven/settings.xml:ro
<deploy-config>/company-ca.pem:/etc/mae-flow/ca/company-ca.pem:ro
<deploy-config>/java-cacerts:/opt/java/openjdk/lib/security/cacerts:ro
tmpfs:/home/mae-flow:rw,nosuid,nodev,mode=1777
tmpfs:/tmp:rw,exec,nosuid,nodev,mode=1777
```

- `settings.xml` 可从 `maven-settings.example.xml` 复制后填写内部 mirror，
  **不得包含可复用用户名、密码或 Token**。Agent 与仓库构建脚本共享容器
  身份，任何能供 Maven 读取的静态秘密也能被业务代码读取。内部依赖仓应
  使用隔离网络内的只读代理/机器身份；若平台不得不鉴权，只能给每 attempt
  短时、只读、最小范围凭据，并把“业务代码可见”纳入风险接受。
- `company-ca.pem` 供 Git/npm 扩展系统信任链；TLS 校验始终保持开启。
- Java 使用合并了公司 CA 的 `java-cacerts`。它是公开证书的信任库，不应
  包含客户端私钥。也可以直接使用已经导入公司 CA 的内部 JDK 基础镜像，
  此时无需挂载这两个 CA 文件。
- 不挂载宿主 `HOME`、Cloud 数据目录、模型/Git/通知凭据或
  `/var/run/docker.sock`。Git clone/fetch/push 仍由宿主可信控制面完成。
- 只读根文件系统下，运行时必须给 `/home/mae-flow` 和 `/tmp` 提供任务
  专属 tmpfs，并挂载四个 `/cache` 子目录；入口脚本会在空 tmpfs 中重建
  `.m2` 等用户目录，绝不能因缺挂载而回退宿主执行。
- `/tmp` 必须显式带 `exec`。Docker tmpfs 的隐含 `noexec` 会让 Maven
  Jansi、SQLite/JNA 等 Java 原生库无法加载；任务本来就能在工作区执行
  构建产物，因此这里使用 `exec` 不会扩大既有命令执行权限。

入口脚本会在容器启动时检查所有缓存目录是否可写，并仅在对应只读文件
存在时接入 Maven settings 和公司 CA。任何挂载或权限错误都会直接失败，
不会退回宿主执行。

## 发布前验证

至少执行一次真实容器自检：

```bash
docker run --rm --init mae-flow-task-builder:dev sh -lc '
  java -version && mvn --version && node --version && npm --version &&
  gcc --version && g++ --version && bison --version && flex --version &&
  ccache --version && git --version && python3 --version
'
```

然后分别用 Java、JS 和 C++ 代表仓验证增量编译与 UT。仍需由部署方给出
的值只有：两个基础镜像 digest、内部 apt/Maven/npm 地址及 CA、Cloud
服务账号 UID/GID、缓存根目录，以及任务容器的资源与网络限额。
