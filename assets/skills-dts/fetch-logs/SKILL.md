---
name: fetch-logs
description: 从网管服务器获取指定服务的业务日志(排查报错、定位问题):把 /var/log/oss/MAE/<服务名> 的完整日志目录抓取到本地 local-logs/<服务名>_<时间戳>/ 并自动还原目录结构。需要内网配置(config.toml),配置缺失或连不上时如实报告,不编造日志。
metadata:
  tags: [log, fetch, ssh, sftp, oss, mae, debugging]
---

# 爬取服务业务日志

从网管服务器抓取指定服务的全部业务日志到本地。固定使用
`sopuser → ossuser` 切换、目录 `/var/log/oss/MAE/<服务名>`。

## 工具位置(云端)

宿主已把本技能(含工具)物化到任务工作区:
`skills-dts/fetch-logs/bin/`——相对任务工作区根(仓库克隆的上一级目录)。
按运行环境选二进制:Windows 用 `fetch-logs.exe`,Linux 容器用
`fetch-logs-linux-amd64`(或 `-arm64`,按 `uname -m`)。程序按 exe
目录读取 `config.toml`,`local_dir` 也相对 exe 目录解析——先 cd 到
bin/ 再运行。

## 使用步骤

1. **就位**:`cd <任务工作区>/skills-dts/fetch-logs/bin/`。
   用 `uname -s`/`uname -m` 判断该用哪个二进制。
2. **确认配置**:检查 `config.toml`,必填项已填写(`hosts`、`password`、
   `services`,`local_dir` 可省略)。**配置是内网管理员填的**:如果模板
   里的必填项仍是注释状态,说明内网没配好——如实告诉用户"拉日志工具
   未配置",用 AskUserQuestion 问是否改走别的路(用户提供日志/跳过
   拉日志),不要硬跑也不要编造日志。
3. **运行**:日志量小(单服务 10-60 秒)可前台直接跑;大目录/多服务器
   后台执行,避免 Bash 超时。
4. **等待并核验**:从输出末尾找成功哨兵——
   ```
   [INFO] 解压完成: <local_dir>/<服务名>_<时间戳>/，已删除压缩包
   ```
   若出现错误(连接失败、密码错误、`Permission denied`、某服务解压失败),
   把错误原文呈现给用户,并指出是配置、密码、网络还是服务器权限问题。
5. **汇报产物**:每个服务产出一个**解压后的日志目录**(中间 zip 已自动
   解压并删除):
   ```
   <local_dir>/<服务名>_<拉取时间戳>/
   ```

## 配置项(参考)

| 配置项 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| hosts | string[] | 是 | 目标服务器 IP 列表,串行抓取 | `["60.14.46.16"]` |
| password | string | 是 | sopuser/ossuser 共用密码 | (管理员填写) |
| services | string[] | 是 | 服务名列表,抓取 `/var/log/oss/MAE/<服务名>` 全部内容 | `["TranFmaWebsite"]` |
| local_dir | string | 否 | 本地保存目录,默认 exe 同目录下 `local-logs` | `"local-logs"` |

> 固定配置(无需填写):登录用户 `sopuser`、日志读取用户 `ossuser`、
> 日志基础目录 `/var/log/oss/MAE`。

## 注意事项

- 抓取的是 `/var/log/oss/MAE/<服务名>` 下的**全部内容**(含子目录、
  跟随符号链接的真实文件),不筛选不裁剪。
- 大目录(几百 MB ~ GB)远端复制和下载耗时,后台执行并调大等待预算。
- 多服务器串行抓取:某台失败会中止后续服务器;单服务器上某服务失败
  会记录错误继续抓取其他服务。
- 某服务解压失败时程序会保留该 zip 并记录错误,便于手工处理。
