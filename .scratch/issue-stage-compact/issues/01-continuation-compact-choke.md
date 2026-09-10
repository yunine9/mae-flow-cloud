# 01: 续聊回合压缩咽喉——事件量阈值旋钮

**What to build:** 问题单的续聊回合(闸推进通知/用户回复/平台通知/续跑泵)在话递进
在场会话之前,若事件账本(events.jsonl)增量自上次压缩累计达到阈值,先按锚点压缩
一次再续聊。阈值走 issue_max_turns 同款接线:管理页运行时旋钮「问题单压缩事件阈值」
优先,缺席退部署旗,再缺省 0=关(行为与现状全等)。压缩 fail-open:压不动回合照走。

**Blocked by:** None (can start immediately)

**Status:** done(2026-09-11)

- [x] 旋钮缺席(缺省 0)时,续聊回合不产生任何压缩请求(模型端 requests 可断言)
- [x] 旋钮设 N 时,事件增量自上次压缩累计 ≥N 的续聊回合先压再续聊;未到阈值不压
- [x] 挂起通道(resumeWithDecision)与重启重建(startResume)绝不压
- [x] 压缩失败 fail-open,回合照常进行
- [x] 阈值压缩用通用锚点(标题+阶段+单号),与管理页旋钮接线
      (settings.ts + server.ts 兜底 + serve.ts 部署旗)全链生效
