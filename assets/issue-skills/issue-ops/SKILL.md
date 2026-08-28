---
name: issue-ops
description: 网管环境的日志拉取与换库部署工具用法。需要 fetch_logs 或 build_deploy 时查看。
metadata:
  tags: [issue, ops, logs, deploy]
---

# 网管环境操作(宿主工具)

两个工具都在宿主侧执行,密码由平台保管;你只提供目标参数。

## fetch_logs(services, hosts?)

- 抓 `/var/log/oss/MAE/<服务名>` 的**全部内容**(含子目录)到 `local-logs/<服务名>_<时间戳>/`;
- hosts 缺省用会话配置的网管环境;
- 大目录耗时较长属正常;完成后直接在 local-logs/ 里 grep,不要把整个日志读进上下文。

## build_deploy(repo?, hosts?, include_lib?)

- 构建 `repo` 参数指定的代码仓并部署到目标服务器(缺省首个登记仓;**多仓会话必须显式指定要部署哪个仓**),部署前自动备份(版本号_bak时间戳);
- **默认只更新 webapps**;`include_lib=true` 仅当 pom.xml 依赖版本变更;
- 部署完成后**必须**停下(AskUserQuestion)请用户验证——"程序说部署成功"不等于"验证通过"。

## 失败处理

工具报错会带原始输出:如配置/密码/网络/服务器权限问题,如实呈现给用户,不要盲目重试(尤其部署)。
