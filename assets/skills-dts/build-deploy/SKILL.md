---
name: build-deploy
description: 把本地 Java/JS 项目构建并部署/更新到网管服务器(问题修复的换库验证环节)。默认只更新 webapps;仅当 pom.xml 依赖变更时才同时更新 lib。需要内网配置(config.toml),配置缺失或连不上时如实报告,不假装部署成功。
metadata:
  tags: [deploy, java, js, maven, build, ssh, sftp, webapps, lib, multi-host]
---

# 一键构建+部署

从本地 Java/JS 项目构建并部署到网管服务器(验证环境)。

## 工具位置(云端)

宿主已把本技能(含工具)物化到任务工作区:
`skills-dts/build-deploy/bin/`——相对任务工作区根(仓库克隆的上一级
目录)。按运行环境选二进制:Windows 用 `build-deploy.exe`,Linux 容器
用 `build-deploy-linux-amd64`(或 `-arm64`,按 `uname -m`)。程序按
exe 目录读取 `config.toml`——先 cd 到 bin/ 再运行。
`project_path` 指向本任务的仓库克隆目录(工作区内那个仓库文件夹)。

## 使用步骤

1. **就位**:`cd <任务工作区>/skills-dts/build-deploy/bin/`。
2. **确认配置**:检查 `config.toml`,必填项已填写(`project_path`、
   `password`、`hosts`)。**配置是内网管理员填的**:必填项仍是注释
   状态就说明内网没配好——如实告诉用户"部署工具未配置",用
   AskUserQuestion 问用户如何继续(用户自行部署/跳过验证),不要硬跑
   也不要假装部署过。
3. **选模式并后台执行**:先按下节判断是否要更新 lib,再后台运行
   (含 Maven 构建+远端部署,通常 2-5 分钟、多台更久,前台会因 Bash
   超时中断),等待完成。
4. **等待并核验**:从末尾 `=== 日志 ===` 汇总找成功哨兵——
   ```
   [INFO] 服务器 <IP> 部署完成 (x/y)      # 或最终 [INFO] 部署完成
   ```
   若出现错误(`mvn 命令执行失败`、连接失败、密码错误、远端命令报错),
   把错误原文呈现给用户,并指出是配置、密码、网络还是服务器问题。
5. **汇报结果**:告知用户已部署哪些服务器、自动备份的版本号
   (`版本号_bak时间戳`)。部署完成后提醒用户进入第 8 步人工验证。

## 部署模式(运行前先判断)

**强烈建议默认模式(include_lib = false)**:项目依赖的 lib 极少变化,
默认只更新 webapps 即可覆盖绝大多数部署场景,且上传更快。

| 模式 | 说明 | 适用场景 |
|------|------|------|
| **默认模式(推荐)** | 仅更新 webapps,lib 不动 | 绝大多数场景:页面改动、前后端更新 |
| **include_lib 模式** | 同时更新 lib 和 webapps | 仅当 pom.xml 依赖版本发生变更时 |

判断:本次改动只涉及页面/前后端 → 保持默认;涉及 pom.xml 依赖版本
变更 → 在 config.toml 设 `include_lib = true`。

## 配置项(参考)

| 配置项 | 类型 | 必填 | 说明 | 示例 |
|--------|------|------|------|------|
| project_path | string | 是 | 本任务的仓库克隆目录(Java/JS 项目根) | 工作区内的仓库文件夹 |
| password | string | 是 | sopuser 用户密码 | (管理员填写) |
| include_lib | bool | 否 | 是否同时更新 lib 目录,默认 false | `false` |
| hosts | string[] | 是 | 目标服务器 IP 列表,串行部署 | `["141.71.88.205"]` |

> 固定流程(无需配置):用户切换链 `sopuser → ossadm → ossuser`、
> 备份 `版本号_bak时间戳`、`ipmc_adm` 重启应用。
> 注意:路径必须使用单引号包裹,否则 Windows 路径中的反斜杠会被当作
> 转义符(如 `\t` 变 TAB)。

## 注意事项

- 项目必须包含 `deployment/pom.xml`(用于提取服务名和 app.name)
- 默认模式只上传 webapps,大幅减少上传时间和带宽
- 部署前自动备份当前版本到 `版本号_bak时间戳`
- 远端命令失败会中止并报告错误,不会静默成功
- 多服务器串行部署:构建一次,依次上传+部署到每台服务器;某台失败
  中止后续部署
