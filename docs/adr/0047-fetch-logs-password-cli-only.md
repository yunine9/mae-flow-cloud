# 拉日志引擎密码改 CLI 直传,退役环境变量通道

2026-09-21 拍板(issue #348 技能更新):fetch-logs / fetch-logs-k8s 两引擎的上游新版删除了 `FETCH_LOGS_PWD` / `FETCH_LOGS_K8S_PWD` 环境变量通道,密码只能 `--pwd` 命令行直传;本仓跟进,`fetch-logs` 技能正文改教 AI 用 `--pwd` 传密,不再维护私有兼容层。本仓早前的口径是「密码经环境变量交给子进程,不进进程列表、不落盘」——该纪律建立在此前已删除的 Go 适配器(`issueEnvironmentGoAdapter.ts`)上,随本次一并退役;`build-deploy` 的 `BUILD_DEPLOY_PASSWORD` 环境变量通道不在其列,照旧。

**决定**:

- 技能正文(fetch-logs/SKILL.md)两条抓取命令改 `--pwd '<密码>'` 直传;引擎二进制随技能同步更新为上游新版。
- 宿主侧不做翻译层:不在技能 bin 的 wrapper 里做「环境变量→--pwd」转换,避免与上游工具契约分叉、每次更新都要重验私有 shim。
- `containerRuntime` 容器特权环境变量白名单删去已死的 `FETCH_LOGS_PASSWORD` 键(适配器删除后无人再传),只留 `BUILD_DEPLOY_PASSWORD`。

**理由**:这密码是现场公开的出厂默认口令,不是平台凭据(CONTEXT.md「网管环境」词条、ADR-0003 口径——它本就允许明文进入问题会话的 AI 上下文);引擎跑在单会话的沙箱容器里,进程列表的暴露面不构成新增风险——环境变量前缀写在 AI 的 bash 命令里,本来就同样可见。收益只有与上游对齐:引擎源码真身在 every-skill 仓,本仓只消费产物,契约跟上游走才能让后续更新继续即拷即用。

**边界**:上游新版同时把虚拟化抓取主路径改为 CME 主节点中转(删大网 IP 解析/`node_ip_map`/`ssh_jump`,见 CONTEXT.md「CME 主节点」词条),那属上游工具设计,本仓只随技能落正文与二进制,不另立决策记录。旧版引擎与新版技能正文不兼容(旧版缺 --pwd 时读环境变量,新版只认 --pwd)——bin 必须与 SKILL.md 同批更新,这正是 fetch-logs 整包物化的既有约定。历史文档中的 FETCH_LOGS_PASSWORD 字样随本次清理,ADR-0026/0028 的历史措辞不追溯改写。
