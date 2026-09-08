# 内网 adapter 配置修正

已有链路是 push 自动触发流水线，trigger 只查询，status 轮询收敛。
本次问题属于现场 adapter.json 的命令配置；不新增 trigger 脚本，
不调用 rerun，也不改变宿主流程。

## 合并配置

`mr-pipeline.patch.json` 是配置片段，不能直接替换完整 adapter.json。
以现场完整配置为基础，先备份再合并以下修正：

1. 在原 `mr_create.command` 中补正 `--host yellow --project {repo}`，
   保留源/目标分支、标题、token、需求号等原有参数和输出抽取规则。
2. 加入片段中的 `mr_lookup`：查同源/目标分支的开放 MR，按
   `0.web_url` / `0.iid` 抽取，启用已有的先查后建逻辑。
3. 用片段中的 `pipeline_trigger` 替换错误的 rerun 配置。
   它只调用 REST GET 按 SHA 查询，不依赖宿主未传的 `{mr}`。
   HTTP 错误通过 curl 非零退出上报；成功后返回 running 表示进入轮询，
   不代表新建或重跑了流水线。查询为空也可等待 push 的异步创建；
   真实状态与质量结论由后续 pipeline_status 决定。
4. status/artifacts 使用仓库已有脚本。将 `@REPO_DIR@` 替换为实际
   仓库绝对路径（测试通常 `/data/mae-flow-cloud-test/repo`，生产通常
   `/data/mae-flow-cloud/repo`）。已有 MCP 主路和自定义候选链应保留，
   只更新对应的脚本候选，保留现场超时配置。

其他端点、token_file、端口等保持现场配置。令牌和完整现场配置不要入库。
此片段依据用户提供的内网分析及仓库契约整理，未读取实际部署的完整 JSON。
CLI 的 `yellow` 别名及 v1.3.5 参数、REST 地址需在内网核验。

## systemd HOME

`home.conf` 是现场 root 服务的环境配置模板。根据服务用户确认 HOME 后，
分别安装到所需环境的目录：

- `/etc/systemd/system/mae-flow-adapter-test.service.d/home.conf`
- `/etc/systemd/system/mae-flow-adapter.service.d/home.conf`

已有文件先备份；运行 `systemctl daemon-reload` 后，重启对应服务生效。
非 root 服务必须改成其实际用户目录。普通代码 rsync 不会安装这些 /etc
配置，换机器需重新部署。

## 验收及仓库边界

本次补齐的是配置片段和 HOME 模板。status/artifacts、pipeline_log.py
及 MCP 客户端此前已经在 `deploy/adapter-tools/` 中，不需要新增脚本。
CLI 安装、host 配置、令牌和现场令牌刷新程序仍属于外部部署依赖。

内网验证：首次 push 自动触发、trigger 不产生额外 rerun、已有 MR 复用、
指定 SHA 的 status/checks 和失败材料采集，以及无权限时如实报错。
本地 adapter 回归测试不能代替这次真实部署验收。
