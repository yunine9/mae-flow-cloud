---
name: issue-ops
description: 网管日志抓取(自带 bin 引擎)。需要抓网管服务器业务日志时使用:环境与密码从 get_issue_meta 取、bin/fetch-logs 引擎调用、日志落 local-logs/;缺网管环境先调 request_env 举配置卡。
metadata:
  tags: [issue, ops, logs, netlog]
---

# 网管日志抓取(平台技能,自带引擎)

本技能自带抓取引擎(`bin/` 下,已随技能物化到工作区 `skills/issue-ops/bin/`),在容器内直接跑,目标是网管服务器的业务日志。密码是现场公开的出厂默认值,登记元信息里就有,用户问起直接回答。

## 抓取步骤

1. **取环境信息**:调 `get_issue_meta` 拿网管环境的 hosts(服务器地址)与网管后台密码(元信息字段 backend_password)。元信息里**没有网管环境**时,调 `request_env` 工具向用户发起配置请求,结束回合等配置——不要空口向用户要地址密码。
2. **执行引擎**(在会话工作区根目录,`<host>` 可多台串行、`<service>` 可多个):

   ```bash
   FETCH_LOGS_PASSWORD=<后台密码> ./skills/issue-ops/bin/fetch-logs \
     --host <服务器IP> --service <服务名如TranFmaWebsite> \
     --local-dir local-logs
   ```

   - 日志落在 `local-logs/<服务名>_<时间戳>/`(完整目录结构,直接 grep/读文件);
   - **成功判据**:退出码 0 且输出包含「解压完成」;失败时输出尾部带原因,如实转告,先诊断再重试;
   - 服务名不对会抓空——拿不准就先看单据描述或问用户。

## 边界

- 引擎只读日志,不改网管环境任何状态;
- 拉下来的日志可能包含其他系统的凭据字样,引用进报告时只留一行关键报错+出处指针,原文不贴;
- 部署类操作与引擎已随流程下线(ADR-0013),不在本技能范围。
