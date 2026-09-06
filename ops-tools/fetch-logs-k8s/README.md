# fetch-logs-k8s

容器化环境（K8s）微服务日志拉取工具。经 OM 节点 kubectl 发现 Pod 并**并发抓取所有副本**日志到本地，每 Pod 一个独立目录。

## 功能

- SSH 到 OM 节点，经 `kubectl get pods` 发现服务所有 Running Pod（多副本全发现）
- 多 Pod **并发**抓取（信号量限并发上限 5，某 Pod 失败不影响其他）
- 容器内 `zip -r` 打包 `/opt/log/<服务名>/` → `kubectl cp` + SFTP 下载 → 清理
- 每 Pod 产出独立目录 `<服务名>_<时间戳>_<pod名>/`，互不覆盖

## 环境要求

- **Go 1.21+**：用于构建本工具
- **OM 节点**：容器化环境的总节点，上面有 `kubectl` 且有 `exec`/`cp` 权限
- OM 节点 SSH 端口固定 22，用户默认 root

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
# 命令行直传（推荐）
FETCH_LOGS_K8S_PWD='<OM密码>' ./fetch-logs-k8s \
  --host 71.26.146.142 --user root --service FarsFrontendService

# 配置文件（同目录 config.toml）
./fetch-logs-k8s

# --help 看完整用法
./fetch-logs-k8s --help
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--host` | 是 | OM 节点 IP（容器化环境总节点，kubectl 在此节点上） |
| `--user` | 否 | OM 节点 SSH 用户，默认 root |
| `--pwd` / 环境变量 `FETCH_LOGS_K8S_PWD` | 是 | OM 节点 SSH 密码 |
| `--service` | 是 | 微服务名（如 FarsService、FarsFrontendService、SWMService） |
| `--local-dir` | 否 | 本地保存目录，默认 exe 同目录下 `local-logs-k8s` |
| `--help` | — | 显示用法 |

> **固定值**（无需配置）：命名空间 `mae`、容器内日志路径 `/opt/log/<服务名>`、容器临时目录 `/opt/tmp`、OM SSH 端口 22。

### 取值优先级

CLI 显式参数 > 环境变量（仅密码 `FETCH_LOGS_K8S_PWD`）> `config.toml`

## 产物

每 Pod 一个独立目录，内部结构与容器内 `/opt/log/<服务名>/` 完全一致：

```
local-logs-k8s/
├── FarsFrontendService_<时间戳>_<pod1>/
│   └── FarsFrontendService/...
├── FarsFrontendService_<时间戳>_<pod2>/
└── FarsFrontendService_<时间戳>_<pod3>/
```

## 注意

- 抓取的是 `/opt/log/<服务名>/` 下**全部内容**（含子目录），不筛选不裁剪
- 不拉 `/opt/log/dump/`（共享转储目录，在服务目录外；如需 core/heap dump 单独 `kubectl cp` 拉）
- 不做时间过滤（全量拉取）
- 多 Pod 并发，某 Pod 失败不影响其他，全部完成后汇总错误
- 密码会经 SSH 传给 OM 节点，可能被进程列表捕获，仅限受信环境

## 与虚拟化 fetch-logs 的区别

| | fetch-logs（虚拟化） | fetch-logs-k8s（容器化） |
|---|---|---|
| 接入 | SSH 直连业务节点 | SSH 到 OM 节点跑 kubectl |
| 节点发现 | `ipmc_adm statusapp`（网管节点） | `kubectl get pods`（OM 节点） |
| 账号 | sopuser → ossuser | OM root + 容器内 ossadm |
| 日志路径 | `/var/log/oss/MAE/<服务名>` | `/opt/log/<服务名>` |
| 下载 | SFTP 递归下载 | `kubectl cp` + SFTP |
