# 03: 红灯投递指引拆掉 create_mr 假依赖

**What to build:** 红灯投递指引(red.deliver.guidance)目前教 AI"修完
同分支 push_branch 再 create_mr(同一 MR 会自动跟新提交),平台会重新
监看"——监看重挂被绑在 AI 重新调 create_mr 的编排上,而同一句话又给了
AI 跳过冗余 create_mr 的正当理由(issue-72 即踩此坑)。前置工单 01 落地
后,推送事实本身就触发重挂,文案改为"修完同分支 push_branch——已有
MR 自动跟新提交,平台按新提交重新监看流水线",create_mr 退回"尚未建
过 MR 才需要"的可选项。

**Blocked by:** 01 (push 侧重挂流水线监看)——新文案承诺"push 后平台
自动重新监看"只有 01 落地后才为真;先发本文案会让 AI 理直气壮跳过
create_mr,死锁反而放大。

**Status:** done(2026-09-18,01 已同批落地)

- [x] 指引不再要求已建 MR 的修复场景重调 create_mr
- [x] 新文案与"push 后平台自动重挂监看"的实际行为一致(01 同批交付)
- [x] 相关提示词契约测试同步(现有测试钉的是不可修卡面文案,不冲突,
      确认不误伤;全套件回归绿)

横向同源一并拆(notices 另三处 + receipts 一处):gate.evidence.tail
(证据回灌后的修复)、mr_review(检视意见修复)、pipeline.green.
others_red(他仓红灯通知)、mrgate.red(申报打回处置)——五处统一为
"push_branch(已有 MR 自动跟新提交,平台按新提交重新监看)",create_mr
仅保留给"尚未建过 MR"的仓。
