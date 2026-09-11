# 问题流阶段边界压缩

2026-09-11 立项。对话拍板:问题流补上需求侧 TaskService.maybeCompact 同源的主动压缩,
但按问题流自己的地形收窄——

1. **只在 analysis_confirm 确认(分析→修复)的续聊前必压一次**,不搞"每个关键
   节点都压":早期边界上下文还轻,压是纯开销;分析→修复那一刻上下文正是一生中
   最重的(拉过的日志、贴过的报错原文、定位探针输出,全是压缩指令里明列可丢弃
   的过程性探索),带着它们进 fix 正是注意力漂移的源头。
2. **其余续聊回合交给事件量阈值旋钮**(events.jsonl 增量,缺省 0=关),与需求侧
   compactEveryEvents 同款纪律。
3. **边界专用锚**:在「标题+阶段+单号」之上钉住分析报告落盘路径与「修改方案」
   章节要点——摘要保指针,原始日志可丢。

## 安全边界(实现不许越)

- 只在新回合入口压(resumeTurnBody 的 continueWith 之前);挂起通道
  resumeWithDecision(AskUserQuestion 原地续跑)绝不压——pi 的 compact 会中止
  进行中的运行,挂起的人工节点也算进行中。
- 重启重建(startResume,新上下文)不压。
- 压缩 fail-open:压不动回合照走。
- 超限自愈(turnWithOverflowRepair)不动,继续做自己的一次性补救。

## 票

- [01-continuation-compact-choke.md](issues/01-continuation-compact-choke.md) —
  续聊回合压缩咽喉 + 事件量阈值旋钮(无阻塞)
- [02-analysis-fix-boundary-compact.md](issues/02-analysis-fix-boundary-compact.md) —
  分析→修复边界必压 + 专用锚(阻塞于 01)
