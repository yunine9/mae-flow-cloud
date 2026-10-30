# Git AI 归因接入

需求、问题单及其子 Agent 共用宿主 Pi 事件适配。Git AI 在现有非 root
任务容器执行，记录 Write、Edit 和 Bash 修改，接收同一容器的 Git 提交事件。
不需要安装全局 Pi 扩展，不挂载模型配置、原生会话文件或 Docker Socket。

## 部署

1. 准备匹配容器 CPU 架构的 Git AI 二进制。本仓以官方 v1.7.5 验证，内网
   定制版需用同一验证脚本复验；不要自动跟随 latest。
2. 在临时构建目录放置命名为 `git-ai` 的二进制，使用本目录
   `git-ai.Dockerfile` 叠加到已批准的任务镜像。传入该制品的已核实 SHA256：

   ```sh
   docker build -f deploy/build-image/git-ai.Dockerfile \
     --build-arg TASK_BUILDER_IMAGE=<已批准的任务镜像> \
     --build-arg GIT_AI_SHA256=<已核实的二进制SHA256> \
     -t <带GitAI的任务镜像> <临时构建目录>
   ```

3. 将执行服务的任务镜像切换到该镜像，并设置 `MFC_GIT_AI_ENABLED=1`。
   可用 `MFC_GIT_AI_BIN` 指定**容器内**的绝对可执行路径，默认
   `/opt/git-ai/bin/git-ai`。未启用时没有归因命令、Notes 网络操作或流程变化。

初次使用时在容器临时 HOME 创建 Git AI 配置，默认关闭遥测、自动升级与
版本检查，使用本地 prompt 存储和 Git Notes 后端。管理员可在镜像预配配置。
Cloud 只传入真实模型、会话标识和文件路径，不传入会话正文，`session_path`
固定为 `/dev/null`。容器重建后可重新初始化；仓库 `.git/ai` 和 Notes 随代码
工作区保留，临时 HOME 中的 usage 数据不作为任务统计来源。

## 提交与传输

每次修改结束后等待 Git AI 完成该批归因，再由原流程继续执行。归因子进程
卡住时只终止该观察命令，不使用会销毁任务容器的 Bash 超时选项。初始化、
检查点、归因保留或 Notes 同步失败只记宿主日志，不否决工具、提交、代码
推送或 MR，不新增状态、审批、修复轮数或重推流程。

宿主重建提交说明、整理多条提交、清理平台文件和纠正单号时，按旧提交树
的实际行来源保留已知归因；没有证据的行不推断成 AI。普通 Agent 提交及
amend 交给 Git AI 自身处理。

需求、问题单均在代码分支推送并核实成功后，使用同一目标和凭据沙箱同步
`refs/notes/ai`。只发送该提交可达的文件行号、Pi 工具名、模型名和匿名
会话标识，不发送提示词、会话原文、原始会话 ID、作者个人信息或宿主路径。
只追加远端缺少的 Notes，保留已有记录；并发非快进不会强推，也不会重推
代码。可以在下一次正常代码推送时再同步缺少的归因。

归因在 `.git` 内，不成为工作区代码变更。`git-ai stats <SHA> --json` 和
`git-ai blame <文件>` 可读取归因；其他克隆需显式 fetch `refs/notes/ai`。
现有首次实现占比和 Cloud Token 用量继续使用各自统计，不能替换为临时
容器的 `usage --json`。

官方 v1.7.5 有已复现的准确性边界：同一文件先有未提交修改，再由 Bash
修改并提交时，已有修改可能一起归给 AI。平台保持上游归因含义，不把未知
修改强行标成已确认的人工贡献。这些数据用于辅助观察，不能当作精确人机
贡献证明；直接 Write/Edit、Bash、Git 改写的兼容性与这个统计边界分别验收。

## 验证

定向测试：`node --import tsx --test tests/gitAi.test.ts`。
真实二进制验证使用 `scripts/verify-git-ai.mjs`，在装有 Git AI 的临时容器内
运行，使用合成仓库，不需要网络、真实模型或业务凭据。该脚本同时检查
修改、提交、混合人工修改、容器运行时恢复以及匿名 Notes 的兼容性。

从仓库根目录准备测试包（使用本仓已安装依赖）：

```sh
git_ai_verify_dir=$(mktemp -d)
node_modules/.bin/esbuild --bundle --platform=node --format=esm \
  --outfile="$git_ai_verify_dir/adapter.mjs" <<'EOF'
export * from './src/gitAi.ts';
export * from './src/gitAiNotes.ts';
EOF
cp scripts/verify-git-ai.mjs "$git_ai_verify_dir/"
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /home/mae-flow:rw,nosuid,nodev,size=256m,mode=1777 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=1g,mode=1777 \
  -e TMPDIR=/tmp -e MFC_GIT_AI_VERIFY_DISPOSABLE=1 \
  -v "$git_ai_verify_dir:/verify:ro" --entrypoint node \
  <带GitAI的任务镜像> /verify/verify-git-ai.mjs /verify/adapter.mjs
rm -rf "$git_ai_verify_dir"
```

只允许在明确声明为临时、且 Git AI HOME 为空的 Docker 容器运行此脚本。
恢复用例会清除该容器的 Git AI 临时运行数据，但保留合成仓库，验证新会话
仍能接续记录。不要把宿主 HOME 或真实业务目录挂入验证容器。
