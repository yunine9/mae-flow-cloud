# 内网 MR 流水线配置修复

本目录以现场提供的六端点 adapter.json 为基础，修正配置并收编所有本次
新增的部署实现。生产参考配置为 `adapter.codehub.json`；可合并的六端点
补丁为 `mr-pipeline.patch.json`。token 不入库，监听端口与凭据设置沿用现场。

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
- gate 整体预算 8 秒，adapter 超时 9 秒，与宿主 10 秒查询预算对齐。

`mr-gates.py` 不是重跑脚本：它仅组合两个已有查询的字段。配置、查询桥、
适配器字段支持和回归测试均在本仓，内网不需要再自行编写实现。

## 内网应用：先测试环境

必须先把**同一个提交的代码、deploy 目录全部同步**到内网；只换 JSON
会缺少 mr-gates.py 或 mr_sha 支持。下面命令在测试仓库根目录执行，按实际
位置替换配置路径。生产时改成对应生产目录，不要混用两套脚本路径。

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
    if key in ('pipeline_status', 'pipeline_artifacts', 'mr_gates'):
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
现场随后增加了其他参数，合并时应保留。检查候选后安装并重启对应服务：

```bash
sudo cp -p /etc/mae-flow-cloud-test/adapter.json \
  /etc/mae-flow-cloud-test/adapter.json.bak.$(date +%Y%m%d%H%M%S)
sudo install -m 600 /etc/mae-flow-cloud-test/adapter.candidate.json \
  /etc/mae-flow-cloud-test/adapter.json
sudo systemctl restart mae-flow-adapter-test
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
