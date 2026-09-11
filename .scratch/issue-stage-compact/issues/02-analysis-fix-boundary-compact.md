# 02: 分析→修复边界必压 + 边界专用锚

**What to build:** analysis_confirm 确认推进进 fix 的那次续聊,无论阈值,必压一次。
锚点在「标题+阶段+单号」之上钉住两样:分析报告(issue-analysis.md)落盘路径,和
报告「修改方案」章节的要点摘录(压缩时刻从盘上现读)。摘要只保指针,原始日志按
压缩指令可丢弃——fix 阶段要的是方案+最近错误结论,不是原始日志。

**Blocked by:** 01(共用 resumeTurnBody 咽喉的压缩前置位与 fail-open 纪律)

**Status:** done(2026-09-11)

- [x] analysis_confirm 确认后的续聊先压再进 fix(模型端 requests 可断言)
- [x] 压缩指令与确认推进通知词都携带报告指针(实现时发现 pi 1.x 的
      手动压缩在单回合历史上走 split-turn 路、customInstructions 不进
      摘要请求——指针因此双通道:锚点照传(多回合历史时生效),通知词
      钉住路径与「修改方案」要点(必达,压缩再多次都在最新回合里))
- [x] 只有 analysis_confirm 确认触发必压:补充意见回流等其余闸口/
      推进不压(skill_select 走独立作答口,同一 continueTurn 咽喉、
      无 boundary 旗,结构上不可达)
- [x] 报告读不出(不应发生)时指针降级为"先重读整份报告",压缩
      照发、fail-open 不挡推进
- [x] 早期边界(dts_info/prep_repo→analyze)不压(boundary 旗只在
      analysis_confirm 的 advance 裁决处挂)
