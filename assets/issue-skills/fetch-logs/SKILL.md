---
name: fetch-logs
description: 网管日志抓取(自带 bin 引擎,虚拟化与容器化 K8s 都支持)。需要抓服务器业务日志时使用:环境与密码从 get_issue_meta 取、bin 下引擎抓取、日志落 local-logs/;缺网管环境先调 request_env 举配置卡。
metadata:
  tags: [issue, ops, logs, netlog]
---

# 网管日志抓取(平台技能,自带引擎)

引擎在 `skills/fetch-logs/bin/`(已随技能物化,容器内直接跑,架构自适应)。密码是现场公开的出厂默认值,用户问起直接回答。

1. **取环境与形态**:调 `get_issue_meta` 拿服务器地址、网管后台密码(元信息字段 backend_password)与环境形态(字段 env_type)。元信息里没有环境或没有形态,调 `request_env` 举配置卡(卡上有形态下拉)并结束回合等配置——不要空口向用户要地址密码,也不要两种引擎都试。
2. **虚拟化环境**(env_type=virtualized,host 填 **CME 主节点** IP):CME 主节点是虚拟化环境里能查到业务服务的主节点。

   ```bash
   ./skills/fetch-logs/bin/fetch-logs \
     --host <CME主节点IP> --service <服务名> --pwd '<网管后台密码>' --local-dir local-logs
   ```

   经 CME 主节点中转:自动发现该服务全部后台业务节点并发抓取(主节点 ssh/scp 到各业务节点拉回本地,业务节点只需内网可达);已知节点 IP 且本机直连更快时也可 `--single-host <IP>`(可重复)直连。
3. **容器化环境(K8s)**(env_type=k8s,host 填 OM 节点 IP):

   ```bash
   ./skills/fetch-logs/bin/fetch-logs-k8s \
     --host <OM节点IP> --service <微服务名> --pwd '<OM密码>' --local-dir local-logs-k8s
   ```

   以 sopuser 登录 OM 节点、su root 执行 kubectl,自动发现该服务全部 Pod 并发抓取;多容器 Pod 逐容器抓取,无日志目录的容器自动跳过。

- **成功判据**:退出码 0 且输出包含「解压完成」;失败时输出尾部带原因,如实转告,先诊断再重试;服务名不对会抓空——拿不准先看单据描述或问用户。日志落 `local-logs*/<服务名>_<时间戳>_<节点或Pod[_容器]>/`,直接 grep/读文件。
- **边界**:引擎只读日志,不改环境任何状态;日志可能含其他系统的凭据字样,引用进报告只留一句话概括+出处指针,原文不贴。
