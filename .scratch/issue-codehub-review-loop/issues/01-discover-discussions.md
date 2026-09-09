# 01: 检视意见发现与落账(看得见)

**What to build:** 问题处理流程的逐仓 MR 监看旁挂上 CodeHub 检视讨论的查询:直接拉适配层 `GET /mr/discussions`(repo+MR),按 discussion id 增量识别新意见,落进问题域反馈账——用户在工作台反馈面板里能看到"MR 检视:严重度 + 正文 + 文件:行号 + 作者"。本票只做"发现与可见",不注入 AI、不回复。

> 修订(2026-09-08 评审):发现器**直拉明细,不经 gates**——少一个部署前置
> (`mr_gates` 可不配),且"绿灯后亮红也能发现"由拉取天然覆盖;门禁
> (`resolve_discussion_passed`)的语义消费(闭环标注/注入触发)归票 02。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] discussions 客户端(mrClient 同款 HTTP 形状:身份头 percent 编码复用 pipelineHeaders、超时预算、错误带状态码上浮)
- [x] mr_green 监看期内随监看节奏逐仓拉取;**验绿收口即停**(收口后新意见不追)
- [x] 增量识别:按仓内 discussion id 对账(两仓撞号不吞账);意见带 文件/行号/严重度(入 summary 前缀)/作者/正文/revision
- [x] 意见在工作台可见(问题域反馈账,来源标 mr_discussion,面板既有"MR 检视"标签)
- [x] fail-open:适配层未配置(404)/网络失败/坏响应一律等下一轮;循环体异常有 catch 兜底,绝不拖垮流水线主监看
- [x] 范围边界:归档/取消/失败即停(isTerminal);会话关停即止
- [x] 测试:发现/增量/失败容忍/收口即停 四路(FakeGitPlatform 假件)+ 客户端四态(200/404/坏响应/网络拒绝)

