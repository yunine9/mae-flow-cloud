# 在内网本地 PI 上持续巡检

运行地点是能 SSH 到生产的本机，不是生产服务器，也不是外网 Codex。此包不修改 Cloud 内核/服务，不接入生产任务执行链。当前仓库使用 PI 0.84.1；已依据随包 README 和 docs/json.md 核对 `-p --mode json --no-session`：stdin 是初始提示词，stdout 是事件流，启动器取最后一条 assistant message_end。部署时先核实本机 PI 版本和参数；不要因名字相同就假定不同版本行为相同。

## 首次配置

在内网本机拉取本仓代码，确认可用的 `python3`、`ssh`、PI 可执行文件绝对路径；Python 只需标准库，支持 Linux/macOS，Windows 请在 WSL 中运行。

将 [config.example.json](config.example.json) 复制到仓外 `~/.mae-patrol/prod.json`，填写：

- 已经验证过的 SSH 别名、生产服务实际 dataDir，不能照抄旧端口或目录。推荐使用已有只读账号；若账号可写，技能只是行为约束，不构成权限隔离。
- `agent_command` 中 PI 的绝对路径；需要时追加实际 `--provider`、`--model`。沿用内网 PI 已有认证，不把 token 写进本仓或巡检提示词。模型调用不设 token 上限。
- PI 的 provider 插件若必需就保留；巡检配置不要装载会自动写生产、推动 mae-flow 的扩展。`--tools` 不含 edit/write，但 bash 仍有写能力，因此必须结合只读账号和 skill 边界。
- 每个环境用独立配置和 output_dir。定时任务用的 HOME、PATH、PI 配置目录必须与已验证的本地 PI 一致；不要依赖交互 shell 自动加载的变量。

首次由本地 Agent 核实生产目录、账号、PI 身份后运行（替换实际绝对路径）：

```sh
/usr/bin/python3 /ABS/mae-flow-cloud/skills/task-patrol/scripts/run.py --config /ABS/.mae-patrol/prod.json
```

查看 output_dir 下的 `last-run.json`、本轮 `evidence.json` / `report.json` / `changes.json`。采集和 PI 出错保留 failed，不会冒充健康，也不会删掉已有问题。模型格式出错仅影响这轮本机报告，没有自动返工循环。

采集默认每轮最多 30 个任务，可设置 max_tasks（1—200）。少量名额优先老的未完成任务与最近更新任务，其余按本机 cursor.json 跨轮轮换，逐步覆盖其他任务。任务集合变化时可能重复/跳过一轮，不承诺原子全量审计；报告披露 discovered/selected。

默认 parallel_agents=8，按本机能力与网关并发容量可调到 16/32（支持 1—64）。每个任务是独立 PI 进程，完成一个就接下一个，最后另起一个主 PI 汇总。无需依赖 PI 的第三方 subagent 扩展；不递归派生。子 PI 不能 SSH，主 PI 才顺序补证据。令子 PI 共用只读现场可以减少远端压力。子报告在 task-*/report.json，汇总在 report.json；失败任务列入 subreports.json 和 partial 状态，不拖掉其他已完成分析。只读 task.json、waiting.json 和 events.jsonl，每个日志最多尾部 2 MiB，保留最多 100 条事件；有截断标记。需要根因时 PI 可通过 SSH 对明确任务补读相应日志和部署源码，不要扫描整个服务器或读取凭据。

## 定时执行（必须完成，不能只跑一次）

先单次验收，再在**内网本机**配置每 30 分钟执行。使用已有的本机调度器即可；Linux/WSL/macOS 可用 crontab。本地 Agent 读取现有 crontab，按脚本路径和 config 路径检查是否已安装；合并新增一条，不覆盖其他任务、不重复安装。日志目录提前创建。

```cron
*/30 * * * * /ABS/python3 /ABS/mae-flow-cloud/skills/task-patrol/scripts/run.py --config /ABS/.mae-patrol/prod.json >> /ABS/.mae-patrol/prod-scheduler.log 2>&1
```

这是一条可替换参数的模板，不能原样安装 `/ABS`。路径含空格要正确 shell 引用，crontab 中 `%` 要转义。推荐实际安装路径不含空格。安装后回报实际配置、调度条目及下一次执行时间；等下一次调度产生新 `last-run.json` 才能宣称“定时已生效”。本机睡眠/断网/退出 WSL 不会自动唤醒，若要求全天巡检，应运行在持续在线的内网本机上。

同 output_dir 已有一轮运行时，后续 tick 跳过，不排队。每个子 PI 和汇总 PI 默认 20 分钟超时保护，整轮可能含多波并行任务；可按规模调大。跨轮自动跳过，不产生两组巡检；本轮内有配置数量的并行 PI。此限制不是 token 配额。SSH 60 秒采集超时；失败不修改生产，下一调度再试。停用时仅移除这条巡检调度，保留报告与已知问题。

输出默认全部留存在本机私有目录，持续运行会增长：定期归档/清理过期的日期目录与 scheduler.log，保留 known-findings.json 去重历史。不要自动删除生产日志。默认无外发通知；新发现仅记录 changes.json 和本机调度日志。需要消息通知时另行配置用户指定的通道。

## 给部署 Agent 的验收清单

- 真实 PI 单次退出成功，report.json 有覆盖说明；缺证据写 hypothesis，不编根因。
- 同一问题和同一证据下一轮不重复出现在 changes.json；新证据会更新；没有出现不标已修复。
- SSH 故障或 PI 错误时 last-run 为 failed；生产没有变化。
- 定时条目安装一次，看到下一轮真实记录；不要把手工首跑当定时验收。
- 回报实际部署版本核实情况。无法核实就明确 unknown，不能宣称服务是本地 main。
