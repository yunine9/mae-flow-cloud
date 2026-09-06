# fetch-logs

虚拟化环境服务业务日志拉取工具。从网管服务器抓取指定服务的全部业务日志到本地，经网管节点 `ipmc_adm statusapp` 自动发现所有后台节点并**并发抓取**，每节点一个独立目录。

## 功能

- 经网管节点 `ipmc_adm -cmd statusapp` 自动发现运行该服务的所有后台节点（多节点全发现）
- 多节点**并发**抓取（信号量限并发上限 5，某节点失败不影响其他）
- 内部 IP 自动解析大网（可达）IP，`node_ip_map` 可显式覆盖
- 内网节点可配 `--ssh-jump` 走跳板（expect 驱动 ssh/scp）
- 每节点产出独立目录 `<服务名>_<时间戳>_<节点IP>/`，互不覆盖

## 环境要求

- **Go 1.21+**：用于构建本工具
- **网管节点**：能跑 `ipmc_adm statusapp`，用于自动发现业务节点
- 业务节点 SSH 端口固定 22，sopuser/ossuser 共用密码

## 构建

```bash
# Windows 编译，产出 fetch-logs.exe
go build

# 交叉编译 Linux amd64
GOOS=linux GOARCH=amd64 go build -o fetch-logs-linux-amd64

# 交叉编译 Linux arm64
GOOS=linux GOARCH=arm64 go build -o fetch-logs-linux-arm64
```

构建产物放到技能目录 `plugins/playbook/skills/fetch-logs/bin/` 下（和 `config.toml` 同目录）。

## 用法

```bash
# 命令行直传（推荐）—— 自动发现所有后台节点
FETCH_LOGS_PWD='<密码>' ./fetch-logs \
  --host 141.71.43.195 --service FarsFrontendService

# 直连指定节点（备选，跳过发现）
FETCH_LOGS_PWD='<密码>' ./fetch-logs \
  --single-host 60.14.46.16 --single-host 60.14.46.17 \
  --service TranFmaWebsite

# 配置文件（同目录 config.toml）
./fetch-logs

# --help 看完整用法
./fetch-logs --help
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--host` | 二选一 | 网管节点 IP，自动发现所有后台节点（主力） |
| `--single-host`（可重复） | 二选一 | 直连指定的目标服务器 IP，跳过发现（备选） |
| `--service`（可重复） | 是 | 服务名，抓取 `/var/log/oss/MAE/<服务名>` 全部内容 |
| `--pwd` / 环境变量 `FETCH_LOGS_PWD` | 是 | sopuser/ossuser 共用密码 |
| `--local-dir` | 否 | 本地保存目录，默认 exe 同目录下 `local-logs` |
| `--ssh-jump` | 否 | 跳板机 IP，内网节点无法直连时配置 |
| `--help` | — | 显示用法 |

> **固定值**（无需配置）：登录用户 `sopuser`、日志读取用户 `ossuser`、日志基础目录 `/var/log/oss/MAE`、SSH 端口 22。

### 取值优先级

CLI 显式参数 > 环境变量（仅密码 `FETCH_LOGS_PWD`）> `config.toml`

## 产物

每节点一个独立目录，内部结构与服务器上 `/var/log/oss/MAE/<服务名>/` 完全一致：

```
local-logs/
├── FarsFrontendService_<时间戳>_141.71.43.56/   # 节点 1
├── FarsFrontendService_<时间戳>_141.71.43.57/   # 节点 2
└── FarsFrontendService_<时间戳>_141.71.43.58/   # 节点 3
```

## 注意

- 抓取的是 `/var/log/oss/MAE/<服务名>/` 下**全部内容**（含子目录、跟随符号链接的真实文件），不筛选不裁剪
- 多节点并发，某节点失败不影响其他，全部完成后汇总错误
- 密码会经命令行/SSH 传给 `su`，可能被进程列表或日志捕获，仅限受信环境
- 自动发现依赖网管节点上可执行 `ipmc_adm statusapp`；CME 集群应用须经 CME 节点自身查询（而非网管节点）

## 与容器化 fetch-logs-k8s 的区别

| | fetch-logs（虚拟化） | fetch-logs-k8s（容器化） |
|---|---|---|
| 接入 | SSH 直连业务节点 | SSH 到 OM 节点跑 kubectl |
| 节点发现 | `ipmc_adm statusapp`（网管节点） | `kubectl get pods`（OM 节点） |
| 账号 | sopuser → ossuser | OM root + 容器内 ossadm |
| 日志路径 | `/var/log/oss/MAE/<服务名>` | `/opt/log/<服务名>` |
| 下载 | SFTP 递归下载 | `kubectl cp` + SFTP |
