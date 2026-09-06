---
name: issue-ops
description: 网管日志抓取(自带 bin 引擎,虚拟化与容器化 K8s 都支持)。需要抓服务器业务日志时使用:环境与密码从 get_issue_meta 取、bin 下引擎抓取、日志落 local-logs/;缺网管环境先调 request_env 举配置卡。
metadata:
  tags: [issue, ops, logs, netlog]
---

# 网管日志抓取(平台技能,自带引擎)

引擎在 `skills/issue-ops/bin/`(已随技能物化,容器内直接跑,架构自适应)。密码是现场公开的出厂默认值,用户问起直接回答。

1. **取环境与形态**:调 `get_issue_meta` 拿服务器地址、网管后台密码(元信息字段 backend_password)与环境形态(字段 env_type)。元信息里没有环境或没有形态,调 `request_env` 举配置卡(卡上有形态下拉)并结束回合等配置——不要空口向用户要地址密码,也不要两种引擎都试。
2. **虚拟化环境**(env_type=virtualized,host 填网管节点 IP):

   ```bash
   FETCH_LOGS_PWD=<后台密码> ./skills/issue-ops/bin/fetch-logs \
     --host <网管节点IP> --service <服务名> --local-dir local-logs
   ```

   自动发现该服务全部后台节点并发抓取;已知节点 IP 也可 `--single-host <IP>`(可重复)直连。
3. **容器化环境(K8s)**(env_type=k8s,host 填 OM 节点 IP,SSH 用户默认 root):

   ```bash
   FETCH_LOGS_K8S_PWD=<OM密码> ./skills/issue-ops/bin/fetch-logs-k8s \
     --host <OM节点IP> --service <微服务名> --local-dir local-logs-k8s
   ```

   自动发现该服务全部 Pod 副本并发抓取。

- **成功判据**:退出码 0 且输出包含「解压完成」;失败时输出尾部带原因,如实转告,先诊断再重试;服务名不对会抓空——拿不准先看单据描述或问用户。日志落 `local-logs*/<服务名>_<时间戳>_<节点或Pod>/`,直接 grep/读文件。
- **边界**:引擎只读日志,不改环境任何状态;日志可能含其他系统的凭据字样,引用进报告只留一行关键报错+出处指针,原文不贴。
