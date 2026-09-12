# 内网 MR 流水线配置修复

本目录以现场提供的六端点 adapter.json 为基础，修正配置并收编所有本次
新增的部署实现。生产参考配置为 `adapter.codehub.json`；可合并的 MR/流水线
端点补丁为 `mr-pipeline.patch.json`。token 不入库，监听端口与凭据设置沿用现场。

## 内网 Agent 本次只负责部署和验收

这里的修复实现已经提交完成，下面不是让内网 Agent 再实现一遍的开发任务。

1. 先记录当前代码提交、服务对应的工作目录和配置路径。若内网已经修改了
   源码或脚本，保留 diff 和修改原因回传；不要覆盖、继续补丁或自行合并。
2. 用已经同步的仓库版本部署，代码与 deploy 必须来自同一个提交，包含
   `d02c4b0` 的修复。不要复活历史版本的 pipeline-trigger.sh，也不要混用
   测试/生产目录中的脚本。工作副本存在未提交源码修改时，先停下回传差异。
3. 按下文生成测试配置候选，核对路径、端口、凭据来源及实际配置差异。
   允许调整的现场值是脚本根目录、端口、凭据文件路径与文档列出的环境
   变量；不修改字段映射、查询逻辑、Python/TypeScript 或 CLI 源码。
4. 备份并安装候选，重启测试 adapter **和 serve**：此次客户端 iid 兼容
   在 serve 进程中，只重启 adapter 不会加载完整修复。
5. 验证现有 MR 的只读接口和正常修复链路，回传验收记录。不要为了测试
   生命周期主动关闭、合入或重跑真实 MR；终态查询可用已有历史 MR 样本。

若出现 CLI 不支持字段、API 响应不同、401/403、TLS 错误、缺少 state/SHA
或超时，记录失败命令、退出码、脱敏 stdout/stderr、HTTP 状态及实际 JSON
字段。停止该项验收并回传，本仓修复后再部署。不要现场新增兜底脚本、修改
判定或用常量把验收“跑绿”。服务受影响时恢复已有备份和原部署版本。

回传内容应包括：部署提交、实际环境/配置路径、配置差异、两项服务状态，
以及每个接口的脱敏请求/响应。只有“容器启动、Agent running”不算验收通过。

## 已修正

- 保留 push/MR 自动触发机制。trigger 只做按完整 SHA 的 REST GET，
  请求成功后进入 status 轮询；不调用 rerun，也不使用新增 trigger 脚本。
  空列表或已有红/绿灯不从 trigger 直接进入裁决，HTTP 错误仍上报。
- mr_create 与 mr_lookup 都提取项目内 iid。mr_create 的 host/project、
  分支、标题、需求号和身份参数保留现场用法。宿主门禁客户端会优先从已存
  MR URL 提取 iid，兼容旧配置保存了全局 id 的任务。
- status/artifacts 继续调用原有收编脚本。
- mr_gates 调用仓内 `deploy/adapter-tools/mr-gates.py`，只读合并 MR
  详情和原 codehub-cli gate 输出。生命周期来自详情的 state，绝不从
  merge_status 或门禁布尔 state 推断。已合入/已关闭无需再查询门禁。
- 详情 SHA 通过 adapter 的 mr_sha 抽取回传，供已有的合入版本核验使用。
  缺失/无效生命周期、SHA、iid 或查询失败均报错，不伪装 opened。
- mr_discussions 使用 `codehub-cli mr review list` 查询未解决检视意见，
  从每条 discussion 的 `notes[0]` 提取正文、作者、文件、行号与更新时间。
  配置进入生产和测试 adapter 后，持续检视不再因端点缺席反复收到 404。
- gate 整体预算 8 秒，adapter 超时 9 秒，与宿主 10 秒查询预算对齐。

`mr-gates.py` 不是重跑脚本：它仅组合两个已有查询的字段。配置、查询桥、
适配器字段支持和回归测试均在本仓，内网不需要再自行编写实现。

## 内网应用：先测试环境

必须先把**同一个提交的代码、deploy 目录全部同步**到内网；只换 JSON
会缺少 mr-gates.py 或 mr_sha 支持。下面命令在测试仓库根目录执行，按实际
位置替换配置路径。本节只操作测试环境；生产升级在测试验收后另行执行。

生成候选文件（保留现场端口、token_file、其他端点及已有候选链）：

```bash
python3 - /etc/mae-flow-cloud-test/adapter.json \
  /etc/mae-flow-cloud-test/adapter.candidate.json "$PWD" <<'PY'
import json, os, sys
from pathlib import Path
source, destination, root = map(Path, sys.argv[1:])
config = json.loads(source.read_text())
patch = json.loads((root / 'deploy/adapter-config/mr-pipeline.patch.json').read_text())
for key, spec in patch.items():
    spec['command'] = [part.replace('@REPO_DIR@', str(root.resolve())) for part in spec['command']]
    if key in ('pipeline_status', 'pipeline_artifacts', 'mr_gates', 'mr_discover'):
        assert Path(spec['command'][1]).is_file(), spec['command'][1]
    existing = config.get(key, {})
    if key in ('pipeline_status', 'pipeline_artifacts'):
        if 'timeout_s' in existing:
            spec['timeout_s'] = existing['timeout_s']
        candidates = existing.get('candidates')
        if candidates:
            name = Path(spec['command'][1]).name
            matches = [i for i, c in enumerate(candidates) if any(name in str(p) for p in c.get('command', []))]
            position = matches[0] if matches else min(1, len(candidates))
            retained = [c for i, c in enumerate(candidates) if i not in matches]
            retained.insert(position, spec)
            patch[key] = dict(existing, candidates=retained)
config.update(patch)
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump(config, output, ensure_ascii=False, indent=2)
    output.write('\n')
print('候选已生成:', destination)
PY
```

候选独占创建，不会覆盖已有文件。该补丁依据本次贴出的 MR 创建参数；若
现场有额外参数而候选会丢失，回传差异，不要自行改源码或猜映射。
检查候选后安装并重启对应服务：

```bash
sudo cp -p /etc/mae-flow-cloud-test/adapter.json \
  /etc/mae-flow-cloud-test/adapter.json.bak.$(date +%Y%m%d%H%M%S)
sudo install -m 600 /etc/mae-flow-cloud-test/adapter.candidate.json \
  /etc/mae-flow-cloud-test/adapter.json
sudo systemctl restart mae-flow-adapter-test
sudo systemctl restart mae-flow-serve-test
```

内网验收：已有 MR 不误判关闭，task-4 的 MR 查询使用 iid 2931；失败后
修复产生新 SHA 能续推；trigger 不额外 rerun；status 返回真实检查和日志；
平台合入后返回 merged 和对应源 SHA，开放但不能合入仍返回 opened。
这里的本地测试覆盖真实 adapter 和查询桥，平台 I/O 用夹具替代，未声称
已远程部署或已通过内网真实验收。

## systemd 与依赖

`home.conf` 是现场 root 服务的模板，按环境安装到
`/etc/systemd/system/mae-flow-adapter{,-test}.service.d/home.conf`，
已有文件先备份，再 `systemctl daemon-reload` 并重启对应服务。
非 root 用户改用其实际 HOME。普通 rsync 不会安装 /etc 文件。

运行依赖：Python 3、curl、codehub-cli（沿用现场 yellow host 和
CODEHUB_TOKEN 支持）、原有 MCP 客户端及 token 配置。查询桥 API 默认
`https://codehub-y.huawei.com/api/v4`，可用 MFC_CODEHUB_API 覆盖；CLI host
可用 MFC_CODEHUB_CLI_HOST 覆盖。REST 使用系统 TLS 校验并绕过代理，
与原 pipeline-status.sh 一致。密钥及现场刷新程序不写进配置样例。
