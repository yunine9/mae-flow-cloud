# 换库部署工具(every-skill 出品)

`src/issueFlow/opsTools.ts` 消费这里的 Go 二进制 `build-deploy`,
把问题会话的换库部署接到流程:凭据经环境变量注入
(`BUILD_DEPLOY_PASSWORD`,容器内走特权白名单),工具与密码都不进
任务工作区。

- `build-deploy` —— 本地 Maven 构建 + 部署 webapps(/lib)到网管服务器
  (Windows 宿主需在 Git Bash 环境执行;Linux 原生可用)

拉日志引擎(fetch-logs / fetch-logs-k8s)不在这里:已迁为平台技能
`assets/issue-skills/fetch-logs/`(整包自带 bin,随技能物化,密码
`--pwd` 直传,见 ADR-0047)。

## 更新方式

源码在 every-skill 仓 `source/ops-tools/`,改完后三平台编译并把产物
拷回本目录(名字保持 `build-deploy{.exe,-linux-amd64,-linux-arm64}` 形状):

```bash
cd every-skill/source/ops-tools/build-deploy
GOOS=windows GOARCH=amd64 go build -o ../../../plugins/playbook/skills/build-deploy/bin/build-deploy.exe .
GOOS=linux  GOARCH=amd64 go build -o .../bin/build-deploy-linux-amd64 .
GOOS=linux  GOARCH=arm64 go build -o .../bin/build-deploy-linux-arm64 .
cp .../bin/build-deploy* <mae-flow-cloud>/assets/ops-tools/
```

工具的入参契约(CLI > 环境变量[密码] > config.toml)与技能用法说明
见 every-skill 仓 `plugins/playbook/skills/build-deploy/SKILL.md`。
