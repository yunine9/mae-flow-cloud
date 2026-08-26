# 问题流 v2:我的问题会话(与需求内核分离)

问题单处理与需求开发是**两个范式**:需求是目标明确的固定交付流水线,
由内核(`kernel/`,flow.json 状态机)裁决;问题是"路线图式"的动态研究——
可能只定位一下就结束,可能是非问题,可能先研究后补单号,确认要修才进入
编码。因此问题流**刻意不进内核**(这是设计不是缺口,别"修"回去),由
`src/issueFlow/` 独立承载,与 taskService/kernel 零 import。

范式来源:every-skill 仓的 playbook(拿单→建分支→拉日志→对齐→实施→
提交→换库→验证→提MR 的原子能力菜单)。AI 按单子实际情况自主编排,
平台只做三件事:**承载运行、显示阶段、守住门禁**。

## 生命周期

- 登记:「问题处理」页手工登记(单号可空、代码仓可选、网管环境可选:
  地址 + **单一共用密码**),或从 DTS 拉单勾选发起(当前一次一张,
  批量只留了 UI 口子)。
- 会话 = 一条多轮对话 + 一个工作区(`dataDir/issues/<id>/`,克隆固定在
  `repo/`,日志落在 `local-logs/`,结论文档 `issue-analysis.md`)。
- 三条用户输入通道,全部复用 CloudSession 原语:
  - **问题卡作答**:AI 用 AskUserQuestion 挂起(playbook 的人工闸门),
    页面选项/自由作答后回合续跑;
  - **插话**:运行中 steer,当前工具调用完成后送达;
  - **续聊**:回合结束(idle)或重启中断(interrupted)后发消息,
    `continueWith` / `startResume` 续上现场。
- 终态:`archived`(结论三选:非问题/已修复/已提MR)、`canceled`、
  `failed`。**非问题是一等结论**——研究判定误报就出结论归档,
  不强制走编码交付。

## 阶段显示

阶段由 AI 通过 `report_stage` 工具**上报**(枚举 + 一句话 note),宿主
校验落 `issue.json`,前端纯镜像不推断;显示层 fail-open(没上报就只
显示活动时间戳)。真相链:`issue.json` + `events.jsonl`(SSE 尾随与
任务侧同款)。

## 安全边界(比照需求流的同款纪律)

- **秘密止步宿主**:网管环境密码(vault 加密存取)、Git 令牌、DTS/
  Codehub 的 x-auth-token 都只在宿主进程;不进容器、不进模型上下文、
  不进事件流。Pi 运行时本身无 MCP——"AI 调 DTS/Codehub MCP" 由宿主
  工具桥接(协议在宿主终结)。
- **Agent 推不动代码**:克隆 pushurl 指向 /dev/null;推送必须走
  `push_branch` 宿主工具(safeGit 只读视图 + 临时 bare 传输仓 +
  ls-remote 复核)。
- **单号门禁是机械的**:未绑定单号时 `push_branch`/`create_mr` 直接
  拒绝;分支名必须 `master_<工号>_<单号>`。研究免单号,提 MR 前必须
  有——规则写在工具里,不在提示词里。
- 台账保护:GateService 把 `issue.json`、`skills/` 列为宿主账本,
  文件工具拒写(bash 路径的残余风险见诚实清单)。

## 宿主工具与会话技能

工具(会话内):`report_stage` / `fetch_logs`(宿主跑 fetch-logs 二进制,
产物落工作区,Agent grep 真实文件)/ `build_deploy`(宿主跑 build-deploy,
成功哨兵校验)/ `dts_get_ticket` / `push_branch` / `create_mr`(Codehub
MCP:get_codehub_host → get_project_info → create → 超时判重)。

技能(每次会话物化到 `skills/`,改编自 playbook):issue-playbook(路线
图)、issue-research(研究方法与非问题出口)、issue-delivery(分支/提交
格式 `[单号][类型] 描述`/推送/MR)、issue-ops(环境工具用法)。工号 =
登录账号,不再从 $HOME 猜。

## 部署配置(问题流相关)

```json
{
  "dts-mcp-url": "<DTS MCP 网关地址>",
  "codehub-mcp-url": "<Codehub MCP 网关地址>",
  "mcp-token-file": "/etc/mae-flow-cloud/mcp-token",
  "issue-max-turns": 2
}
```

- token 文件权限 600;两个网关共用同一个 token(用户口径)。任一网关
  未配置时对应能力 fail-loud(页面/工具如实报"未配置",不静默降级)。
- 拉日志/换库依赖 `assets/ops-tools` 二进制在场(linux 产物带执行位)。

## 问题流专用部署(--issue-only):需求依赖不阻塞问题流

隔离的落点在启动面:需求流程的重依赖(内核 python、交付平台、prepush、
容器镜像守卫、通知端点)**全部按需加载**;`--issue-only`(或配置文件
`"issue-only": true`)声明本部署只服务问题处理:

- 内核模式整体不启用——缺 `--platform`/`--isolate-image` 的 exit(2)
  守卫不再触发(那是给内核模式部署的 fail-loud,不是给问题流的);
- 需求任务发起被 API 层拒绝,`launch-options` 的 blockers 把停用状态
  摆在明面(前端现有拦截渲染直接复用);
- 在途需求任务不拉起(pump 熔断),台账可读、用完整部署重启同一
  数据目录即自动续跑;
- 通知假件起不来也不阻塞启动(完整部署仍 fail-loud)。

问题流自身的最小依赖只有:模型网关配置、登录、数据目录。`--issue-only`
启动后「问题处理」全功能可用(冒烟:演示模型可跑通登记→首轮→举卡)。

## 与旧 DTS triage 流的关系

旧的"同任务双阶段 triage→hotfix"路径(入口在发起表单的 DTS 页签)
已被本流程**整体取代并删除**(系统未上线,无在途数据,不留遗骸):
entry_kind/issue_context 字段、finishIssueTriage 硬接线、
IssueEnvironmentAdapter 适配器接口与 Go 适配器、旧测试全部移除。
保留的共享基建:凭据保险箱(`.issue-environments/`,两个域按
task-/issue- 前缀互不碰撞)与 assets/ops-tools 二进制(改由问题流的
宿主工具消费)。

## 已知边界(诚实清单)

- 【遗留,待用户提供后接线】DTS MCP 的工具名与返回形状未对拍:
  `src/issueFlow/gateways.ts` 的解析留了显式缝,形状不符会如实报错。
- Codehub MCP 的 create 超时判重逻辑按 playbook 记录实现,未经真网关
  对拍。
- 问题 MR 不接平台的流水线修复环/合入监视(CodeHub 门禁仍是外部权威);
  后续可加只读展示。
- 崩溃恢复是摘要式(重启后按 issue.json + issue-analysis.md 重播种),
  不是上下文无缝续接——与任务侧同一约束(Pi 会话内存驻留)。
- 台账保护覆盖文件工具;bash 内 `echo > issue.json` 这类路径未防
  (重启加载时无篡改校验)。单号门禁不受影响(推送查的是宿主侧状态)。
- 批量处理:列表勾选已就位,当前强制单选。
- build-deploy 的回滚能力二进制未提供;换库验证依赖人工闸门兜底。
