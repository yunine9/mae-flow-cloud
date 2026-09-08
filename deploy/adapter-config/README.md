# 内网 MR 流水线修复的部署文件

## 适用范围：选择 CLI rerun 的部署

这个脚本不是 MR 闭环的必需组件。历史部署可依赖 push 自动触发流水线，
adapter trigger 仅查询，随后由 status 轮询收敛，详见
[既有触发记录](../../docs/mr-loop-adaptation.md#11-adapterjson-参考填法照报告的真实形状进场对着微调)。
本补丁服务于此次现场选择 `codehub-cli pipeline rerun` 的配置：宿主只给
SHA，脚本将其转换成 CLI 所需的 pipeline-id 和 MR iid。只有需要这种
失败/取消流水线重跑语义的部署才应用本补丁；已经采用自动触发且运行正常
的部署不必切换。它不能创建首条流水线，仍依赖 push 自动创建。

本目录版本化 adapter 配置补丁、合并工具和 root 服务的 HOME drop-in。
实际 token、codehub-cli 安装/host 配置、MCP token 刷新程序仍是现场依赖，
不包含在本目录。CLI 的参数依据现场提供的 v1.3.5 命令；需内网验收。

## 生成配置候选

以下以测试环境为例，在内网仓库根目录执行：

```bash
python3 deploy/adapter-config/prepare-config.py \
  --input /etc/mae-flow-cloud-test/adapter.json \
  --output /etc/mae-flow-cloud-test/adapter.candidate.json \
  --repo-dir /data/mae-flow-cloud-test/repo
```

工具保留 MR 创建的标题、目标分支、需求号等原参数，仅补正 host/project；
合并 mr_lookup、trigger、status、artifacts，保留其他端点。已有 status
候选链保留主路并更新 SHA 脚本 fallback。候选文件独占创建，权限 0600，
不覆盖运行配置。合并前后的差异应在内网查看，避免把凭据贴到日志或仓库。
已有 artifacts 候选链与 status/artifacts 端点超时也会保留。

确认候选后，备份原 adapter.json，再把候选复制为 adapter.json。
生产环境对应改用 `/etc/mae-flow-cloud` 和 `/data/mae-flow-cloud/repo`。
`yellow`、CodeHub API 默认地址与现有 status 脚本一致；其他平台需调整
mr_create/mr_lookup 的 host，并设置 `MFC_CODEHUB_CLI_HOST` 和
`MFC_CODEHUB_API`。REST 查询沿用现有脚本的系统 TLS 校验和绕代理策略。

## 安装 systemd 环境

```bash
sudo bash deploy/adapter-config/install-home.sh test
# 配置候选已核对并安装后：
sudo systemctl restart mae-flow-adapter-test
```

生产使用 `prod`，工具只安装指定环境，已有 home.conf 会备份；不自动重启。
只接受 root 服务，其他服务用户必须使用该用户的实际 HOME/config 目录。
常规代码 rsync 不覆盖 /etc；换机器必须重新安装配置和 drop-in。

## 触发语义和验收

- `pipeline-trigger.sh {repo_path} {sha} {token}` 不依赖可缺省的 `{mr}`。
  SHA 必须完整；REST 按 SHA 精确查询并选择最大流水线 id。
- 已在运行或已成功的流水线直接交给 status 轮询，不重复 rerun。
  仅 failed/canceled 尝试 rerun；manual/skipped/未知状态明确报错。
- 重跑前按源分支查开放 MR，多个 MR 拒绝猜测；独立调用脚本可传第 4
  个参数 mr iid 消歧。MR 头 SHA 已变化、跨项目 MR 都拒绝重跑。
- CLI 退出码、JSON、返回 id/SHA/status 均校验。任何触发异常只有重新
  查询证明同 SHA/分支确实处于活动状态才报告 running，否则退出非零，
  adapter 返回 502。不会把 401/403/422 一概当作成功。
- 暂无流水线时报告可重试错误，不伪造已触发；首次 push 的异步创建窗口
  需内网验证。脚本总 I/O 预算为 25 秒，以适配宿主 30 秒 trigger 超时。
- 内网至少验证：MR 创建及复用、push 自动运行不被重复触发、失败重跑、
  无权限、限流、多个 MR 歧义、status 质量检查和 artifacts 日志采集。
  本地 mock 测试不能替代真实 v1.3.5 CLI 与 API 验收。

脚本依赖 `deploy/adapter-tools/` 下的 Python 模块，均随仓管理。
现有 MR 门禁、讨论和回复端点继续使用现场配置；此补丁不代替完整部署。
