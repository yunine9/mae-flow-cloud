# 问题流磁盘治理(2026-09-11 立项)

背景:8787 生产 239G/376G(81%),其中终态 issue 的 repo 残留 84G、活跃单
构建产物约占单体积 57%、分仓缓存 82G 逼近上限。排查结论与三层方案经
2026-09-11 对话拍板:

1. **终态 repo 回收**(canceled/archived 立即删 `repo/`;failed 不动——
   可恢复态,手动转取消是它的出口,用户拍板不设保留期)
2. **构建产物冷却清理**(状态 ∉ {running,queued,waiting_user} 且产物
   mtime 冷却 ≥48h,删 target/build/node_modules/depend;源码与 .git 保留)
3. **缓存运维**(max_gb 调低+保留期调短,管理页旋钮,不写代码)

返工处理拍板:**不走预热**——预热解决的是冷缓存(依赖下载+首次全量),
清理不碰分仓缓存,返工首编本来就是"全量但缓存热";要做的是返工回合
带一句平台通知防误诊(见票 03)。

UI 事实同步(#123 现状):问题工作台无"材料"页签,是六个一级标签
(对话现场/DTS单据/过程文档/工作区变更/拉取日志/逐仓交付);回收影响面
= **工作区变更**签,如实降级(票 02);docs/issue-flow.md 已同步。

## 票

- [01-terminal-repo-reclaim.md](issues/01-terminal-repo-reclaim.md) —
  终态 repo 回收清扫器(无阻塞,首跑收存量 84G)
- [02-changes-tab-degrade.md](issues/02-changes-tab-degrade.md) —
  工作区变更签如实降级(阻塞于 01)
- [03-build-products-cooldown.md](issues/03-build-products-cooldown.md) —
  构建产物 48h 冷却清理 + 返工通知(阻塞于 01,共用清扫器骨架)

预期:8787 立即回收 84G,活跃盘再省 ~23G,81% → ~35%(缓存调优后再降)。
