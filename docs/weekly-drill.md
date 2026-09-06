# 每周真模型演练(质量加固计划第四步,2026-09-06 立)

内网每天在修 bug,多数是"链条某一环在真模型、真容器、真平台下才露头"。
演练的目的只有一个:**每周主动把整条链跑一遍,让问题在我们手里露头,而不是
在用户手里。** 发现的问题一律进 GitHub Issues(yunine9/mae-flow-cloud,
`gh issue create`,标签见 docs/agents/triage-labels.md),不在群里口头传。

## 跑什么

固定两条,交替或都跑(每条 60–90 分钟,可断点续跑):

1. **单仓交付**:`交付 REQ…` 需求走到 MR 合入。
2. **跨仓协同**:再挂一个候选仓,走"分析→确认拆分→按仓建子任务→子任务
   合入→下游解阻塞"(2026-09-06 首跑现场:`.pilot/cross-glm53-20260906b`)。

```bash
# 前置:docker context 指向 Colima 且镜像是非 root 的构建镜像(root 镜像会被拒)
docker image inspect mae-flow-task-builder:dev >/dev/null

# 跨仓(把 <日期> 换成 YYYYMMDD;模型走 .local/models.json,别把密钥写进命令)
npm run pilot -- --label cross-<日期> \
  --repo ../mae-flow-fieldtest-java --repo-aux ../mae-flow-fieldtest-java --aux-name web \
  --models .local/models.json --provider glm --model glm-5.3-flash \
  --isolate-image mae-flow-task-builder:dev --timeout-min 90 --max-cards 30 \
  --serve-port 8839 --serve-auth .ui-fixtures/auth.json   # 边跑边看:http://127.0.0.1:8839

# 预算耗尽/被打断:接着跑,不从头来(quota 和进度都是钱)
npm run pilot -- --resume cross-<日期> --timeout-min 30

# 跑完对拍
python3 harness/run-report.py .pilot/cross-<日期>
```

**纪律**:`.pilot/<label>` 现场不删;有容器任务在跑时绝不 `colima start/stop`;
两个测试进程不能同时跑(会互删临时现场)。

## 看什么(逐项打勾,不勾的写原因)

- [ ] 任务列表:父子层级有缩进和连线;子任务标题是「单元 · 需求名」。
- [ ] 进度条随内核 pulse 走(卡在"验证中"不动=问题,先看 `.mae-flow-work/panel-pulse.js`)。
- [ ] 过程文档(spec/design/story)按阶段出现在「材料」;PlantUML 出图不报"无法安全绘制"。
- [ ] 需求确认卡、拆分确认卡、push 前确认卡都出现且措辞与界面按钮一字不差。
- [ ] 批注:文字 + 图片都能发给 Agent,Agent 回执逐条落在意见卡上。
- [ ] Build-Fix 在容器里真编译(Maven 依赖缓存够不够,看 `warmup` 与 push 前日志)。
- [ ] 停摆:如果停了,类别(五类)和"下一步该做什么"读得懂,通知到了人。
- [ ] 子任务 MR 合入后下游子任务自动解阻塞;主任务在全部子任务完成后自动完成。
- [ ] 重启一次服务(`harness/restart-drill.sh` 或 kill -9),任务从停下的地方接上。
- [ ] 五档宽度(1440/1200/900/600/390)各看一眼任务页,没有被裁的面板。

## 发现了问题怎么记

一条问题一个 issue,标题写现象不写猜测,正文三段:**现场**(label、任务 id、
时间点)、**证据**(日志/事件流原文,截图)、**期望**。先打 `needs-triage`;
能立刻复现且定位到文件的打 `ready-for-agent`。修完在 README「已知边界」
写一条"已验/未验"。

## 每周复盘一并看

```bash
scripts/fix-ratio.sh 7     # fix 提交占比与重灾区文件(基线:2026-09-06 前 14 天 35%,taskService 43%)
```
