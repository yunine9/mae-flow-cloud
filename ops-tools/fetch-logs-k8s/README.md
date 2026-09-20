# fetch-logs-k8s

容器化环境（K8s）微服务日志拉取工具。经 OM 节点 kubectl 发现 Pod，**自动遍历 Pod 所有业务容器**并**并发抓取**日志到本地，每 Pod 每容器一个独立目录。

## 功能

- SSH 到 OM 节点（sopuser 登录 su root），经 `kubectl get pods` 发现服务所有 Running Pod（多副本全发现）
- **多容器 Pod 自动遍历**：列出 Pod 所有业务容器（过滤 init），逐容器抓取（单容器 Pod 如 `farsservice-0` 直接抓；多容器 Pod 如 `accesssouth-0` 6 容器逐个抓）
- 无 `/opt/log` 目录的容器自动跳过（不算失败）
- 多 Pod **并发**抓取（信号量限并发上限 5，某 Pod/容器失败不影响其他）
- 容器内 `zip -r` 打包 `/opt/log/` 全部 → `kubectl cp` + SFTP 下载 → 清理
- 每 Pod 每容器产出独立目录 `<服务名>_<时间戳>_<pod名>_<容器名>/`，互不覆盖

## 环境要求

- **Go 1.21+**：用于构建本工具
- **OM 节点**：容器化环境的总节点，上面有 `kubectl` 且 root 有 `exec`/`cp` 权限
- OM 节点 SSH 端口固定 22，sopuser/root 共用密码（root 不允许直接密码登录，sopuser 登录后 su root）

## 构建

```bash
# Windows 编译，产出 fetch-logs-k8s.exe
go build

# 交叉编译 Linux amd64
GOOS=linux GOARCH=amd64 go build -o fetch-logs-k8s-linux-amd64

# 交叉编译 Linux arm64
GOOS=linux GOARCH=arm64 go build -o fetch-logs-k8s-linux-arm64
```

构建产物放到技能目录 `plugins/playbook/skills/fetch-logs-k8s/bin/` 下（和 `config.toml` 同目录）。

## 用法

```bash
# 命令行直传（推荐）—— 多容器 Pod（accesssouth 3 副本 × 6 容器，自动遍历）
./fetch-logs-k8s \
  --host 7.229.157.134 --service accesssouth --pwd '<密码>'

# 单容器服务
./fetch-logs-k8s \
  --host 71.26.146.142 --service farsservice --pwd '<密码>'

# 配置文件（同目录 config.toml）
./fetch-logs-k8s

# --help 看完整用法
./fetch-logs-k8s --help
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--host` | 是 | OM 节点 IP（容器化环境总节点，kubectl 在此节点上） |
| `--pwd` | 是 | OM 节点 sopuser/root 共用密码，命令行直传 |
| `--service` | 是 | 微服务名（匹配 Pod 名，不区分大小写；如 FarsService、accesssouth） |
| `--local-dir` | 否 | 本地保存目录，默认 exe 同目录下 `local-logs-k8s` |
| `--help` | — | 显示用法 |

> **固定值**（无需配置）：命名空间 `mae`、登录用户 `sopuser`（su `root` 执行 kubectl）、容器内日志路径 `/opt/log/`、容器临时目录 `/opt/tmp`、OM SSH 端口 22。

### 取值优先级

CLI 显式参数 > `config.toml`

## 产物

每 Pod 每业务容器一个独立目录，内部结构与容器内 `/opt/log/` 完全一致：

```
local-logs-k8s/
├── accesssouth_<时间戳>_accesssouth-0_med/              # Pod 0 / 容器 med
├── accesssouth_<时间戳>_accesssouth-0_fmdriverservice/  # Pod 0 / 容器 fmdriverservice
├── accesssouth_<时间戳>_accesssouth-0_nccservice/
├── ...
├── accesssouth_<时间戳>_accesssouth-1_med/              # Pod 1 / 容器 med
└── ...
```

## 注意

- 抓取的是容器内 `/opt/log/` 下**全部内容**（含子目录），不筛选不裁剪——多容器 Pod 各容器日志目录名不同，统一打全部
- 多 Pod 并发（上限 5），单 Pod 内多容器串行；某 Pod/容器失败不影响其他，全部完成后汇总错误
- 无 `/opt/log` 目录的容器自动跳过（不算失败）
- 依赖 OM 节点上 `kubectl` 可用且 root 有 `exec`/`cp` 权限
- 容器内 `/opt/tmp` 可写（MAE 容器根文件系统只读）
- 密码会经命令行/SSH 传给 OM 节点，可能被进程列表捕获，仅限受信环境

## 与虚拟化 fetch-logs 的区别

| | fetch-logs（虚拟化） | fetch-logs-k8s（容器化） |
|---|---|---|
| 接入 | SSH 到 CME 主节点中转 | SSH 到 OM 节点跑 kubectl |
| 节点发现 | `ipmc_adm statusapp`（CME 主节点） | `kubectl get pods`（OM 节点） |
| 账号 | sopuser → su ossuser | sopuser → su root |
| 日志路径 | `/var/log/oss/MAE/<服务名>` | `/opt/log/`（全部，多容器各不同） |
| 下载 | CME 中转 scp + SFTP | `kubectl cp` + SFTP |
