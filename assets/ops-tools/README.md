# 问题单环境运维工具(every-skill 出品)

`src/issueEnvironmentGoAdapter.ts` 消费这组 Go 二进制,把
`IssueEnvironmentAdapter` 的拉日志/换库能力接到 DTS 问题单流程:
凭据由任务保险箱解密后经环境变量注入(`FETCH_LOGS_PASSWORD` /
`BUILD_DEPLOY_PASSWORD`),工具与密码都不进任务工作区。

- `fetch-logs` —— 从网管服务器抓取 `/var/log/oss/MAE/<服务名>` 全量日志
- `build-deploy` —— 本地 Maven 构建 + 部署 webapps(/lib)到网管服务器
  (Windows 宿主需在 Git Bash 环境执行;Linux 原生可用)

## 更新方式

源码在 every-skill 仓 `source/ops-tools/`,改完后三平台编译并把产物
拷回本目录(名字保持 `fetch-logs{.exe,-linux-amd64,-linux-arm64}` 形状):

```bash
cd every-skill/source/ops-tools/<tool>
GOOS=windows GOARCH=amd64 go build -o ../../..//plugins/playbook/skills/<tool>/bin/<tool>.exe .
GOOS=linux  GOARCH=amd64 go build -o .../<tool>-linux-amd64 .
GOOS=linux  GOARCH=arm64 go build -o .../<tool>-linux-arm64 .
cp .../bin/<tool>* <mae-flow-cloud>/assets/ops-tools/
```

工具的入参契约(CLI > 环境变量[密码] > config.toml)与技能用法说明
见 every-skill 仓 `plugins/playbook/skills/<tool>/SKILL.md`。
