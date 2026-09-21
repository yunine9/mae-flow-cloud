# fetch-logs

虚拟化环境服务业务日志拉取工具。从 CME 主节点抓取指定服务的全部业务日志到本地，经 CME 主节点 `ipmc_adm statusapp` 自动发现所有后台业务节点并由 CME 主节点中转**并发抓取**，每节点一个独立目录。

## 功能

- 经 CME 主节点 `ipmc_adm -cmd statusapp` 自动发现运行该服务的所有后台业务节点（多节点全发现）
- CME 主节点中转抓取（默认）：CME 主节点 ssh/scp 到业务节点（内部 IP）抓日志、拉回本地，**不依赖业务节点大网 IP**，最通用
- 多节点**并发**抓取（信号量限并发上限 5，某节点失败不影响其他）
- 备选 `--single-host` 本机直连 SFTP 下载（节点 IP 本机可达时用，最快）
- 每节点产出独立目录 `<服务名>_<时间戳>_<节点内部IP>/`，互不覆盖

## 环境要求

- **Go 1.21+**：用于构建本工具
- **CME 主节点**：能跑 `ipmc_adm statusapp` 查到业务服务（**不是 OSMU 主节点**——OSMU 只跑管理 agent，查不到业务服务），且需自带 `expect`（用于驱动 ssh/scp 到业务节点）
- 业务节点 SSH 端口固定 22，sopuser/ossuser 共用密码

> **CME 主节点 vs OSMU 主节点**（最大易错点）：`--host` 必须用 CME 主节点（通常 IP 末位 `.5`/`.196`），不是 OSMU 主节点（`.2`/`.193`）。选错会报"未发现任何节点"但服务其实已部署。

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
# 命令行直传（推荐）—— --host 用 CME 主节点（.5/.196），自动发现所有后台业务节点
./fetch-logs \
  --host 141.71.43.196 --service FarsFrontendService --pwd '<密码>'

# 直连指定节点（备选，跳过发现，本机直连 SFTP 下载）
./fetch-logs \
  --single-host 60.14.46.16 --single-host 60.14.46.17 \
  --service TranFmaWebsite --pwd '<密码>'

# 配置文件（同目录 config.toml）
./fetch-logs

# --help 看完整用法
./fetch-logs --help
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--host` | 二选一 | **CME 主节点** IP（能查到业务服务；不是 OSMU 主节点），自动发现所有后台节点并经中转抓取（主力） |
| `--single-host`（可重复） | 二选一 | 直连指定的目标服务器 IP，本机直连 SFTP 下载（备选） |
| `--service`（可重复） | 是 | 服务名，抓取 `/var/log/oss/MAE/<服务名>` 全部内容 |
| `--pwd` | 是 | sopuser/ossuser 共用密码，命令行直传 |
| `--local-dir` | 否 | 本地保存目录，默认 exe 同目录下 `local-logs` |
| `--help` | — | 显示用法 |

> **固定值**（无需配置）：登录用户 `sopuser`、日志读取用户 `ossuser`、日志基础目录 `/var/log/oss/MAE`、SSH 端口 22。

### 取值优先级

CLI 显式参数 > `config.toml`

## 产物

每业务节点一个独立目录（目录名含节点内部 IP），内部结构与服务器上 `/var/log/oss/MAE/<服务名>/` 完全一致：

```
local-logs/
├── FarsFrontendService_<时间戳>_172.28.130.37/   # 节点 1（内部 IP）
├── FarsFrontendService_<时间戳>_172.28.130.38/   # 节点 2
└── FarsFrontendService_<时间戳>_172.28.130.39/   # 节点 3
```

## 注意

- 抓取的是 `/var/log/oss/MAE/<服务名>/` 下**全部内容**（含子目录、跟随符号链接的真实文件），不筛选不裁剪
- 多节点并发，某节点失败不影响其他，全部完成后汇总错误
- CME 主节点中转路径要求 CME 主节点上有 `expect`（OSS 节点一般自带，用于驱动 ssh/scp 到业务节点）
- 密码会经命令行/SSH 传给 `su`，可能被进程列表或日志捕获，仅限受信环境
- **`--host` 选错节点（OSMU 主节点）会报"未发现任何节点"**——换成 CME 主节点（`.5`/`.196`）重试

## 与容器化 fetch-logs-k8s 的区别

| | fetch-logs（虚拟化） | fetch-logs-k8s（容器化） |
|---|---|---|
| 接入 | SSH 到 CME 主节点中转 | SSH 到 OM 节点跑 kubectl |
| 节点发现 | `ipmc_adm statusapp`（CME 主节点） | `kubectl get pods`（OM 节点） |
| 账号 | sopuser → ossuser | sopuser → su root |
| 日志路径 | `/var/log/oss/MAE/<服务名>` | `/opt/log/`（全部，多容器各不同） |
| 下载 | CME 中转 scp + SFTP | `kubectl cp` + SFTP |
