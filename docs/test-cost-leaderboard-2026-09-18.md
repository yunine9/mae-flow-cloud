# 测试耗时与性价比榜单(2026-09-18,258s 轮)

口径:逐文件独立计时(`npx tsx --test`,8 路并行),347 文件快层(npm test 运行集);
累计文件耗时 1946.6s,墙钟 **258s**;性价比 = ms/断言(每买一条断言花多少毫秒,越低越值)。
族标记:K=真调 python 内核族,S=真起服族,E=剧本模型 E2E。`红`=当轮失败,全部为在飞 WIP 所致(非测试问题)。
注意:单文件数值有 ±20~90% 运行噪声(测量机同时有开发活动),排名看方向。

## 一、绝对耗时 Top 30

| 耗时 | 族 | 断言 | 用例 | ms/断言 | 文件 |
|---|---|---|---|---|---|
| 66.4s | - | 29 | 3 | 2289 | remoteDeliveryReconcile |
| 66.3s | K | 260 | 32 | 255 | pushConfirmation |
| 64.1s | - | 34 | 2 | 1886 | ciPushFreshness |
| 51.1s | K | 50 | 11 | 1022 | kernelHostAttest |
| 33.9s | K | 201 | 38 | 169 | taskHostTools |
| 31.4s | - | 81 | 22 | 388 | deliveryAnalytics |
| 30.0s | E | 32 | 6 | 936 | prepushContainerIntegration.part2 |
| 24.3s | S | 10 | 4 | 2432 | serveConfig.part1 |
| 24.1s | E | 12 | 3 | 2006 | prepushIntegration.part1 |
| 24.0s | S | 14 | 4 | 1716 | serveConfig.part2 |
| 23.8s | E | 30 | 6 | 793 | issueRedCutover |
| 23.1s | E | 260 | 30 | 89 | issueFlowService |
| 20.7s | E | 18 | 7 | 1148 | issueReviewLoopHardening |
| 20.4s | E | 14 | 4 | 1460 | issueGreenCutover |
| 19.6s | E | 89 | 14 | 220 | issueStageExit |
| 17.9s | E | 23 | 3 | 780 | issueMrDiscussions |
| 16.0s | - | 27 | 5 | 594 | mrLifecycleWatch |
| 16.0s | E | 28 | 7 | 572 | interrupt |
| 15.6s | - | 36 | 6 | 433 | mrDescription |
| 15.3s | E | 47 | 9 | 325 | repositorySkillFlow 红 |
| 15.0s | E | 71 | 9 | 211 | reviewDecisionContract |
| 14.7s | E | 37 | 10 | 396 | issueFlowContract |
| 13.2s | - | 39 | 10 | 339 | repositorySkills |
| 13.2s | E | 29 | 3 | 455 | prepushContainerIntegration.part1 |
| 12.3s | E | 14 | 3 | 876 | issueMergeFact |
| 12.2s | S | 5 | 2 | 2444 | demoFresh |
| 12.2s | E | 141 | 25 | 87 | artifacts 红 |
| 12.0s | K | 74 | 8 | 163 | deliveryUnitSplit |
| 11.9s | E | 35 | 5 | 339 | steerKnowledge |
| 11.6s | E | 61 | 6 | 190 | issueRepoChange |

## 二、≥3s 文件按性价比排序(ms/断言 降序,最差在前,共 199 个)

| ms/断言 | 耗时 | 断言 | 用例 | 文件 |
|---|---|---|---|---|
| 2951 | 5.9s | 2 | 1 | concurrency |
| 2444 | 12.2s | 5 | 2 | demoFresh |
| 2432 | 24.3s | 10 | 4 | serveConfig.part1 |
| 2289 | 66.4s | 29 | 3 | remoteDeliveryReconcile |
| 2006 | 24.1s | 12 | 3 | prepushIntegration.part1 |
| 1918 | 5.8s | 3 | 1 | retry |
| 1886 | 64.1s | 34 | 2 | ciPushFreshness |
| 1716 | 24.0s | 14 | 4 | serveConfig.part2 |
| 1574 | 4.7s | 3 | 1 | kernelCommitRedirect |
| 1460 | 20.4s | 14 | 4 | issueGreenCutover |
| 1326 | 5.3s | 4 | 4 | pipelineMcpSchema |
| 1292 | 5.2s | 4 | 1 | taskCreateRollback |
| 1148 | 20.7s | 18 | 7 | issueReviewLoopHardening |
| 1120 | 4.5s | 4 | 2 | humanFacingStyle |
| 1105 | 5.5s | 5 | 2 | bypassCrash |
| 1052 | 5.3s | 5 | 1 | issueFlowSubagent |
| 1051 | 11.6s | 11 | 5 | issueWatchdog |
| 1024 | 6.1s | 6 | 1 | pipelineVerdictSyncGuard |
| 1022 | 51.1s | 50 | 11 | kernelHostAttest |
| 996 | 5.0s | 5 | 1 | issueLubanApproval.part1 |
| 986 | 4.9s | 5 | 1 | requirementReviewLifetime |
| 977 | 5.9s | 6 | 0 | decisionAnnotationReplay |
| 936 | 30.0s | 32 | 6 | prepushContainerIntegration.part2 |
| 890 | 4.5s | 5 | 2 | issueAutoArchiveControl |
| 876 | 12.3s | 14 | 3 | issueMergeFact |
| 840 | 5.0s | 6 | 2 | reviewReceipt |
| 801 | 8.8s | 11 | 0 | kernelReviewRequest |
| 793 | 23.8s | 30 | 6 | issueRedCutover |
| 780 | 17.9s | 23 | 3 | issueMrDiscussions |
| 740 | 3.7s | 5 | 2 | apiMirrorContract |
| 726 | 10.2s | 14 | 5 | issueLogFetch |
| 714 | 10.0s | 14 | 4 | repositoryBaseline |
| 706 | 6.4s | 9 | 1 | deliveryUnitMaterials |
| 644 | 4.5s | 7 | 2 | sessionFileOwnership |
| 636 | 3.8s | 6 | 1 | feedbackResultPayloadDigest |
| 628 | 5.0s | 8 | 1 | pipelineArtifacts |
| 625 | 5.0s | 8 | 0 | compileSkillConsumption |
| 609 | 8.5s | 14 | 3 | issueTerminalHardening |
| 601 | 4.8s | 8 | 3 | hookFlush |
| 598 | 5.4s | 9 | 3 | deliveryPlatformProbe |
| 594 | 16.0s | 27 | 5 | mrLifecycleWatch |
| 589 | 5.3s | 9 | 3 | kernelDeliveryInfraRetry |
| 583 | 5.2s | 9 | 0 | componentKnowledgePlanning |
| 572 | 16.0s | 28 | 7 | interrupt |
| 568 | 4.5s | 8 | 1 | workspaceReviewNode |
| 544 | 6.0s | 11 | 0 | annotationConcurrency |
| 540 | 5.4s | 10 | 2 | launchTeamFixes |
| 531 | 4.8s | 9 | 1 | requirementBundleAgent |
| 483 | 8.7s | 18 | 6 | issueCompaction |
| 459 | 6.9s | 15 | 5 | taskControl |
| 456 | 5.9s | 13 | 5 | compaction |
| 455 | 13.2s | 29 | 3 | prepushContainerIntegration.part1 |
| 451 | 6.8s | 15 | 4 | progressVocabulary |
| 451 | 5.0s | 11 | 4 | taskKnowledgeSource |
| 436 | 5.2s | 12 | 2 | issueContainerLifecycle |
| 435 | 11.3s | 26 | 4 | executionContinuity |
| 433 | 15.6s | 36 | 6 | mrDescription |
| 432 | 6.0s | 14 | 3 | prepushSkip |
| 425 | 5.5s | 13 | 6 | cloneCredentialBoundary |
| 424 | 8.1s | 19 | 4 | deliverySelection |
| 424 | 4.7s | 11 | 2 | subagentModelError |
| 421 | 3.8s | 9 | 1 | workflowAssetRegistry |
| 411 | 6.2s | 15 | 2 | issueRerunIsolation |
| 410 | 3.3s | 8 | 2 | annotationExcerpt |
| 397 | 6.0s | 15 | 1 | annotationPendingActions |
| 396 | 14.7s | 37 | 10 | issueFlowContract |
| 388 | 5.0s | 13 | 2 | reviewReplyScheduling |
| 388 | 31.4s | 81 | 22 | deliveryAnalytics |
| 383 | 5.4s | 14 | 4 | issuePullRepoOwnership |
| 381 | 4.2s | 11 | 5 | issueSkillsDrift |
| 370 | 6.7s | 18 | 3 | auxiliarySessions |
| 357 | 5.0s | 14 | 1 | reviewClarification |
| 352 | 6.0s | 17 | 3 | issueFlowVision |
| 349 | 8.0s | 23 | 4 | issuePushBranch |
| 339 | 11.9s | 35 | 5 | steerKnowledge |
| 339 | 13.2s | 39 | 10 | repositorySkills |
| 333 | 5.0s | 15 | 4 | tokenUsage |
| 326 | 5.2s | 16 | 4 | parkedNoticeDelivery |
| 325 | 15.3s | 47 | 9 | repositorySkillFlow 红 |
| 321 | 5.5s | 17 | 2 | requirementBusinessModule |
| 320 | 5.1s | 16 | 3 | hostSkillShelf |
| 319 | 8.6s | 27 | 5 | agentEvidenceRecovery |
| 314 | 6.6s | 21 | 5 | taskDiagnostics |
| 298 | 9.2s | 31 | 10 | feedbackLoop |
| 294 | 5.3s | 18 | 3 | issueLubanApproval.part2 |
| 293 | 6.2s | 21 | 2 | reviewParticipation |
| 292 | 5.0s | 17 | 4 | taskAgentFiles |
| 291 | 5.5s | 19 | 5 | visionCapability |
| 287 | 6.9s | 24 | 3 | prepushRecovery |
| 285 | 5.7s | 20 | 4 | issueBusinessKnowledge |
| 274 | 5.2s | 19 | 4 | issueSkillSelection |
| 273 | 3.5s | 13 | 4 | modelTransport |
| 263 | 5.0s | 19 | 4 | requirementDocument |
| 262 | 6.8s | 26 | 3 | server 红 |
| 259 | 6.5s | 25 | 3 | requirementReviewAssets |
| 255 | 66.3s | 260 | 32 | pushConfirmation |
| 254 | 5.1s | 20 | 7 | issueRepoContextFiles |
| 250 | 5.7s | 23 | 3 | reviewCancellation |
| 239 | 5.5s | 23 | 1 | requirementReviewAcceptance |
| 237 | 6.6s | 28 | 5 | prepushLiveEvents |
| 236 | 5.7s | 24 | 4 | issueMaterialsDiff |
| 227 | 4.5s | 20 | 6 | issueOnceRates |
| 224 | 4.9s | 22 | 4 | taskSkillSync |
| 223 | 5.4s | 24 | 3 | memoryGovernance |
| 222 | 8.0s | 36 | 8 | baselineWarmup |
| 221 | 4.2s | 19 | 3 | reviewHandoff |
| 221 | 5.3s | 24 | 9 | requirementBundle |
| 220 | 19.6s | 89 | 14 | issueStageExit |
| 216 | 5.2s | 24 | 4 | skillDistiller |
| 212 | 10.0s | 47 | 11 | terminalAttestation |
| 211 | 15.0s | 71 | 9 | reviewDecisionContract |
| 210 | 8.2s | 39 | 10 | moonlight 红 |
| 209 | 5.8s | 28 | 2 | workflowAssetRoutes 红 |
| 208 | 6.0s | 29 | 3 | configurationCenter |
| 207 | 5.6s | 27 | 5 | knowledgeDocuments |
| 204 | 4.9s | 24 | 4 | memoryConversation |
| 203 | 6.1s | 30 | 6 | crossRepositoryUpdates |
| 202 | 4.6s | 23 | 2 | businessModuleRuntime |
| 199 | 8.9s | 45 | 8 | storyArchitecture |
| 193 | 5.2s | 27 | 6 | startupRecovery |
| 192 | 5.2s | 27 | 5 | askUserQuestionValidation |
| 190 | 10.6s | 56 | 11 | issueInterventionTiers |
| 190 | 11.6s | 61 | 6 | issueRepoChange |
| 183 | 6.9s | 38 | 6 | dtsBranchMatch |
| 180 | 5.0s | 28 | 3 | issueFlowNotify |
| 180 | 5.0s | 28 | 6 | reviewedRegressions |
| 177 | 6.9s | 39 | 8 | pipelineEvidenceFallback |
| 174 | 4.5s | 26 | 5 | issueRepoReclaim |
| 172 | 4.3s | 25 | 7 | foreignBranchCommits |
| 170 | 4.8s | 28 | 10 | kernelHost |
| 169 | 9.0s | 53 | 3 | developerAssistantIntegration |
| 169 | 33.9s | 201 | 38 | taskHostTools |
| 165 | 5.1s | 31 | 10 | idleContainerRelease |
| 165 | 6.0s | 36 | 8 | knowledgeExtraction |
| 163 | 12.0s | 74 | 8 | deliveryUnitSplit |
| 159 | 5.3s | 33 | 5 | containerLifecycle |
| 159 | 5.7s | 36 | 3 | historyActions |
| 156 | 7.2s | 46 | 3 | containerSystemCheck |
| 156 | 4.5s | 29 | 5 | issueAnalysisWorkflow |
| 154 | 5.4s | 35 | 7 | buildCache |
| 151 | 5.7s | 38 | 3 | mainStoryFlow |
| 150 | 10.6s | 71 | 9 | prepushRetry |
| 149 | 3.9s | 26 | 6 | memoryContext |
| 148 | 5.8s | 39 | 10 | earlyPipelineContinuation |
| 147 | 5.2s | 35 | 8 | issueLogs |
| 145 | 5.9s | 41 | 7 | issueMetaPaneSmoke |
| 144 | 5.2s | 36 | 6 | memorySidecar |
| 144 | 4.3s | 30 | 4 | issueFlowErrors |
| 143 | 8.0s | 56 | 12 | maeBuildSupport |
| 142 | 5.1s | 36 | 9 | knowledgeInsights |
| 142 | 6.1s | 43 | 11 | recovery |
| 139 | 4.6s | 33 | 6 | issueRaiseGateTool |
| 138 | 4.4s | 32 | 6 | externalReviewInbox |
| 137 | 5.3s | 39 | 3 | wishWall |
| 136 | 5.3s | 39 | 6 | bashOutputMirror |
| 135 | 5.7s | 42 | 6 | memoryAdoption |
| 134 | 5.0s | 37 | 2 | webHost |
| 133 | 5.6s | 42 | 7 | knowledgeAssetModel |
| 130 | 5.3s | 41 | 5 | concurrentReviewDispatch |
| 128 | 5.0s | 39 | 3 | issueTakeover |
| 125 | 4.9s | 39 | 7 | timeline 红 |
| 124 | 4.8s | 39 | 8 | issueAssignment 红 |
| 123 | 7.5s | 61 | 11 | knowledgeSearch |
| 123 | 5.9s | 48 | 14 | hostSkills |
| 123 | 4.9s | 40 | 6 | issueRemoveRepo |
| 121 | 5.1s | 42 | 8 | ownerDecisionContext |
| 115 | 6.1s | 53 | 9 | deliveryExistingMr |
| 114 | 5.3s | 46 | 6 | dtsModuleBindings 红 |
| 109 | 6.8s | 62 | 18 | knowledgeRepo |
| 107 | 6.3s | 59 | 5 | issueReviewTriage |
| 103 | 6.1s | 59 | 3 | businessModuleLibrary |
| 99 | 6.5s | 66 | 5 | issueFlowMultiRepo |
| 98 | 5.2s | 53 | 8 | pipelineHandoff |
| 91 | 4.5s | 49 | 6 | issueViewMode |
| 89 | 5.6s | 63 | 11 | launchKnowledgeAuthority 红 |
| 89 | 5.5s | 62 | 3 | splitProposal |
| 89 | 23.1s | 260 | 30 | issueFlowService |
| 87 | 4.0s | 46 | 6 | ticketImages |
| 87 | 12.2s | 141 | 25 | artifacts 红 |
| 86 | 5.7s | 66 | 10 | settings |
| 85 | 4.9s | 58 | 7 | taskMemory |
| 85 | 3.3s | 39 | 5 | gitPlatform |
| 84 | 5.9s | 70 | 11 | notifier |
| 83 | 9.9s | 119 | 14 | reviewProcessingGate |
| 80 | 5.1s | 63 | 7 | ownerAnnotationResolution |
| 78 | 9.2s | 118 | 16 | overallStory |
| 78 | 5.3s | 68 | 9 | conversationStream |
| 75 | 7.5s | 100 | 6 | chainAnalysis |
| 74 | 9.7s | 130 | 11 | auth 红 |
| 74 | 5.9s | 80 | 6 | requirementEditing |
| 74 | 5.2s | 71 | 15 | issueConversation |
| 72 | 6.1s | 84 | 13 | taskEarlyStart |
| 61 | 5.8s | 96 | 8 | hostSkillLibrary |
| 52 | 3.2s | 61 | 9 | platformAdapter |
| 50 | 10.0s | 201 | 36 | annotations 红 |
| 49 | 7.6s | 157 | 33 | workspaceUiLogic |
| 46 | 5.3s | 116 | 15 | lubanApproval |
| 46 | 11.3s | 249 | 31 | launchForm 红 |
| 39 | 5.2s | 133 | 15 | memoryPhase3 |

## 三、族群份额

- 剧本 E2E(E):729.2s(37%)
- 内核 python(K):259.8s(13%)
- 真起服(S):60.6s(3%)


## 四、本轮(339s→258s)动作记录

- 删 6 文件(~284s 累计):hostPushRecovery、taskDeliveryHandoff、optionalBuildFix、continuousReviewHostCapability、taskHostSession、prepushIntegration.part2
- serveConfig.part1 root 拒绝 5→2 次起服;part2 旧参数弃用并入旧前端告警同次冷启(两文件 82→48s)
- ciPushFreshness/remoteDeliveryReconcile 查明无空闲等待预算(成本=真实内核轮次),未动


## 五、第三轮(删 pushConfirmation/kernelHostAttest/taskHostTools 三 K 类后)

- 删除:pushConfirmation(66.3s/260断言)、kernelHostAttest(51.1s/50)、taskHostTools(33.9s/201),共 ~151s 累计
- 本轮实测:累计 2184.9s、墙钟 281s、红 17(全为在飞 WIP)——**数字被机器负载抬高 ~20%**
  (证据:未动文件全线膨胀:remoteDeliveryReconcile 66.4→88.3s、serveConfig.part1 24.3→29.8s、
  issueFlowService 23.1→25.0s,膨胀系数 ×1.08~1.33,均值 ~×1.2)
- 按膨胀系数归一的可比口径:累计 ~1947→~1820s(−127s),墙钟 ~258→~234s(同负载下);
  空闲机器预计墙钟 ≈ 累计/8 ≈ 228s
- 族群份额变化:K 内核 13%→6%(剩 132.9s),E 剧本 37%→40%,S 起服 3%
- 代价如实记录:这三个是全榜断言密度最高的一档(255/1022/169 ms/断言),
  需求侧推送确认语义、内核 attest 协议、宿主工具 exactly-once 从此无回归网

## 六、第四轮(删 remoteDeliveryReconcile + ciPushFreshness + prepush 全族)

- 删除 16 文件:remoteDeliveryReconcile(88s)、ciPushFreshness(73s)、prepush 全族 12 个测试文件
  (Agent/BuildPlaybook/ContainerIntegration×2+helpers/Environment/EvidenceContract/Integration.part1+helpers/
  LiveEvents/Recovery/Retry/Skip/prePushVerification)+ 孤儿 helpers 2 个
- gate.sh 同步:prepushEvidenceContract 移出,gate 13→12 个契约文件
- 实测:330 文件、累计 1602.7s、墙钟 **207s**、红 16(全为在飞 WIP)
- push 相关剩余:issuePushBranch(问题侧直推)、pushReviewPolicy(gate)、mrLifecycleWatch 等间接
- 代价如实记录:推送前构建验证(prepush)整环节、CI SHA 新鲜度、远端对账自此无回归网

## 七、第五轮(Top20 去重/去冗,覆盖率守恒)

- 删 4 条跨文件重复测试:issueRedCutover 停靠红灯(greenCutover 同链覆盖)、issueGreenCutover 当场收口(stageExit 更全)、issueFlowService 并发额度(重启恢复翻转真子集)、issueMrDiscussions 关自动修(Test1 逐字重复)、interrupt 赛跑复测、reviewDecisionContract 子集变体、mrLifecycleWatch await_merge 迭代(ADR-0032 用例更严)
- 断言迁移 3 条(收口回执指引→stageExit;意见待判断 open→mrDiscussions Test1;换卡语义归 HumanGate 用例)
- 删恒真/冗余断言 12 处(stageExit×3、hardening×3、flowService×3、interrupt×3、repositorySkills/artifacts 各 1)
- issueRepoChange 终态守卫 3 服务→1;serveConfig 再省 3 次起服(HOME/端口合并、缺文件不另起服、root 形态收敛)
- 定向验证 183/184(唯一红=用户 WIP 既有);全量:墙钟 207→**185s**,累计 1602.7→本节实测
