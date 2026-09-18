# 01: push 侧重挂流水线监看——修复环只推不建 MR 不再死锁

**What to build:** `push_branch` 成功推送后,凡该仓已有 MR,宿主自动按新
SHA 重挂流水线监看(复用现有挂表入口:幂等,同 SHA 在盯自动跳过,换 SHA
自动迁移红灯账/刹车账)。红灯修复回合 AI 只 push 不再 create_mr(同一
MR 自动跟新提交)时,新提交从此有人盯表;部署验证打回的回退轮(监看账
被清、MR 记录延用)同样被覆盖。绿了收口/提醒申报,红了派修。

背景:issue-72 死锁根因——监看重挂的唯一点火挂在 create_mr 成功回调
上,而修复环的设计语义是"同分支再推,MR 自动跟新提交",不重建 MR;
推送换 SHA 后没有任何监看覆盖新提交,申报门受理等绿后无人唤醒,issue
停在 idle。监看侧的陈灯防御已为此场景备好(拒绝旧 SHA 终态、轮询等新
run 注册),缺的只有点火这一个动作。

**Blocked by:** None (can start immediately).

**Status:** done(2026-09-18)

- [x] 红灯修复回合 AI 只 push_branch 不 create_mr → complete_stage 申报
      "在跑受理" → 新 run 注册后监看器拿到真终态:绿→收口/提醒申报,
      红→打回派修
      (issuePipelineWatchIgnition.test.ts「修复环只推不建 MR」:
      重挂→绿灯结算→申报提醒全链断言)
- [x] 部署验证回退轮(监看账被清、MR 延用)同场景有人盯表,不再依赖
      AI 重走 create_mr
      (点火挂在推送事实上、不查阶段,回退轮清表后的重推与修复环同路;
      「监看账缺席」分支由工单 02 重启补挂用例覆盖)
- [x] 多仓场景 A 红 B 绿,A 重推只重挂 A 的监看
      (onBranchPushed 按仓触发,armPipelineWatch 一仓一表;现有
      多仓用例回归绿)
- [x] 同 SHA 在盯或同 SHA 已结算的仓不受扰(幂等)
      (在盯同 SHA:armPipelineWatch 既有幂等守卫直接跳过;同 SHA 已
      结算在重启补挂路径严格不碰——「重启不重放」用例钉死。push 路
      径对"同 SHA 已结算"的重推会重挂:这是承重行为——没出新提交的
      重推经重挂→再红→落同提交刹车停机,正是刹车要抓的"修了没出新
      提交";绿灯侧重挂只会多发一次申报提醒,有界无害)
- [x] 尚无 MR 的仓首次推送不挂表(保持"有 MR 才监看"语义)
      (service 侧接线以 state.mrs 有该仓为前置)

附带修复:绿灯结算的兜底分支补 !allGreen 守卫——收口点已过的跟进提交
跑绿不再误报"其他仓红灯"开空回合(issuePipelineWatchIgnition.test.ts
「收口点已过的跟进提交跑绿」);issueFlowFixed.part1 不可修用例种子从
七阶段历史形状对齐现行五阶段,不再骑误报分支拿申报提醒。

## 验收记录

- tests/issuePipelineWatchIgnition.test.ts 4/4 绿。
- issueFlowFixed.part1/part2、issueRedCutover、issueMrDiscussions、
  issueTerminalHardening、delivery 全系列、mrLoop 全系列、
  issuePushBranch:除基线存量失败(全链 1 例、归档语义 2 例)外全绿,
  基线 worktree 对跑确认无新增失败。
